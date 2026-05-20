const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const express  = require('express');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const csv      = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: 'uploads/' });

// ─── Paramètres anti-détection ───────────────────────────────────────────────
const MIN_DELAY_S        = parseInt(process.env.MIN_DELAY_S        || '90');
const MAX_DELAY_S        = parseInt(process.env.MAX_DELAY_S        || '180');
const SESSION_SIZE       = parseInt(process.env.SESSION_SIZE       || '15');
const SESSION_PAUSE_MIN  = parseInt(process.env.SESSION_PAUSE_MIN  || '600');
const SESSION_PAUSE_MAX  = parseInt(process.env.SESSION_PAUSE_MAX  || '1200');
const TYPING_MIN_MS      = parseInt(process.env.TYPING_MIN_MS      || '2000');
const TYPING_MAX_MS      = parseInt(process.env.TYPING_MAX_MS      || '6000');
// Délai ALÉATOIRE entre le texte et le lien — réduit les patterns détectables
const LINK_DELAY_MIN_MS  = parseInt(process.env.LINK_DELAY_MIN_MS  || '8000');
const LINK_DELAY_MAX_MS  = parseInt(process.env.LINK_DELAY_MAX_MS  || '15000');

// ─── Utilitaires ─────────────────────────────────────────────────────────────
const rand  = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Détecte la première URL dans un texte
const URL_RE = /(https?:\/\/[^\s]+)/i;
function splitMessageAndLink(msg) {
  const match = msg.match(URL_RE);
  if (!match) return null;
  const url    = match[1];
  const before = msg.slice(0, match.index).trim();
  const after  = msg.slice(match.index + url.length).trim();
  const text   = [before, after].filter(Boolean).join('\n').trim();
  return { text, url };
}

function removeLocks(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) removeLocks(full);
      else if (['SingletonLock','SingletonCookie','SingletonSocket'].includes(e.name)) {
        fs.unlinkSync(full);
        console.log(`[INIT] Supprimé : ${full}`);
      }
    }
  } catch(e) { console.log('[INIT] removeLocks error:', e.message); }
}

// ─── Classe BotAccount ───────────────────────────────────────────────────────
class BotAccount {
  constructor(id) {
    this.id         = id;
    this.authPath   = `/app/.wwebjs_auth/account${id}`;
    this.dataFile   = path.join(__dirname, 'data', `queue_${id}.json`);
    this.client     = null;
    this.retryCount = 0;
    this.state = {
      qr: null, ready: false, running: false, paused: false,
      queue: [], sessionCount: 0,
      log: [], stats: { sent: 0, failed: 0, skipped: 0 }
    };
    this._loadQueue();
    this._autoResume();
    this._initClient();
  }

  _loadQueue() {
    if (fs.existsSync(this.dataFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        this.state.queue        = data.queue  || [];
        this.state.stats        = data.stats  || { sent: 0, failed: 0, skipped: 0 };
        this.state.sessionCount = data.sessionCount || 0;
        const pending = this.state.queue.filter(c => c.status === 'pending').length;
        if (pending) this.log(`💾 Queue restaurée : ${pending} contacts en attente`, 'warn');
      } catch(e) { this.log(`Erreur chargement queue : ${e.message}`, 'error'); }
    }
  }

  _saveQueue() {
    const dir = path.dirname(this.dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify({
      queue: this.state.queue, stats: this.state.stats,
      sessionCount: this.state.sessionCount, savedAt: new Date().toISOString()
    }, null, 2));
  }

  log(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    this.state.log.unshift(entry);
    if (this.state.log.length > 200) this.state.log = this.state.log.slice(0, 200);
    console.log(`[BOT${this.id}][${type.toUpperCase()}] ${msg}`);
  }

  _autoResume() {
    let fixed = 0;
    this.state.queue.forEach(c => { if (c.status === 'processing') { c.status = 'pending'; fixed++; } });
    if (fixed > 0) { this.log(`♻️ ${fixed} contacts remis en attente après crash`, 'warn'); this._saveQueue(); }
  }

