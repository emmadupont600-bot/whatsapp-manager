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

// ─── Blacklist ───────────────────────────────────────────────────────────────
const BLACKLIST_FILE = path.join(__dirname, 'data', 'blacklist.json');
function loadBlacklist() {
  if (!fs.existsSync(BLACKLIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8')); } catch(e) { return []; }
}
function saveBlacklist(list) {
  const dir = path.dirname(BLACKLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...new Set(list)], null, 2));
}
function isBlacklisted(phone) {
  const clean = phone.replace(/\D/g,'');
  return loadBlacklist().some(p => p.replace(/\D/g,'') === clean);
}

// ─── Config par défaut ────────────────────────────────────────────────────────
let config = {
  minDelay:       parseInt(process.env.MIN_DELAY_S       || '90'),
  maxDelay:       parseInt(process.env.MAX_DELAY_S       || '180'),
  sessionSize:    parseInt(process.env.SESSION_SIZE      || '15'),
  sessionPauseMin:parseInt(process.env.SESSION_PAUSE_MIN || '600'),
  sessionPauseMax:parseInt(process.env.SESSION_PAUSE_MAX || '1200'),
  typingMin:      parseInt(process.env.TYPING_MIN_MS     || '2000'),
  typingMax:      parseInt(process.env.TYPING_MAX_MS     || '6000'),
  linkDelayMin:   parseInt(process.env.LINK_DELAY_MIN_MS || '8000'),
  linkDelayMax:   parseInt(process.env.LINK_DELAY_MAX_MS || '15000'),
  dailyLimit:     { 1: parseInt(process.env.DAILY_LIMIT || '300'), 2: parseInt(process.env.DAILY_LIMIT || '300') },
  autoResume:     true
};
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try { const saved = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf-8')); Object.assign(config, saved); } catch(e) {}
}
function saveConfig() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const rand  = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ─── Personnalisation du message ──────────────────────────────────────────────
// Remplace {prénom}, {prenom}, {nom}, {name} par la valeur du contact
function personalizeMessage(template, contact) {
  if (!template) return template;
  return template
    .replace(/\{pr[eé]nom\}/gi,  contact.prenom || contact.nom || '')
    .replace(/\{nom\}/gi,        contact.nom    || contact.prenom || '')
    .replace(/\{name\}/gi,       contact.prenom || contact.nom || '')
    .replace(/\{phone\}/gi,      contact.phone  || '')
    .trim();
}

function removeLocks(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) removeLocks(full);
      else if (['SingletonLock','SingletonCookie','SingletonSocket'].includes(e.name)) fs.unlinkSync(full);
    }
  } catch(e) {}
}

// ─── BotAccount ─────────────────────────────────────────────────────────────
class BotAccount {
  constructor(id) {
    this.id         = id;
    this.authPath   = `/app/.wwebjs_auth/account${id}`;
    this.dataFile   = path.join(__dirname, 'data', `queue_${id}.json`);
    this.client     = null;
    this.retryCount = 0;
    this._resumeTimer = null;
    this.state = {
      qr: null, ready: false, running: false, paused: false,
      queue: [], sessionCount: 0,
      dailySent: 0, dailyDate: '',
      windowStart: null,
      limitReached: false,
      limitReachedAt: null,
      resumeAt: null,
      bannedAt: null,      // timestamp si ban détecté
      repliesReceived: 0,  // compteur de réponses reçues
      log: [], stats: { sent: 0, failed: 0, skipped: 0, blacklisted: 0 }
    };
    this._loadQueue();
    this._autoResume();
    this._initClient();
  }

  get dailyLimit() { return config.dailyLimit[this.id] || 300; }

