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

// FIX #9 : nettoyage automatique du dossier uploads/.
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const MAX_AGE_MS   = 60 * 60 * 1000; // 1 heure

function cleanUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const file = path.join(UPLOADS_DIR, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (now - mtimeMs > MAX_AGE_MS) { fs.unlinkSync(file); removed++; }
      } catch (_) {}
    }
    if (removed > 0) console.log(`[UPLOADS] 🧹 ${removed} fichier(s) temporaire(s) supprimé(s)`);
  } catch (_) {}
}

cleanUploadsDir();
setInterval(cleanUploadsDir, MAX_AGE_MS);

// ─── FIX #8 : Middleware d'authentification par token Bearer ─────────────────
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Non autorisé. Token Bearer requis.' });
  }
  next();
}
app.use('/api', authMiddleware);

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
function isBlacklisted(phone, cachedList) {
  const clean = phone.replace(/\D/g,'');
  const list = cachedList || loadBlacklist();
  return list.some(p => p.replace(/\D/g,'') === clean);
}

// ─── FIX #3 : sent-history en cache mémoire + flush debounce ─────────────────
// Avant : addToSentHistory() faisait loadSentHistory() + saveSentHistory() à
// chaque envoi → 2 opérations disque synchrones par message (lecture + écriture
// du fichier entier). Sur 300 msgs/jour = 600 I/O inutiles, ralentissement et
// risque de corruption en cas d'accès concurrent.
//
// Correction : le fichier est chargé UNE SEULE FOIS en mémoire au démarrage
// (_sentHistoryCache). Toutes les lectures/écritures opèrent sur ce cache.
// La persistance sur disque est différée (debounce 3s) pour regrouper les
// écritures consécutives en une seule opération I/O.
const SENT_HISTORY_FILE = path.join(__dirname, 'data', 'sent-history.json');
const SENT_HISTORY_FLUSH_MS = 3000;
let _sentHistoryCache = null;
let _sentHistoryFlushTimer = null;

function _loadSentHistoryFromDisk() {
  if (!fs.existsSync(SENT_HISTORY_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SENT_HISTORY_FILE, 'utf-8')); } catch(e) { return {}; }
}
function _getSentHistoryCache() {
  if (_sentHistoryCache === null) _sentHistoryCache = _loadSentHistoryFromDisk();
  return _sentHistoryCache;
}
function _flushSentHistory() {
  if (_sentHistoryFlushTimer) return;
  _sentHistoryFlushTimer = setTimeout(() => {
    _sentHistoryFlushTimer = null;
    if (_sentHistoryCache === null) return;
    const dir = path.dirname(SENT_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(SENT_HISTORY_FILE, JSON.stringify(_sentHistoryCache, null, 2));
    } catch(e) {
      console.error('[SENT-HISTORY] Erreur écriture :', e.message);
    }
  }, SENT_HISTORY_FLUSH_MS);
}

// API publique (mêmes signatures qu'avant pour ne rien casser)
function loadSentHistory() {
  return _getSentHistoryCache();
}
function saveSentHistory(hist) {
  _sentHistoryCache = hist;
  _flushSentHistory();
}
function addToSentHistory(phone, data) {
  const hist  = _getSentHistoryCache();
  const clean = phone.replace(/\D/g,'');
  if (!hist[clean]) {
    hist[clean] = {
      sentAt:  data.sentAt || new Date().toISOString(),
      botId:   data.botId,
      message: (data.message||'').substring(0,200),
      prenom:  data.prenom||'',
      nom:     data.nom||''
    };
    _flushSentHistory(); // écriture différée, pas immédiate
  }
}
function isAlreadySent(phone, cachedHist) {
  const clean = phone.replace(/\D/g,'');
  const hist  = cachedHist || _getSentHistoryCache();
  return hist[clean] || null;
}
function removeFromSentHistory(phone) {
  const hist  = _getSentHistoryCache();
  const clean = phone.replace(/\D/g,'');
  delete hist[clean];
  _flushSentHistory();
}

// ─── Planning (scheduled start) ─────────────────────────────────────────────
const schedules = {};
function cancelSchedule(accountId) {
  if (schedules[accountId]) { clearTimeout(schedules[accountId].timerId); delete schedules[accountId]; }
}

function parseScheduledAt(scheduledAt) {
  if (!scheduledAt || typeof scheduledAt !== 'string') {
    return { ok: false, error: 'scheduledAt doit être une chaîne de caractères' };
  }
  const ts = Date.parse(scheduledAt);
  if (isNaN(ts)) {
    return { ok: false, error: `Date invalide : "${scheduledAt}". Format attendu : ISO 8601 (ex: 2026-05-22T14:00:00.000Z)` };
  }
  const ms = ts - Date.now();
  if (ms < 30_000) {
    return { ok: false, error: `La date planifiée doit être dans au moins 30 secondes (reçu : ${new Date(ts).toISOString()})` };
  }
  return { ok: true, ts, ms };
}