  _makeClient() {
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        timeout: 120000, protocolTimeout: 120000,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-gpu','--no-first-run','--no-zygote','--single-process',
          '--disable-extensions','--disable-background-networking',
          '--disable-sync','--mute-audio','--no-default-browser-check',
          '--safebrowsing-disable-auto-update','--disable-features=TranslateUI','--memory-pressure-off']
      }
    });
  }

  _bindEvents(c) {
    c.on('qr', async qr => {
      this.retryCount = 0;
      this.state.qr = await qrcode.toDataURL(qr);
      this.state.ready = false;
      this.log('QR Code généré — scannez-le sur le dashboard', 'warn');
    });
    c.on('ready', () => {
      this.retryCount = 0;
      this.state.ready = true; this.state.qr = null;
      this.log('WhatsApp connecté ✅', 'success');
      const pending = this.state.queue.filter(c => c.status === 'pending').length;
      if (pending > 0 && !this.state.running) {
        this.log(`▶️ Reprise automatique : ${pending} contacts restants`, 'warn');
        this.runQueue();
      }
    });
    c.on('disconnected', reason => {
      this.state.ready = false; this.state.running = false;
      this.log(`WhatsApp déconnecté : ${reason}`, 'error');
      this._scheduleRetry(reason === 'LOGOUT' ? 30000 : 8000);
    });
    c.on('auth_failure', msg => this.log(`Erreur auth : ${msg}`, 'error'));
  }

  _scheduleRetry(delay) {
    const MAX = 10;
    if (this.retryCount >= MAX) { this.log(`❌ Trop de tentatives, arrêt.`, 'error'); return; }
    this.retryCount++;
    const wait = delay || Math.min(10000 * this.retryCount, 60000);
    this.log(`🔄 Tentative ${this.retryCount}/${MAX} dans ${wait/1000}s`, 'warn');
    setTimeout(() => {
      removeLocks(this.authPath);
      this.client = this._makeClient();
      this._bindEvents(this.client);
      this.client.initialize().catch(err => { this.log(`Retry ${this.retryCount} échoué : ${err.message}`, 'error'); this._scheduleRetry(); });
    }, wait);
  }

  _initClient() {
    removeLocks(this.authPath);
    this.client = this._makeClient();
    this._bindEvents(this.client);
    this.client.initialize().catch(err => { this.log(`Erreur initialisation : ${err.message}`, 'error'); this._scheduleRetry(15000); });
  }

  async _delayMsg() {
    const ms = rand(MIN_DELAY_S, MAX_DELAY_S) * 1000;
    this.log(`⏳ Pause : ${(ms/1000).toFixed(0)}s`, 'info');
    await sleep(ms);
  }
  async _delaySession() {
    const ms = rand(SESSION_PAUSE_MIN, SESSION_PAUSE_MAX) * 1000;
    this.log(`☕ Pause session : ${(ms/60000).toFixed(0)}min`, 'warn');
    await sleep(ms);
  }
  async _typing(chat) {
    try { await chat.sendStateTyping(); await sleep(rand(TYPING_MIN_MS, TYPING_MAX_MS)); await chat.clearState(); } catch(e) {}
  }

  // ── Envoi intelligent : texte d'abord, lien séparé avec délai aléatoire ──
  // Le lien peut venir de :
  //   1. contact.link (champ dédié du CSV) — prioritaire
  //   2. Une URL détectée dans le corps du message
  // Dans les deux cas : texte envoyé → délai 8-15s aléatoire → lien seul
  // Résultat : WhatsApp génère un aperçu cliquable même pour les non-contacts
  async _sendMessage(chatId, rawMsg, link) {
    const chat = await this.client.getChatById(chatId);

    if (link && link.trim()) {
      // Cas 1 : lien dans champ séparé
      await this._typing(chat);
      await this.client.sendMessage(chatId, rawMsg.trim());
      const delay = rand(LINK_DELAY_MIN_MS, LINK_DELAY_MAX_MS);
      this.log(`⏱ Délai avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
      await sleep(delay);
      await this.client.sendMessage(chatId, link.trim());
    } else {
      const parts = splitMessageAndLink(rawMsg);
      if (parts && parts.text) {
        // Cas 2 : URL dans le message — on sépare
        await this._typing(chat);
        await this.client.sendMessage(chatId, parts.text);
        const delay = rand(LINK_DELAY_MIN_MS, LINK_DELAY_MAX_MS);
        this.log(`⏱ Délai avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
        await sleep(delay);
        await this.client.sendMessage(chatId, parts.url);
      } else {
        // Cas 3 : pas de lien, envoi normal
        await this._typing(chat);
        await this.client.sendMessage(chatId, rawMsg);
      }
    }
  }

  async runQueue() {
    if (this.state.running) return;
    this.state.running = true;
    this.log(`🚀 Bot démarré (session ≤${SESSION_SIZE} msgs)`, 'success');

    while (this.state.queue.some(c => c.status === 'pending')) {
      if (!this.state.ready) { await sleep(10000); continue; }
      if (this.state.paused)  { await sleep(3000);  continue; }

      if (this.state.sessionCount > 0 && this.state.sessionCount % SESSION_SIZE === 0) {
        this.log(`📊 Session ${Math.floor(this.state.sessionCount/SESSION_SIZE)} terminée`, 'info');
        await this._delaySession();
      }

      const contact = this.state.queue.find(c => c.status === 'pending');
      if (!contact) break;
      contact.status = 'processing';
      this._saveQueue();

      try {
        const number = contact.phone.replace(/\D/g,'');
        const chatId  = `${number}@c.us`;
        const exists  = await this.client.isRegisteredUser(chatId);
        if (!exists) {
          contact.status = 'skipped'; this.state.stats.skipped++;
          this.log(`⏭️ Non inscrit : +${number}`, 'warn');
          this._saveQueue(); await sleep(rand(3000, 8000)); continue;
        }
        await sleep(rand(500, 2000));
        const msg  = (contact.message || '').trim() || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋';
        const link = (contact.link    || '').trim();
        await this._sendMessage(chatId, msg, link);
        contact.status = 'done'; this.state.stats.sent++; this.state.sessionCount++;
        this.log(`✅ Envoyé à +${number}${link ? ' 🔗' : ''}`, 'success');
        this._saveQueue();
        await this._delayMsg();
      } catch(err) {
        contact.status = 'failed'; this.state.stats.failed++;
        this.log(`❌ Erreur ${contact.phone} : ${err.message}`, 'error');
        this._saveQueue(); await sleep(rand(30000, 60000));
      }
    }
    this.state.running = false;
    this.log('🏁 Queue terminée', 'success');
    this._saveQueue();
  }

  // Import CSV — colonnes : telephone, message (opt.), link (opt.)
  importCSV(content, defaultMessage, defaultLink) {
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    let added = 0;
    for (const row of records) {
      const phone = (row.telephone || row.phone || row['Telephone'] || Object.values(row)[0] || '').replace(/\D/g,'');
      if (!phone || phone.length < 8) continue;
      if (this.state.queue.find(c => c.phone === phone)) continue;
      this.state.queue.push({
        phone,
        status:  'pending',
        message: row.message || defaultMessage,
        link:    row.link    || defaultLink || '',
        addedAt: new Date().toISOString()
      });
      added++;
    }
    this._saveQueue();
    this.log(`📥 Import : ${added} contacts ajoutés`, 'success');
    return added;
  }

  getStatus() {
    return {
      id: this.id, ready: this.state.ready, qr: this.state.qr,
      running: this.state.running, paused: this.state.paused,
      stats: this.state.stats,
      pending: this.state.queue.filter(c => c.status === 'pending').length,
      total: this.state.queue.length,
      sessionCount: this.state.sessionCount,
      minDelay: MIN_DELAY_S, maxDelay: MAX_DELAY_S, sessionSize: SESSION_SIZE,
      linkDelayMin: LINK_DELAY_MIN_MS, linkDelayMax: LINK_DELAY_MAX_MS,
      log: this.state.log.slice(0, 50)
    };
  }

  reset() {
    this.state.queue.forEach(c => { if (c.status !== 'done') c.status = 'pending'; });
    this.state.stats = { sent: 0, failed: 0, skipped: 0 }; this.state.sessionCount = 0;
    this._saveQueue(); this.log('🔄 Queue réinitialisée', 'warn');
  }

  clear() {
    this.state.queue = []; this.state.stats = { sent: 0, failed: 0, skipped: 0 }; this.state.sessionCount = 0;
    this._saveQueue(); this.log('🗑️ Queue vidée', 'warn');
  }
}