  _loadQueue() {
    if (fs.existsSync(this.dataFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        this.state.queue          = data.queue          || [];
        this.state.stats          = { sent: 0, failed: 0, skipped: 0, blacklisted: 0, ...(data.stats || {}) };
        this.state.sessionCount   = data.sessionCount   || 0;
        this.state.dailySent      = data.dailySent      || 0;
        this.state.dailyDate      = data.dailyDate      || '';
        this.state.windowStart    = data.windowStart    || null;
        this.state.limitReached   = data.limitReached   || false;
        this.state.limitReachedAt = data.limitReachedAt || null;
        this.state.resumeAt       = data.resumeAt       || null;
        this.state.bannedAt       = data.bannedAt       || null;
        this.state.repliesReceived= data.repliesReceived|| 0;
        this._checkWindowReset();
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
      sessionCount: this.state.sessionCount,
      dailySent: this.state.dailySent, dailyDate: this.state.dailyDate,
      windowStart: this.state.windowStart,
      limitReached: this.state.limitReached,
      limitReachedAt: this.state.limitReachedAt,
      resumeAt: this.state.resumeAt,
      bannedAt: this.state.bannedAt,
      repliesReceived: this.state.repliesReceived,
      savedAt: new Date().toISOString()
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

  _checkWindowReset() {
    if (!this.state.windowStart) return;
    const elapsed = Date.now() - new Date(this.state.windowStart).getTime();
    if (elapsed >= 24 * 3600 * 1000) {
      this.state.dailySent      = 0;
      this.state.windowStart    = null;
      this.state.limitReached   = false;
      this.state.limitReachedAt = null;
      this.state.resumeAt       = null;
      this.state.bannedAt       = null;
      if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
      this.log('🔄 Quota réinitialisé (24h écoulées)', 'success');
      this._saveQueue();
      return true;
    }
    return false;
  }

  _windowResetIn() {
    if (!this.state.windowStart) return 0;
    const elapsed = Date.now() - new Date(this.state.windowStart).getTime();
    return Math.max(0, 24 * 3600 * 1000 - elapsed);
  }

  _scheduleAutoResume(relayBot) {
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    const ms = this._windowResetIn();
    if (ms <= 0) return;
    this.state.resumeAt = new Date(Date.now() + ms).toISOString();
    this._saveQueue();
    this.log(`⏰ Reprise automatique prévue dans ${Math.round(ms/3600000*10)/10}h`, 'warn');
    this._resumeTimer = setTimeout(() => {
      this._checkWindowReset();
      if (this.state.ready && !this.state.running && this.state.queue.some(c => c.status === 'pending')) {
        this.log('▶️ Reprise automatique après reset quota', 'success');
        this.runQueue(relayBot);
      }
    }, ms);
  }

  _recordFirstSend() {
    if (!this.state.windowStart) {
      this.state.windowStart = new Date().toISOString();
    }
  }

  _dailyLimitReached() {
    this._checkWindowReset();
    return this.state.dailySent >= this.dailyLimit;
  }

  // ── Détection ban / rate-limit WhatsApp ────────────────────────────────────
  _detectBan(errMessage) {
    const banPatterns = [
      /rate.?limit/i, /too many/i, /spam/i, /blocked/i,
      /account.*banned/i, /restrict/i, /ECONNRESET/i, /WAWebDisconnected/i
    ];
    return banPatterns.some(p => p.test(errMessage));
  }

  _handleBan(err) {
    this.state.running    = false;
    this.state.bannedAt   = new Date().toISOString();
    this.state.paused     = true;
    this.log(`🚫 BAN / RESTRICTION DÉTECTÉ : ${err.message} — Bot arrêté pour protection`, 'error');
    this._saveQueue();
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
      if (pending > 0 && !this.state.running && !this._dailyLimitReached()) {
        this.log(`▶️ Reprise automatique : ${pending} contacts restants`, 'warn');
        this.runQueue();
      }
    });
    // ── Détection des réponses entrantes ───────────────────────────────────
    c.on('message', async msg => {
      if (msg.fromMe) return;
      const phone = msg.from.replace('@c.us','').replace(/\D/g,'');
      const contact = this.state.queue.find(x => x.phone.replace(/\D/g,'') === phone);
      if (contact && contact.status === 'done') {
        contact.replied    = true;
        contact.repliedAt  = new Date().toISOString();
        contact.replyText  = msg.body ? msg.body.substring(0, 200) : '(media)';
        this.state.repliesReceived++;
        this.log(`💬 Réponse reçue de +${phone} : "${contact.replyText}"`, 'success');
        this._saveQueue();
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
    const ms = rand(config.minDelay, config.maxDelay) * 1000;
    this.log(`⏳ Pause : ${(ms/1000).toFixed(0)}s`, 'info');
    await sleep(ms);
  }
  async _delaySession() {
    const ms = rand(config.sessionPauseMin, config.sessionPauseMax) * 1000;
    this.log(`☕ Pause session : ${(ms/60000).toFixed(0)}min`, 'warn');
    await sleep(ms);
  }
  async _typing(chat) {
    try { await chat.sendStateTyping(); await sleep(rand(config.typingMin, config.typingMax)); await chat.clearState(); } catch(e) {}
  }

  async _sendMessage(chatId, rawMsg, link) {
    const chat = await this.client.getChatById(chatId);
    if (link && link.trim()) {
      await this._typing(chat);
      await this.client.sendMessage(chatId, rawMsg.trim());
      const delay = rand(config.linkDelayMin, config.linkDelayMax);
      this.log(`⏱ Délai avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
      await sleep(delay);
      await this.client.sendMessage(chatId, link.trim());
    } else {
      const parts = splitMessageAndLink(rawMsg);
      if (parts && parts.text) {
        await this._typing(chat);
        await this.client.sendMessage(chatId, parts.text);
        const delay = rand(config.linkDelayMin, config.linkDelayMax);
        await sleep(delay);
        await this.client.sendMessage(chatId, parts.url);
      } else {
        await this._typing(chat);
        await this.client.sendMessage(chatId, rawMsg);
      }
    }
  }

  // ── Queue principale ──────────────────────────────────────────────────────
  async runQueue(relayBot) {
    if (this.state.running) return;
    this.state.running = true;
    this.state.limitReached = false;
    this.log(`🚀 Bot démarré (session ≤${config.sessionSize} msgs, limite/jour : ${this.dailyLimit})`, 'success');

    while (this.state.queue.some(c => c.status === 'pending')) {
      if (!this.state.ready) { await sleep(10000); continue; }
      if (this.state.paused)  { await sleep(3000);  continue; }

      if (this._dailyLimitReached()) {
        this.state.running = false;
        this.state.limitReached = true;
        this.state.limitReachedAt = new Date().toISOString();
        const remaining = this.state.queue.filter(c => c.status === 'pending');
        const resetIn = this._windowResetIn();

        if (relayBot && relayBot.state.ready && remaining.length > 0) {
          this.log(`🔁 Limite ${this.dailyLimit} msgs atteinte → relais vers Compte ${relayBot.id} (${remaining.length} contacts)`, 'warn');
          for (const c of remaining) {
            const cleanPhone = c.phone.replace(/\D/g,'');
            // Anti-doublons inter-comptes : vérifier toutes les queue de l'autre bot
            const alreadyInRelay = relayBot.state.queue.some(
              x => x.phone.replace(/\D/g,'') === cleanPhone &&
                   ['pending','processing','done'].includes(x.status)
            );
            if (!alreadyInRelay) {
              relayBot.state.queue.push({ ...c, status: 'pending', relayedFrom: this.id, relayedAt: new Date().toISOString() });
            } else {
              this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`, 'warn');
            }
            c.status = 'relayed';
          }
          this._saveQueue(); relayBot._saveQueue();
          if (!relayBot.state.running) { this.log(`▶️ Démarrage automatique du Compte ${relayBot.id}`, 'success'); relayBot.runQueue(this); }
        } else {
          this.log(`⏸ Limite ${this.dailyLimit} atteinte. Quota reset dans ${Math.round(resetIn/3600000*10)/10}h`, 'warn');
          if (config.autoResume) this._scheduleAutoResume(relayBot);
        }
        this._saveQueue();
        break;
      }

      if (this.state.sessionCount > 0 && this.state.sessionCount % config.sessionSize === 0) {
        this.log(`📊 Session ${Math.floor(this.state.sessionCount/config.sessionSize)} terminée`, 'info');
        await this._delaySession();
      }

      const contact = this.state.queue.find(c => c.status === 'pending');
      if (!contact) break;
      contact.status = 'processing';
      this._saveQueue();

      try {
        const number = contact.phone.replace(/\D/g,'');
        const chatId  = `${number}@c.us`;

        // ── Vérification blacklist ───────────────────────────────────────
        if (isBlacklisted(number)) {
          contact.status = 'blacklisted'; this.state.stats.blacklisted++;
          this.log(`🚫 Blacklisté : +${number}`, 'warn');
          this._saveQueue(); await sleep(rand(1000, 3000)); continue;
        }

        const exists  = await this.client.isRegisteredUser(chatId);
        if (!exists) {
          contact.status = 'skipped'; this.state.stats.skipped++;
          this.log(`⏭️ Non inscrit : +${number}`, 'warn');
          this._saveQueue(); await sleep(rand(3000, 8000)); continue;
        }
        await sleep(rand(500, 2000));

        // ── Personnalisation du message ─────────────────────────────────
        const rawMsg = personalizeMessage(
          (contact.message || '').trim() || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋',
          contact
        );
        const link = (contact.link || '').trim();
        const personalizedLink = personalizeMessage(link, contact);

        this._recordFirstSend();
        await this._sendMessage(chatId, rawMsg, personalizedLink);
        contact.status = 'done';
        contact.sentAt = new Date().toISOString();
        this.state.stats.sent++;
        this.state.sessionCount++;
        this.state.dailySent++;
        this.log(`✅ Envoyé à +${number}${contact.prenom ? ' ('+contact.prenom+')' : ''}${link ? ' 🔗' : ''} [${this.state.dailySent}/${this.dailyLimit}]`, 'success');
        this._saveQueue();
        await this._delayMsg();
      } catch(err) {
        // ── Détection ban ───────────────────────────────────────────────
        if (this._detectBan(err.message)) {
          contact.status = 'pending'; // remet en attente pour ne pas perdre le contact
          this._handleBan(err);
          break;
        }
        contact.status = 'failed'; this.state.stats.failed++;
        this.log(`❌ Erreur ${contact.phone} : ${err.message}`, 'error');
        this._saveQueue(); await sleep(rand(30000, 60000));
      }
    }
    this.state.running = false;
    const stillPending = this.state.queue.some(c => c.status === 'pending');
    if (!stillPending && !this.state.bannedAt) this.log('🏁 Queue terminée', 'success');
    this._saveQueue();
  }