function setSchedule(bot, scheduledAt, relayBot) {
  cancelSchedule(bot.id);
  const parsed = parseScheduledAt(scheduledAt);
  if (!parsed.ok) return parsed;
  const { ts, ms } = parsed;
  const timerId = setTimeout(() => {
    delete schedules[bot.id];
    if (!bot.state.ready) { bot.log('⏰ Planning : non connecté au moment du démarrage', 'error'); return; }
    bot.state.paused = false; bot.state.limitReached = false; bot.state.bannedAt = null;
    bot.log('⏰ Démarrage planifié déclenché', 'success');
    bot.runQueue(relayBot);
  }, ms);
  schedules[bot.id] = { scheduledAt: new Date(ts).toISOString(), timerId };
  bot.log(`📅 Démarrage planifié pour ${new Date(ts).toLocaleString('fr-FR')}`, 'warn');
  return { ok: true, scheduledAt: new Date(ts).toISOString() };
}

// ─── Historique de sessions (stats globales) ─────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); } catch(e) { return []; }
}
function saveSessions(sessions) {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions.slice(-500), null, 2));
}
function recordSessionEnd(botId, stats) {
  const sessions = loadSessions();
  sessions.push({ botId, date: new Date().toISOString(), ...stats });
  saveSessions(sessions);
}

// ─── FIX #11 : persistance des logs sur disque ───────────────────────────────
const MAX_LOG_ENTRIES = 1000;
const LOG_FLUSH_DEBOUNCE_MS = 2000;

function logFilePath(id) {
  return path.join(__dirname, 'data', `logs_${id}.json`);
}
function loadLogs(id) {
  const file = logFilePath(id);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) { return []; }
}
function saveLogs(id, entries) {
  const file = logFilePath(id);
  const dir  = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES), null, 2));
  } catch(e) {
    console.error(`[BOT${id}] Erreur écriture logs : ${e.message}`);
  }
}

// ─── FIX #10 : dailyLimit dynamique via Proxy ────────────────────────────────
const DEFAULT_DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '300');
const _dailyLimitOverrides = {};
const dailyLimitMap = new Proxy(_dailyLimitOverrides, {
  get(target, id) {
    const numId = typeof id === 'symbol' ? id : Number(id);
    return target[numId] !== undefined ? target[numId] : DEFAULT_DAILY_LIMIT;
  },
  set(target, id, value) { target[Number(id)] = value; return true; }
});

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
  dailyLimit:     {},
  autoResume:     true
};
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf-8'));
    Object.assign(config, saved);
    if (saved.dailyLimit && typeof saved.dailyLimit === 'object') {
      for (const [id, val] of Object.entries(saved.dailyLimit)) {
        dailyLimitMap[id] = parseInt(val);
      }
    }
  } catch(e) {}
}
function saveConfig() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  config.dailyLimit = { ..._dailyLimitOverrides };
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

// ─── BotAccount ──────────────────────────────────────────────────────────────
class BotAccount {
  constructor(id) {
    this.id         = id;
    this.authPath   = `/app/.wwebjs_auth/account${id}`;
    this.dataFile   = path.join(__dirname, 'data', `queue_${id}.json`);
    this.client     = null;
    this.retryCount = 0;
    this._resumeTimer   = null;
    this._logFlushTimer = null;
    this.state = {
      qr: null, ready: false, running: false, paused: false,
      queue: [], sessionCount: 0,
      dailySent: 0, dailyDate: '',
      windowStart: null,
      limitReached: false,
      limitReachedAt: null,
      resumeAt: null,
      bannedAt: null,
      repliesReceived: 0,
      log: loadLogs(id),
      stats: { sent: 0, failed: 0, skipped: 0, blacklisted: 0 }
    };
    this._loadQueue();
    this._autoResume();
    this._initClient();
  }

  get dailyLimit() { return dailyLimitMap[this.id]; }