// ─── Deux comptes ─────────────────────────────────────────────────────────────
const bots = { 1: new BotAccount(1), 2: new BotAccount(2) };
function getBot(req) { const id = parseInt(req.params.account || req.query.account || '1'); return bots[id] || bots[1]; }

// ─── Routes API ───────────────────────────────────────────────────────────────
app.get('/api/:account/status',  (req, res) => res.json(getBot(req).getStatus()));
app.post('/api/:account/start',  (req, res) => { const b=getBot(req); if(!b.state.ready) return res.status(400).json({ok:false,error:'Non connecté'}); b.state.paused=false; b.runQueue(); res.json({ok:true}); });
app.post('/api/:account/pause',  (req, res) => { const b=getBot(req); b.state.paused=!b.state.paused; b.log(b.state.paused?'⏸️ Pause':'▶️ Reprise','warn'); res.json({ok:true,paused:b.state.paused}); });
app.post('/api/:account/clear',  (req, res) => { getBot(req).clear(); res.json({ok:true}); });
app.post('/api/:account/reset',  (req, res) => { getBot(req).reset(); res.json({ok:true}); });

app.get('/api/:account/export', (req, res) => {
  const bot = getBot(req);
  const rows = bot.state.queue.map(c => ({ telephone: c.phone, statut: c.status, message: c.message, link: c.link||'', ajoute_le: c.addedAt }));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="export_bot${bot.id}.csv"`);
  res.send(stringify(rows, { header: true }));
});

app.post('/api/:account/import', upload.single('file'), (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const message = (req.body.message || '').trim();
    const link    = (req.body.link    || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message vide' });
    const added = getBot(req).importCSV(content, message, link);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, added });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/:account/groups', async (req, res) => {
  const bot = getBot(req);
  if (!bot.state.ready) return res.json([]);
  const chats = await bot.client.getChats();
  res.json(chats.filter(c => c.isGroup).map(c => ({ name: c.name, count: c.participants?.length||0 })));
});

app.get('/api/:account/export-group/:name', async (req, res) => {
  const bot = getBot(req);
  if (!bot.state.ready) return res.status(400).json({ ok: false, error: 'Non connecté' });
  const chats = await bot.client.getChats();
  const group = chats.find(c => c.isGroup && c.name === req.params.name);
  if (!group) return res.status(404).json({ ok: false, error: 'Groupe introuvable' });
  const rows = group.participants.map(p => ({ telephone: `+${p.id.user}`, admin: p.isAdmin?'Oui':'Non' }));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${group.name}.csv"`);
  res.send(stringify(rows, { header: true }));
});

// Compat bot 1
app.get('/api/status',  (req,res) => res.json(bots[1].getStatus()));
app.post('/api/start',  (req,res) => { bots[1].state.paused=false; bots[1].runQueue(); res.json({ok:true}); });
app.post('/api/pause',  (req,res) => { bots[1].state.paused=!bots[1].state.paused; res.json({ok:true}); });
app.post('/api/clear',  (req,res) => { bots[1].clear(); res.json({ok:true}); });
app.get('/api/groups',  async (req,res) => { if(!bots[1].state.ready) return res.json([]); const c=await bots[1].client.getChats(); res.json(c.filter(x=>x.isGroup).map(x=>({name:x.name,count:x.participants?.length||0}))); });

app.listen(PORT, () => console.log(`WhatsApp Manager → http://localhost:${PORT}`));