  importCSV(content, defaultMessage, defaultLink) {
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    let added = 0;
    let blacklisted = 0;
    for (const row of records) {
      const phone = (row.telephone || row.phone || row['Telephone'] || row['Phone'] || Object.values(row)[0] || '').replace(/\D/g,'');
      if (!phone || phone.length < 8) continue;
      // Lecture des colonnes prénom/nom (insensible à la casse)
      const prenom = row.prenom || row.prénom || row.firstname || row.first_name || row.Prenom || row['Prénom'] || '';
      const nom    = row.nom    || row.name   || row.lastname  || row.last_name  || row.Nom   || row['Nom']    || '';
      // Vérification blacklist à l'import
      if (isBlacklisted(phone)) { blacklisted++; continue; }
      if (this.state.queue.find(c => c.phone.replace(/\D/g,'') === phone)) continue;
      this.state.queue.push({
        phone, status: 'pending',
        prenom: prenom.trim(),
        nom:    nom.trim(),
        message: row.message || defaultMessage,
        link:    row.link    || defaultLink || '',
        addedAt: new Date().toISOString()
      });
      added++;
    }
    this._saveQueue();
    if (blacklisted > 0) this.log(`🚫 ${blacklisted} contacts ignorés (blacklist)`, 'warn');
    this.log(`📥 Import : ${added} contacts ajoutés`, 'success');
    return { added, blacklisted };
  }