  _flushLogs() {
    if (this._logFlushTimer) return;
    this._logFlushTimer = setTimeout(() => {
      this._logFlushTimer = null;
      saveLogs(this.id, this.state.log);
    }, LOG_FLUSH_DEBOUNCE_MS);
  }

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
    if (this.state.log.length > MAX_LOG_ENTRIES) {
      this.state.log = this.state.log.slice(0, MAX_LOG_ENTRIES);
    }
    console.log(`[BOT${this.id}][${type.toUpperCase()}] ${msg}`);
    this._flushLogs();
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
      this.state.dailySent = 0; this.state.windowStart = null;
      this.state.limitReached = false; this.state.limitReachedAt = null;
      this.state.resumeAt = null; this.state.bannedAt = null;
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
    if (!this.state.windowStart) this.state.windowStart = new Date().toISOString();
  }

  _dailyLimitReached() {
    this._checkWindowReset();
    return this.state.dailySent >= this.dailyLimit;
  }

  _detectBan(errMessage) {
    const banPatterns = [/rate.?limit/i, /too many/i, /spam/i, /blocked/i, /account.*banned/i, /restrict/i, /ECONNRESET/i, /WAWebDisconnected/i];
    return banPatterns.some(p => p.test(errMessage));
  }

  _handleBan(err) {
    this.state.running = false; this.state.bannedAt = new Date().toISOString(); this.state.paused = true;
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
      this.retryCount = 0; this.state.qr = await qrcode.toDataURL(qr); this.state.ready = false;
      this.log('QR Code généré — scannez-le sur le dashboard', 'warn');
    });
    c.on('ready', () => {
      this.retryCount = 0; this.state.ready = true; this.state.qr = null;
      this.log('WhatsApp connecté ✅', 'success');
      const pending = this.state.queue.filter(c => c.status === 'pending').length;
      if (pending > 0 && !this.state.running && !this._dailyLimitReached()) {
        this.log(`▶️ Reprise automatique : ${pending} contacts restants`, 'warn');
        this.runQueue();
      }
    });
    c.on('message', async msg => {
      if (msg.fromMe) return;
      const phone = msg.from.replace('@c.us','').replace(/\D/g,'');
      const contact = this.state.queue.find(x => x.phone.replace(/\D/g,'') === phone);
      if (contact && contact.status === 'done') {
        contact.replied = true; contact.repliedAt = new Date().toISOString();
        contact.replyText = msg.body ? msg.body.substring(0, 200) : '(media)';
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
    if (this.retryCount >= MAX) { this.log('❌ Trop de tentatives, arrêt.', 'error'); return; }
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

  async _delayMsg() { const ms=rand(config.minDelay,config.maxDelay)*1000; this.log(`⏳ Pause : ${(ms/1000).toFixed(0)}s`,'info'); await sleep(ms); }
  async _delaySession() { const ms=rand(config.sessionPauseMin,config.sessionPauseMax)*1000; this.log(`☕ Pause session : ${(ms/60000).toFixed(0)}min`,'warn'); await sleep(ms); }
  async _typing(chat) { try { await chat.sendStateTyping(); await sleep(rand(config.typingMin,config.typingMax)); await chat.clearState(); } catch(e) {} }

  async _sendMessage(chatId, rawMsg, link) {
    const chat = await this.client.getChatById(chatId);

    const assertSent = (msg, label) => {
      if (!msg || !msg.id || !msg.id._serialized) {
        throw new Error(`sendMessage() n'a pas retourné d'accusé de réception WhatsApp (${label}). Session peut-être expirée.`);
      }
      return msg.id._serialized;
    };

    if (link && link.trim()) {
      await this._typing(chat);
      const sentText = await this.client.sendMessage(chatId, rawMsg.trim());
      assertSent(sentText, 'texte');
      const delay = rand(config.linkDelayMin, config.linkDelayMax);
      this.log(`⏱ Délai avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
      await sleep(delay);
      const sentLink = await this.client.sendMessage(chatId, link.trim());
      return assertSent(sentLink, 'lien');
    }

    const parts = splitMessageAndLink(rawMsg);
    if (parts) {
      if (parts.text) {
        await this._typing(chat);
        const sentText = await this.client.sendMessage(chatId, parts.text);
        assertSent(sentText, 'texte');
        const delay = rand(config.linkDelayMin, config.linkDelayMax);
        await sleep(delay);
        const sentLink = await this.client.sendMessage(chatId, parts.url);
        return assertSent(sentLink, 'lien');
      } else {
        await this._typing(chat);
        const sentLink = await this.client.sendMessage(chatId, parts.url);
        return assertSent(sentLink, 'url-seule');
      }
    }

    await this._typing(chat);
    const sent = await this.client.sendMessage(chatId, rawMsg);
    return assertSent(sent, 'texte-simple');
  }

  async sendTest(phone, message, link) {
    if (!this.state.ready) throw new Error('WhatsApp non connecté');
    const number=phone.replace(/\D/g,''), chatId=`${number}@c.us`;
    const exists=await this.client.isRegisteredUser(chatId);
    if (!exists) throw new Error(`+${number} n'est pas sur WhatsApp`);
    const fakeContact={phone:number,prenom:'Test',nom:'Test'};
    const rawMsg=personalizeMessage(message||'Message de test 👋',fakeContact);
    const rawLink=personalizeMessage(link||'',fakeContact);
    const msgId = await this._sendMessage(chatId,rawMsg,rawLink);
    this.log(`🧪 Message de test envoyé à +${number} [id: ${msgId}]`,'success');
  }

  async runQueue(relayBot) {
    if (this.state.running) return;
    this.state.running = true;

    this.state.limitReached = false;
    const startStats={...this.state.stats}, startTime=Date.now();
    this.log(`🚀 Bot démarré (session ≤${config.sessionSize} msgs, limite/jour : ${this.dailyLimit})`,'success');

    while (this.state.queue.some(c => c.status === 'pending')) {
      if (!this.state.ready) { await sleep(10000); continue; }
      if (this.state.paused)  { await sleep(3000);  continue; }

      if (this._dailyLimitReached()) {
        this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
        const remaining=this.state.queue.filter(c=>c.status==='pending');
        const resetIn=this._windowResetIn();
        if (relayBot&&relayBot.state.ready&&remaining.length>0) {
          this.log(`🔁 Limite ${this.dailyLimit} msgs atteinte → relais vers Compte ${relayBot.id} (${remaining.length} contacts)`,'warn');
          for (const c of remaining) {
            const cleanPhone=c.phone.replace(/\D/g,'');
            const alreadyInRelay=relayBot.state.queue.some(x=>x.phone.replace(/\D/g,'')=== cleanPhone&&['pending','processing','done'].includes(x.status));
            if (!alreadyInRelay) relayBot.state.queue.push({...c,status:'pending',relayedFrom:this.id,relayedAt:new Date().toISOString()});
            else this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`,'warn');
            c.status='relayed';
          }
          this._saveQueue(); relayBot._saveQueue();
          if (!relayBot.state.running) relayBot.runQueue(this);
        } else {
          this.log(`⏸ Limite ${this.dailyLimit} atteinte. Quota reset dans ${Math.round(resetIn/3600000*10)/10}h`,'warn');
          if (config.autoResume) this._scheduleAutoResume(relayBot);
        }
        this._saveQueue(); break;
      }

      if (this.state.sessionCount>0&&this.state.sessionCount%config.sessionSize===0) {
        this.log(`📊 Session ${Math.floor(this.state.sessionCount/config.sessionSize)} terminée`,'info');
        await this._delaySession();
      }

      const contact=this.state.queue.find(c=>c.status==='pending');
      if (!contact) break;
      contact.status='processing'; this._saveQueue();

      try {
        const number=contact.phone.replace(/\D/g,''), chatId=`${number}@c.us`;

        if (isBlacklisted(number)) {
          contact.status='blacklisted'; this.state.stats.blacklisted++;
          this.log(`🚫 Blacklisté : +${number}`,'warn');
          this._saveQueue(); await sleep(rand(1000,3000)); continue;
        }

        const exists=await this.client.isRegisteredUser(chatId);
        if (!exists) {
          contact.status='skipped'; this.state.stats.skipped++;
          this.log(`⏭️ Non inscrit : +${number}`,'warn');
          this._saveQueue(); await sleep(rand(3000,8000)); continue;
        }
        await sleep(rand(500,2000));

        const rawMsg=personalizeMessage((contact.message||'').trim()||process.env.DEFAULT_MESSAGE||'Bonjour ! 👋',contact);
        const link=(contact.link||'').trim();
        const personalizedLink=personalizeMessage(link,contact);

        this._recordFirstSend();
        const msgId = await this._sendMessage(chatId,rawMsg,personalizedLink);
        contact.status='done'; contact.sentAt=new Date().toISOString();
        contact.waMessageId = msgId;
        this.state.stats.sent++; this.state.sessionCount++; this.state.dailySent++;
        this.log(`✅ Envoyé à +${number}${contact.prenom?' ('+contact.prenom+')':''}${link?' 🔗':''} [${this.state.dailySent}/${this.dailyLimit}] id:${msgId}`,'success');

        addToSentHistory(number, { sentAt: contact.sentAt, botId: this.id, message: rawMsg, prenom: contact.prenom, nom: contact.nom });

        this._saveQueue();
        await this._delayMsg();
      } catch(err) {
        if (this._detectBan(err.message)) { contact.status='pending'; this._handleBan(err); break; }
        contact.status='failed'; this.state.stats.failed++;
        this.log(`❌ Erreur ${contact.phone} : ${err.message}`,'error');
        this._saveQueue(); await sleep(rand(30000,60000));
      }
    }

    this.state.running=false;
    const stillPending=this.state.queue.some(c=>c.status==='pending');
    if (!stillPending&&!this.state.bannedAt) this.log('🏁 Queue terminée','success');

    const sentThisRun=this.state.stats.sent-(startStats.sent||0);
    const skipThisRun=this.state.stats.skipped-(startStats.skipped||0);
    const failThisRun=this.state.stats.failed-(startStats.failed||0);
    if (sentThisRun+skipThisRun+failThisRun>0) {
      recordSessionEnd(this.id,{sent:sentThisRun,skipped:skipThisRun,failed:failThisRun,duration:Math.round((Date.now()-startTime)/1000)});
    }
    this._saveQueue();
  }

  importCSV(content, defaultMessage, defaultLink, forceIncludeDuplicates = []) {
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    const blacklistCache    = loadBlacklist();
    const sentHistoryCache  = loadSentHistory();

    let added=0, blacklisted=0, skippedQueue=0;
    const duplicates=[];
    for (const row of records) {
      const phone=(row.telephone||row.phone||row['Telephone']||row['Phone']||Object.values(row)[0]||'').replace(/\D/g,'');
      if (!phone||phone.length<8) continue;
      const prenom=row.prenom||row.prénom||row.firstname||row.first_name||row.Prenom||row['Prénom']||'';
      const nom=row.nom||row.name||row.lastname||row.last_name||row.Nom||row['Nom']||'';

      if (isBlacklisted(phone, blacklistCache)) { blacklisted++; continue; }
      if (this.state.queue.find(c=>c.phone.replace(/\D/g,'')=== phone)) { skippedQueue++; continue; }

      const histEntry=isAlreadySent(phone, sentHistoryCache);
      if (histEntry && !forceIncludeDuplicates.includes(phone)) {
        duplicates.push({ phone, prenom: prenom.trim(), nom: nom.trim(), sentAt: histEntry.sentAt, botId: histEntry.botId, message: histEntry.message });
        continue;
      }

      this.state.queue.push({
        phone, status:'pending',
        prenom:prenom.trim(), nom:nom.trim(),
        message:row.message||defaultMessage,
        link:row.link||defaultLink||'',
        addedAt:new Date().toISOString()
      });
      added++;
    }
    this._saveQueue();
    if (blacklisted>0) this.log(`🚫 ${blacklisted} contacts ignorés (blacklist)`,'warn');
    this.log(`📥 Import : ${added} contacts ajoutés${duplicates.length?' · '+duplicates.length+' doublons détectés':''}`, 'success');
    return { added, blacklisted, skippedQueue, duplicates };
  }

  removeContact(phone) {
    const clean=phone.replace(/\D/g,'');
    const before=this.state.queue.length;
    this.state.queue=this.state.queue.filter(c=>c.phone.replace(/\D/g,'')!==clean);
    this._saveQueue();
    return before-this.state.queue.length;
  }

  getStatus() {
    this._checkWindowReset();
    const resetInMs=this._windowResetIn();
    return {
      id:this.id, ready:this.state.ready, qr:this.state.qr,
      running:this.state.running, paused:this.state.paused,
      stats:this.state.stats,
      pending:    this.state.queue.filter(c=>c.status==='pending').length,
      relayed:    this.state.queue.filter(c=>c.status==='relayed').length,
      replied:    this.state.queue.filter(c=>c.replied===true).length,
      blacklisted:this.state.queue.filter(c=>c.status==='blacklisted').length,
      total:      this.state.queue.length,
      sessionCount:this.state.sessionCount,
      dailySent:this.state.dailySent, dailyLimit:this.dailyLimit,
      limitReached:this.state.limitReached, limitReachedAt:this.state.limitReachedAt,
      resumeAt:this.state.resumeAt, windowStart:this.state.windowStart, resetInMs,
      autoResume:config.autoResume, bannedAt:this.state.bannedAt,
      repliesReceived:this.state.repliesReceived,
      scheduledAt:schedules[this.id]?.scheduledAt||null,
      minDelay:config.minDelay, maxDelay:config.maxDelay, sessionSize:config.sessionSize,
      log:this.state.log.slice(0,50)
    };
  }

  reset() {
    this.state.queue.forEach(c=>{if(c.status!=='done')c.status='pending';});
    this.state.stats={sent:0,failed:0,skipped:0,blacklisted:0};
    this.state.sessionCount=0; this.state.dailySent=0;
    this.state.windowStart=null; this.state.limitReached=false;
    this.state.limitReachedAt=null; this.state.resumeAt=null; this.state.bannedAt=null;
    if(this._resumeTimer){clearTimeout(this._resumeTimer);this._resumeTimer=null;}
    this._saveQueue(); this.log('🔄 Queue réinitialisée','warn');
  }

  clear() {
    this.state.queue=[]; this.state.stats={sent:0,failed:0,skipped:0,blacklisted:0};
    this.state.sessionCount=0; this.state.dailySent=0;
    this.state.windowStart=null; this.state.limitReached=false;
    this.state.limitReachedAt=null; this.state.resumeAt=null; this.state.bannedAt=null;
    if(this._resumeTimer){clearTimeout(this._resumeTimer);this._resumeTimer=null;}
    this._saveQueue(); this.log('🗑️ Queue vidée','warn');
  }

  clearLogs() {
    this.state.log = [];
    saveLogs(this.id, []);
    console.log(`[BOT${this.id}] Logs effacés`);
  }
}

// ─── Deux comptes ─────────────────────────────────────────────────────────────
const bots={1:new BotAccount(1),2:new BotAccount(2)};

function getBot(req) {
  const id = parseInt(req.params.account || req.query.account || '');
  return (!isNaN(id) && bots[id]) ? bots[id] : null;
}
function requireBot(req, res) {
  const bot = getBot(req);
  if (!bot) {
    res.status(404).json({ ok: false, error: `Compte invalide. Comptes disponibles : ${Object.keys(bots).join(', ')}` });
    return null;
  }
  return bot;
}
function otherBot(bot){return bot.id===1?bots[2]:bots[1];}

// ─── Routes API ───────────────────────────────────────────────────────────────
app.get('/api/:account/status', (req,res)=>{ const b=requireBot(req,res); if(!b) return; res.json(b.getStatus()); });
app.post('/api/:account/start', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  if(!b.state.ready) return res.status(400).json({ok:false,error:'Non connecté'});
  b.state.paused=false; b.state.limitReached=false; b.state.bannedAt=null;
  cancelSchedule(b.id); b.runQueue(otherBot(b)); res.json({ok:true});
});
app.post('/api/:account/pause', (req,res)=>{ const b=requireBot(req,res); if(!b) return; b.state.paused=!b.state.paused; b.log(b.state.paused?'⏸️ Pause':'▶️ Reprise','warn'); res.json({ok:true,paused:b.state.paused}); });
app.post('/api/:account/clear', (req,res)=>{ const b=requireBot(req,res); if(!b) return; b.clear(); res.json({ok:true}); });
app.post('/api/:account/reset', (req,res)=>{ const b=requireBot(req,res); if(!b) return; b.reset(); res.json({ok:true}); });

app.post('/api/:account/set-limit', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  const limit=parseInt(req.body.limit);
  if(!limit||limit<1||limit>1000) return res.status(400).json({ok:false,error:'Limite invalide (1-1000)'});
  dailyLimitMap[b.id]=limit;
  saveConfig();
  b.log(`⚙️ Limite modifiée → ${limit} msgs/24h`,'warn');
  res.json({ok:true,limit});
});

app.post('/api/:account/schedule', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  const{scheduledAt}=req.body;
  if(!scheduledAt) return res.status(400).json({ok:false,error:'scheduledAt requis'});
  const result=setSchedule(b,scheduledAt,otherBot(b));
  if(!result.ok) return res.status(400).json(result);
  res.json(result);
});
app.delete('/api/:account/schedule', (req,res)=>{ const b=requireBot(req,res); if(!b) return; cancelSchedule(b.id); res.json({ok:true}); });

app.post('/api/:account/test-message', async(req,res)=>{
  try {
    const b=requireBot(req,res); if(!b) return;
    const{phone,message,link}=req.body;
    if(!phone) return res.status(400).json({ok:false,error:'Numéro requis'});
    await b.sendTest(phone,message,link); res.json({ok:true});
  } catch(e){res.status(400).json({ok:false,error:e.message});}
});

app.get('/api/:account/logs', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  const { page=1, limit=100, type='' } = req.query;
  const perPage = Math.min(parseInt(limit)||100, 500);
  let entries = b.state.log;
  if (type) entries = entries.filter(e => e.type === type);
  const total = entries.length;
  const start = (parseInt(page)-1)*perPage;
  res.json({ total, page: parseInt(page), perPage, items: entries.slice(start, start+perPage) });
});

app.delete('/api/:account/logs', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  b.clearLogs();
  res.json({ok:true});
});

// ─── /api/stats — avec détail par compte et totalReplies ─────────────────────
app.get('/api/stats', (req,res)=>{
  const sessions=loadSessions();
  const totalSent=sessions.reduce((s,x)=>s+(x.sent||0),0);
  const totalSkipped=sessions.reduce((s,x)=>s+(x.skipped||0),0);
  const totalFailed=sessions.reduce((s,x)=>s+(x.failed||0),0);
  const total=totalSent+totalSkipped+totalFailed;
  const deliveryRate=total>0?Math.round(totalSent/total*100):0;
  const skipRate=total>0?Math.round(totalSkipped/total*100):0;
  const last30=sessions.slice(-30).map(s=>({date:s.date,botId:s.botId,sent:s.sent||0,skipped:s.skipped||0,failed:s.failed||0,duration:s.duration||0}));

  const totalReplies = Object.values(bots).reduce((sum, b) => sum + (b.state.repliesReceived || 0), 0);

  const byAccount = {};
  for (const s of sessions) {
    const id = s.botId || 1;
    if (!byAccount[id]) byAccount[id] = { account: id, sent: 0, failed: 0, skipped: 0, replies: 0 };
    byAccount[id].sent    += s.sent    || 0;
    byAccount[id].failed  += s.failed  || 0;
    byAccount[id].skipped += s.skipped || 0;
  }
  for (const b of Object.values(bots)) {
    if (!byAccount[b.id]) byAccount[b.id] = { account: b.id, sent: 0, failed: 0, skipped: 0, replies: 0 };
    byAccount[b.id].replies = b.state.repliesReceived || 0;
  }
  const accounts = Object.values(byAccount).sort((a,b)=>a.account-b.account);

  res.json({
    totalSent, totalSkipped, totalFailed, total,
    deliveryRate, skipRate,
    totalReplies,
    totalSessions: sessions.length,
    sessions: last30,
    accounts
  });
});

app.get('/api/:account/queue', (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  const{status,page=1,limit=50}=req.query;
  let items=bot.state.queue;
  if(status==='replied') items=items.filter(c=>c.replied===true);
  else if(status) items=items.filter(c=>c.status===status);
  const total=items.length, start=(parseInt(page)-1)*parseInt(limit);
  res.json({total,page:parseInt(page),items:items.slice(start,start+parseInt(limit))});
});

app.get('/api/:account/export', (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  const{status}=req.query;
  let items=bot.state.queue;
  if(status==='replied') items=items.filter(c=>c.replied===true);
  else if(status) items=items.filter(c=>c.status===status);
  const rows=items.map(c=>({telephone:c.phone,prenom:c.prenom||'',nom:c.nom||'',statut:c.status,replied:c.replied?'Oui':'Non',reply_text:c.replyText||'',message:c.message,link:c.link||'',ajoute_le:c.addedAt,envoye_le:c.sentAt||'',wa_message_id:c.waMessageId||''}));
  const suffix=status?'_'+status:'';
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="export_bot${bot.id}${suffix}.csv"`);
  res.send(stringify(rows,{header:true}));
});

app.post('/api/:account/import', upload.single('file'), (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  if (!req.file) return res.status(400).json({ok:false,error:'Fichier manquant'});
  let result;
  try {
    const content=fs.readFileSync(req.file.path,'utf-8');
    const message=(req.body.message||'').trim();
    const link=(req.body.link||'').trim();
    if(!message) return res.status(400).json({ok:false,error:'Message vide'});
    const force=JSON.parse(req.body.forceInclude||'[]');
    result=bot.importCSV(content,message,link,force);
  } catch(e){
    return res.status(400).json({ok:false,error:e.message});
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
  if(result.duplicates.length>0&&!(JSON.parse(req.body.forceInclude||'[]').length>0)) {
    res.json({ok:true,...result,needsConfirmation:true});
  } else {
    res.json({ok:true,...result,needsConfirmation:false});
  }
});

app.delete('/api/:account/queue/:phone', (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  const removed=bot.removeContact(req.params.phone);
  res.json({ok:true,removed});
});

app.get('/api/sent-history', (req,res)=>{
  const hist=loadSentHistory();
  const list=Object.entries(hist).map(([phone,d])=>({phone,...d}));
  list.sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt));
  const{page=1,limit=100,q=''}=req.query;
  const filtered=q?list.filter(x=>x.phone.includes(q)||(x.prenom||'').toLowerCase().includes(q.toLowerCase())||(x.nom||'').toLowerCase().includes(q.toLowerCase())):list;
  const start=(parseInt(page)-1)*parseInt(limit);
  res.json({total:filtered.length,items:filtered.slice(start,start+parseInt(limit))});
});
app.delete('/api/sent-history/:phone', (req,res)=>{
  removeFromSentHistory(req.params.phone);
  res.json({ok:true});
});
app.delete('/api/sent-history', (req,res)=>{
  saveSentHistory({});
  res.json({ok:true});
});

app.get('/api/blacklist', (req,res)=>res.json({list:loadBlacklist()}));
app.post('/api/blacklist/add', (req,res)=>{
  const phone=(req.body.phone||'').replace(/\D/g,'');
  if(!phone||phone.length<8) return res.status(400).json({ok:false,error:'Numéro invalide'});
  const list=loadBlacklist();
  if(!list.includes(phone)){list.push(phone);saveBlacklist(list);}
  res.json({ok:true,phone,total:list.length});
});
app.post('/api/blacklist/remove', (req,res)=>{
  const phone=(req.body.phone||'').replace(/\D/g,'');
  const list=loadBlacklist().filter(p=>p.replace(/\D/g,'')!==phone);
  saveBlacklist(list); res.json({ok:true,total:list.length});
});

app.post('/api/blacklist/import', upload.single('file'), (req,res)=>{
  if (!req.file) return res.status(400).json({ok:false,error:'Fichier manquant'});
  let added=0, total=0;
  try {
    const content=fs.readFileSync(req.file.path,'utf-8');
    const records=csv.parse(content,{columns:true,skip_empty_lines:true});
    const list=loadBlacklist();
    for(const row of records){
      const phone=(row.telephone||row.phone||Object.values(row)[0]||'').replace(/\D/g,'');
      if(phone&&phone.length>=8&&!list.includes(phone)){list.push(phone);added++;}
    }
    saveBlacklist(list);
    total=list.length;
  } catch(e){
    return res.status(400).json({ok:false,error:e.message});
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
  res.json({ok:true,added,total});
});

app.get('/api/config',(req,res)=>{
  res.json({ ...config, dailyLimit: { ..._dailyLimitOverrides } });
});
app.post('/api/config',(req,res)=>{
  const allowed=['minDelay','maxDelay','sessionSize','autoResume'];
  for(const k of allowed)if(req.body[k]!==undefined)config[k]=req.body[k];
  saveConfig(); res.json({ok:true,config});
});

app.get('/api/:account/groups',async(req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  if(!bot.state.ready) return res.json([]);
  const chats=await bot.client.getChats();
  res.json(chats.filter(c=>c.isGroup).map(c=>({name:c.name,count:c.participants?.length||0})));
});
app.get('/api/:account/export-group/:name',async(req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  if(!bot.state.ready) return res.status(400).json({ok:false,error:'Non connecté'});
  const chats=await bot.client.getChats(); const groupName=decodeURIComponent(req.params.name);
  const group=chats.find(c=>c.isGroup&&c.name===groupName);
  if(!group) return res.status(404).json({ok:false,error:'Groupe introuvable'});
  const rows=[];
  for(const p of group.participants){
    let prenom='',nom='';
    try{const contact=await bot.client.getContactById(`${p.id.user}@c.us`);const displayName=contact.pushname||contact.name||'';const parts=displayName.trim().split(/\s+/);prenom=parts[0]||'';nom=parts.slice(1).join(' ')||'';}catch(e){}
    rows.push({telephone:`+${p.id.user}`,prenom,nom,admin:p.isAdmin?'Oui':'Non'});
  }
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${groupName}.csv"`);
  res.send(stringify(rows,{header:true}));
});

app.get('/api/status',(req,res)=>res.json(bots[1].getStatus()));
app.post('/api/start',(req,res)=>{
  if(!bots[1].state.ready) return res.status(400).json({ok:false,error:'Non connecté'});
  bots[1].state.paused=false; bots[1].state.limitReached=false; bots[1].state.bannedAt=null;
  cancelSchedule(bots[1].id);
  bots[1].runQueue(bots[2]); res.json({ok:true});
});
app.post('/api/pause',(req,res)=>{bots[1].state.paused=!bots[1].state.paused;res.json({ok:true});});
app.post('/api/clear',(req,res)=>{bots[1].clear();res.json({ok:true});});
app.get('/api/groups',async(req,res)=>{if(!bots[1].state.ready)return res.json([]);const c=await bots[1].client.getChats();res.json(c.filter(x=>x.isGroup).map(x=>({name:x.name,count:x.participants?.length||0})));});

app.listen(PORT,()=>console.log(`WhatsApp Manager → http://localhost:${PORT}`));