  getStatus() {
    this._checkWindowReset();
    const resetInMs = this._windowResetIn();
    return {
      id: this.id, ready: this.state.ready, qr: this.state.qr,
      running: this.state.running, paused: this.state.paused,
      stats: this.state.stats,
      pending:     this.state.queue.filter(c => c.status === 'pending').length,
      relayed:     this.state.queue.filter(c => c.status === 'relayed').length,
      replied:     this.state.queue.filter(c => c.replied === true).length,
      blacklisted: this.state.queue.filter(c => c.status === 'blacklisted').length,
      total:       this.state.queue.length,
      sessionCount: this.state.sessionCount,
      dailySent: this.state.dailySent,
      dailyLimit: this.dailyLimit,
      limitReached: this.state.limitReached,
      limitReachedAt: this.state.limitReachedAt,
      resumeAt: this.state.resumeAt,
      windowStart: this.state.windowStart,
      resetInMs,
      autoResume: config.autoResume,
      bannedAt: this.state.bannedAt,
      repliesReceived: this.state.repliesReceived,
      minDelay: config.minDelay, maxDelay: config.maxDelay, sessionSize: config.sessionSize,
      log: this.state.log.slice(0, 50)
    };
  }

  reset() {
    this.state.queue.forEach(c => { if (c.status !== 'done') c.status = 'pending'; });
    this.state.stats = { sent: 0, failed: 0, skipped: 0, blacklisted: 0 };
    this.state.sessionCount = 0; this.state.dailySent = 0;
    this.state.windowStart = null; this.state.limitReached = false;
    this.state.limitReachedAt = null; this.state.resumeAt = null;
    this.state.bannedAt = null;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this._saveQueue(); this.log('🔄 Queue réinitialisée', 'warn');
  }

  clear() {
    this.state.queue = []; this.state.stats = { sent: 0, failed: 0, skipped: 0, blacklisted: 0 };
    this.state.sessionCount = 0; this.state.dailySent = 0;
    this.state.windowStart = null; this.state.limitReached = false;
    this.state.limitReachedAt = null; this.state.resumeAt = null;
    this.state.bannedAt = null;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this._saveQueue(); this.log('🗑️ Queue vidée', 'warn');
  }
}

// ─── Deux comptes ────────────────────────────────────────────────────────────
const bots = { 1: new BotAccount(1), 2: new BotAccount(2) };
function getBot(req) { const id = parseInt(req.params.account || req.query.account || '1'); return bots[id] || bots[1]; }
function otherBot(bot) { return bot.id === 1 ? bots[2] : bots[1]; }

// ─── Routes API ──────────────────────────────────────────────────────────────
app.get('/api/:account/status',  (req, res) => res.json(getBot(req).getStatus()));
app.post('/api/:account/start',  (req, res) => {
  const b = getBot(req);
  if (!b.state.ready) return res.status(400).json({ ok: false, error: 'Non connecté' });
  b.state.paused = false; b.state.limitReached = false; b.state.bannedAt = null;
  b.runQueue(otherBot(b));
  res.json({ ok: true });
});
app.post('/api/:account/pause',  (req, res) => { const b=getBot(req); b.state.paused=!b.state.paused; b.log(b.state.paused?'⏸️ Pause':'▶️ Reprise','warn'); res.json({ok:true,paused:b.state.paused}); });
app.post('/api/:account/clear',  (req, res) => { getBot(req).clear(); res.json({ok:true}); });
app.post('/api/:account/reset',  (req, res) => { getBot(req).reset(); res.json({ok:true}); });

app.post('/api/:account/set-limit', (req, res) => {
  const b = getBot(req);
  const limit = parseInt(req.body.limit);
  if (!limit || limit < 1 || limit > 1000) return res.status(400).json({ ok: false, error: 'Limite invalide (1-1000)' });
  config.dailyLimit[b.id] = limit;
  saveConfig();
  b.log(`⚙️ Limite modifiée → ${limit} msgs/24h`, 'warn');
  res.json({ ok: true, limit });
});

// ── Blacklist ────────────────────────────────────────────────────────────────
app.get('/api/blacklist', (req, res) => res.json({ list: loadBlacklist() }));
app.post('/api/blacklist/add', (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g,'');
  if (!phone || phone.length < 8) return res.status(400).json({ ok: false, error: 'Numéro invalide' });
  const list = loadBlacklist();
  if (!list.includes(phone)) { list.push(phone); saveBlacklist(list); }
  res.json({ ok: true, phone, total: list.length });
});
app.post('/api/blacklist/remove', (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g,'');
  const list = loadBlacklist().filter(p => p.replace(/\D/g,'') !== phone);
  saveBlacklist(list);
  res.json({ ok: true, total: list.length });
});
app.post('/api/blacklist/import', upload.single('file'), (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    const list = loadBlacklist();
    let added = 0;
    for (const row of records) {
      const phone = (row.telephone || row.phone || Object.values(row)[0] || '').replace(/\D/g,'');
      if (phone && phone.length >= 8 && !list.includes(phone)) { list.push(phone); added++; }
    }
    saveBlacklist(list);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, added, total: list.length });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Config globale ────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  const allowed = ['minDelay','maxDelay','sessionSize','autoResume'];
  for (const k of allowed) if (req.body[k] !== undefined) config[k] = req.body[k];
  saveConfig();
  res.json({ ok: true, config });
});

app.get('/api/:account/export', (req, res) => {
  const bot = getBot(req);
  const rows = bot.state.queue.map(c => ({
    telephone: c.phone, prenom: c.prenom||'', nom: c.nom||'',
    statut: c.status, replied: c.replied ? 'Oui' : 'Non',
    reply_text: c.replyText || '',
    message: c.message, link: c.link||'',
    ajoute_le: c.addedAt, envoye_le: c.sentAt||''
  }));
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
    const result = getBot(req).importCSV(content, message, link);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...result });
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
app.post('/api/start',  (req,res) => { bots[1].state.paused=false; bots[1].runQueue(bots[2]); res.json({ok:true}); });
app.post('/api/pause',  (req,res) => { bots[1].state.paused=!bots[1].state.paused; res.json({ok:true}); });
app.post('/api/clear',  (req,res) => { bots[1].clear(); res.json({ok:true}); });
app.get('/api/groups',  async (req,res) => { if(!bots[1].state.ready) return res.json([]); const c=await bots[1].client.getChats(); res.json(c.filter(x=>x.isGroup).map(x=>({name:x.name,count:x.participants?.length||0}))); });

app.listen(PORT, () => console.log(`WhatsApp Manager → http://localhost:${PORT}`));
