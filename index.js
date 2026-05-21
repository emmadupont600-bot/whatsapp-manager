const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const express  = require('express');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const csv      = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ─── Handlers globaux pour éviter les crashes silencieux ─────────────────────
process.on('unhandledRejection', (reason) => console.error('[FATAL] Unhandled rejection:', reason));
process.on('uncaughtException',  (err)    => console.error('[FATAL] Uncaught exception:',  err));

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Limite de taille fichier à 10 Mo
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

// Nettoyage automatique du dossier uploads/
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

// ─── Middleware d'authentification par token Bearer ───────────────────────────
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

// ─── Rate-limiting sur les routes API (100 req/min par IP) ───────────────────
const _rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
function rateLimitMiddleware(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = _rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) { entry.count = 0; entry.start = now; }
  entry.count++;
  _rateLimitMap.set(key, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'Trop de requêtes. Réessayez dans une minute.' });
  }
  next();
}
app.use('/api', rateLimitMiddleware);

// ─── Blacklist avec cache mémoire + flush debounce ────────────────────────────
const BLACKLIST_FILE = path.join(__dirname, 'data', 'blacklist.json');
let _blacklistCache = null;
let _blacklistFlushTimer = null;

function _loadBlacklistFromDisk() {
  if (!fs.existsSync(BLACKLIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8')); } catch(e) { return []; }
}
function _getBlacklistCache() {
  if (_blacklistCache === null) _blacklistCache = _loadBlacklistFromDisk();
  return _blacklistCache;
}
function _flushBlacklist() {
  if (_blacklistFlushTimer) return;
  _blacklistFlushTimer = setTimeout(() => {
    _blacklistFlushTimer = null;
    const dir = path.dirname(BLACKLIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...new Set(_blacklistCache)], null, 2)); }
    catch(e) { console.error('[BLACKLIST] Erreur écriture :', e.message); }
  }, 500);
}
function loadBlacklist() { return _getBlacklistCache(); }
function saveBlacklist(list) { _blacklistCache = [...new Set(list)]; _flushBlacklist(); }
function isBlacklisted(phone, cachedList) {
  const clean = phone.replace(/\D/g,'');
  return (cachedList || _getBlacklistCache()).some(p => p.replace(/\D/g,'') === clean);
}

// ─── sent-history en cache mémoire + flush debounce ──────────────────────────
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

function loadSentHistory() { return _getSentHistoryCache(); }
function saveSentHistory(hist) { _sentHistoryCache = hist; _flushSentHistory(); }

function normalizeHistoryEntry(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.contacts) && raw.contacts.length) return raw;
  if (raw.sentAt || raw.message) {
    return {
      prenom: raw.prenom || '',
      nom: raw.nom || '',
      contacts: [{
        sentAt: raw.sentAt || new Date().toISOString(),
        botId: raw.botId,
        message: (raw.message || '').substring(0, 500),
        link: raw.link || ''
      }]
    };
  }
  return { prenom: raw.prenom || '', nom: raw.nom || '', contacts: [] };
}

function enrichHistoryEntry(phone, raw) {
  const entry = normalizeHistoryEntry(raw);
  if (!entry) return null;
  const contacts = [...entry.contacts].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
  const last = contacts[0] || {};
  return {
    phone,
    prenom: entry.prenom,
    nom: entry.nom,
    contactCount: contacts.length,
    lastSentAt: last.sentAt || null,
    lastMessage: last.message || '',
    lastLink: last.link || '',
    lastBotId: last.botId,
    contacts
  };
}

function getHistoryEntry(phone, cachedHist) {
  const clean = phone.replace(/\D/g, '');
  const raw = (cachedHist || _getSentHistoryCache())[clean];
  if (!raw) return null;
  return enrichHistoryEntry(clean, raw);
}

function addToSentHistory(phone, data) {
  const hist  = _getSentHistoryCache();
  const clean = phone.replace(/\D/g, '');
  let entry = hist[clean] ? normalizeHistoryEntry(hist[clean]) : { prenom: '', nom: '', contacts: [] };
  if (data.prenom) entry.prenom = data.prenom;
  if (data.nom) entry.nom = data.nom;
  entry.contacts.push({
    sentAt: data.sentAt || new Date().toISOString(),
    botId: data.botId,
    message: (data.message || '').substring(0, 500),
    link: (data.link || '').substring(0, 300)
  });
  hist[clean] = entry;
  _flushSentHistory();
}

function isAlreadySent(phone, cachedHist) {
  return getHistoryEntry(phone, cachedHist);
}

function removeFromSentHistory(phone) {
  const hist = _getSentHistoryCache();
  delete hist[phone.replace(/\D/g,'')];
  _flushSentHistory();
}

// ─── Planning (scheduled start) ──────────────────────────────────────────────
const schedules = {};
function cancelSchedule(accountId) {
  if (schedules[accountId]) { clearTimeout(schedules[accountId].timerId); delete schedules[accountId]; }
}

function parseScheduledAt(scheduledAt) {
  if (!scheduledAt || typeof scheduledAt !== 'string') return { ok: false, error: 'scheduledAt doit être une chaîne de caractères' };
  const ts = Date.parse(scheduledAt);
  if (isNaN(ts)) return { ok: false, error: `Date invalide : "${scheduledAt}". Format attendu : ISO 8601 (ex: 2026-05-22T14:00:00.000Z)` };
  const ms = ts - Date.now();
  if (ms < 30_000) return { ok: false, error: `La date planifiée doit être dans au moins 30 secondes (reçu : ${new Date(ts).toISOString()})` };
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

// ─── Historique de sessions (stats globales) ──────────────────────────────────
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

// ─── Persistance des logs sur disque ─────────────────────────────────────────
const MAX_LOG_ENTRIES = 1000;
const LOG_FLUSH_DEBOUNCE_MS = 2000;

function logFilePath(id) { return path.join(__dirname, 'data', `logs_${id}.json`); }
function loadLogs(id) {
  const file = logFilePath(id);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) { return []; }
}
function saveLogs(id, entries) {
  const file = logFilePath(id);
  const dir  = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES), null, 2)); }
  catch(e) { console.error(`[BOT${id}] Erreur écriture logs : ${e.message}`); }
}

// ─── dailyLimit dynamique via Proxy ──────────────────────────────────────────
const DEFAULT_DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '300');
const _dailyLimitOverrides = {};
const dailyLimitMap = new Proxy(_dailyLimitOverrides, {
  get(target, id) { const n = typeof id === 'symbol' ? id : Number(id); return target[n] !== undefined ? target[n] : DEFAULT_DAILY_LIMIT; },
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
  linkDelayMin:   parseInt(process.env.LINK_DELAY_MIN_MS || '10000'),
  linkDelayMax:   parseInt(process.env.LINK_DELAY_MAX_MS || '18000'),
  maxMessagesPerHour: parseInt(process.env.MAX_MSGS_PER_HOUR || '80'),
  dailyLimit:     {},
  autoResume:     true,
  quotaAsContacts: true
};
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf-8'));
    Object.assign(config, saved);
    if (config.minDelay        > config.maxDelay)        config.maxDelay        = config.minDelay;
    if (config.sessionPauseMin > config.sessionPauseMax) config.sessionPauseMax = config.sessionPauseMin;
    if (config.typingMin       > config.typingMax)       config.typingMax       = config.typingMin;
    if (config.linkDelayMin    > config.linkDelayMax)    config.linkDelayMax    = config.linkDelayMin;
    if (saved.dailyLimit && typeof saved.dailyLimit === 'object') {
      for (const [id, val] of Object.entries(saved.dailyLimit)) dailyLimitMap[id] = parseInt(val);
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

function whatsappMsgId(msg) {
  if (!msg || !msg.id) return null;
  return msg.id._serialized || msg.id.id || (typeof msg.id === 'string' ? msg.id : null);
}

const URL_RE = /(https?:\/\/[^\s]+)/i;
function splitMessageAndLink(msg) {
  const match = msg.match(URL_RE);
  if (!match) return null;
  const url    = match[1];
  const before = msg.slice(0, match.index).trim();
  const after  = msg.slice(match.index + url.length).trim();
  return { text: [before, after].filter(Boolean).join('\n').trim(), url };
}

function countOutboundMessages(rawMsg, link) {
  const text = (rawMsg || '').trim();
  const separateLink = !!(link && link.trim());
  if (separateLink && text) return 2;
  if (separateLink && !text) return 1;
  const parts = splitMessageAndLink(text);
  if (parts) return parts.text ? 2 : 1;
  return text ? 1 : 0;
}

function personalizeMessage(template, contact) {
  if (!template) return template;
  return template
    .replace(/\{pr[eé]nom\}/gi, contact.prenom || contact.nom || '')
    .replace(/\{nom\}/gi,       contact.nom    || contact.prenom || '')
    .replace(/\{name\}/gi,      contact.prenom || contact.nom || '')
    .replace(/\{phone\}/gi,     contact.phone  || '')
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

// ─── Supprime récursivement un dossier (équivalent rm -rf) ───────────────────
function rmrf(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) rmrf(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(dirPath);
  } catch(e) {
    console.error(`[rmrf] Erreur sur ${dirPath} : ${e.message}`);
  }
}

// ─── withTimeout ─────────────────────────────────────────────────────────────
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms : ${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e);  });
  });
}

async function getContactName(client, userId, timeoutMs = 5000) {
  const chatId  = `${userId}@c.us`;
  const extract = contact => {
    const parts = (contact.pushname || contact.name || '').trim().split(/\s+/);
    return { prenom: parts[0] || '', nom: parts.slice(1).join(' ') || '' };
  };
  try {
    return extract(await withTimeout(client.getContactById(chatId), timeoutMs, userId));
  } catch (_) {
    await sleep(800);
    try {
      return extract(await withTimeout(client.getContactById(chatId), timeoutMs, `${userId} retry`));
    } catch (err) {
      console.warn(`[export-group] ⚠️  ${userId} ignoré : ${err.message}`);
      return { prenom: '', nom: '' };
    }
  }
}

const EXPORT_GROUP_INTER_DELAY_MS = parseInt(process.env.EXPORT_GROUP_DELAY_MS || '120');

// ─── safeIsRegisteredUser avec fallback ──────────────────────────────────────
async function safeIsRegisteredUser(client, chatId, logger) {
  try {
    return await withTimeout(client.isRegisteredUser(chatId), 8000, `isRegisteredUser(${chatId})`);
  } catch(e) {
    if (logger) logger(`⚠️ isRegisteredUser échoué pour ${chatId} (${e.message}) — on tente l'envoi quand même`, 'warn');
    return true;
  }
}

// ─── getChatById avec retry robuste ──────────────────────────────────────────
async function getChat(client, chatId, logger) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const chat = await withTimeout(client.getChatById(chatId), 10000, `getChatById(${chatId}) attempt ${attempt}`);
      if (!chat) throw new Error('getChatById a retourné null');
      if (typeof chat.sendMessage !== 'function') throw new Error('chat.sendMessage n\'est pas une fonction');
      return chat;
    } catch(e) {
      if (logger) logger(`⚠️ getChatById attempt ${attempt}/${MAX_RETRIES} échoué : ${e.message}`, 'warn');
      if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
    }
  }
  throw new Error(`getChatById(${chatId}) a échoué après ${MAX_RETRIES} tentatives`);
}

// ─── sendMessage avec vérification post-envoi ────────────────────────────────
async function sendAndVerify(client, chat, chatId, text, label, logger) {
  const msg = await withTimeout(chat.sendMessage(text), 15000, `sendMessage(${label})`);
  const msgId = whatsappMsgId(msg);

  if (!msgId) {
    if (logger) logger(`⚠️ sendMessage(${label}) sans id — vérification via getMessages...`, 'warn');
    await sleep(3000);
    try {
      const messages = await withTimeout(chat.fetchMessages({ limit: 5 }), 8000, `fetchMessages(${label})`);
      const recent = messages.filter(m => m.fromMe && m.body === text && (Date.now() - m.timestamp * 1000) < 30000);
      if (recent.length === 0) {
        throw new Error(`Message "${label}" non trouvé dans la conversation après envoi — whatsapp-web.js déconnecté`);
      }
      if (logger) logger(`✔️ Message ${label} confirmé via fetchMessages`, 'info');
      return { id: 'verified-no-id', verified: true };
    } catch(verifyErr) {
      if (verifyErr.message.includes('non trouvé')) throw verifyErr;
      throw new Error(`Session WhatsApp instable : sendMessage OK mais fetchMessages échoué (${verifyErr.message})`);
    }
  }

  if (logger) logger(`✔️ Message ${label} envoyé · id: ${msgId.substring(0, 20)}...`, 'info');
  return { id: msgId, verified: true };
}

// ─── BotAccount ──────────────────────────────────────────────────────────────
class BotAccount {
  constructor(id) {
    this.id         = id;
    this.authPath   = path.join(process.env.AUTH_PATH || '/app', '.wwebjs_auth', `account${id}`);
    this.dataFile   = path.join(__dirname, 'data', `queue_${id}.json`);
    this.client     = null;
    this.retryCount = 0;
    this._resumeTimer    = null;
    this._logFlushTimer  = null;
    this._saveQueueTimer = null;
    this._queueLoopActive = false;
    this.state = {
      qr: null, ready: false, running: false, paused: false,
      queue: [], sessionCount: 0,
      dailySent: 0, dailyDate: '',
      windowStart: null,
      limitReached: false, limitReachedAt: null,
      resumeAt: null, bannedAt: null,
      repliesReceived: 0,
      sendTimestamps: [],
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

  _saveQueue(immediate = false) {
    if (immediate) {
      if (this._saveQueueTimer) { clearTimeout(this._saveQueueTimer); this._saveQueueTimer = null; }
      this._writeQueueToDisk();
      return;
    }
    if (this._saveQueueTimer) return;
    this._saveQueueTimer = setTimeout(() => {
      this._saveQueueTimer = null;
      this._writeQueueToDisk();
    }, 500);
  }

  _writeQueueToDisk() {
    const dir = path.dirname(this.dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify({
        queue: this.state.queue, stats: this.state.stats,
        sessionCount: this.state.sessionCount,
        dailySent: this.state.dailySent, dailyDate: this.state.dailyDate,
        windowStart: this.state.windowStart,
        limitReached: this.state.limitReached, limitReachedAt: this.state.limitReachedAt,
        resumeAt: this.state.resumeAt, bannedAt: this.state.bannedAt,
        repliesReceived: this.state.repliesReceived,
        savedAt: new Date().toISOString()
      }, null, 2));
    } catch(e) {
      console.error(`[BOT${this.id}] Erreur écriture queue : ${e.message}`);
    }
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

  log(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    this.state.log.unshift(entry);
    if (this.state.log.length > MAX_LOG_ENTRIES) this.state.log = this.state.log.slice(0, MAX_LOG_ENTRIES);
    console.log(`[BOT${this.id}][${type.toUpperCase()}] ${msg}`);
    this._flushLogs();
  }

  _autoResume() {
    let fixed = 0;
    this.state.queue.forEach(c => { if (c.status === 'processing') { c.status = 'pending'; fixed++; } });
    if (fixed > 0) { this.log(`♻️ ${fixed} contacts remis en attente après crash`, 'warn'); this._saveQueue(true); }
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
      this._saveQueue(true);
      return true;
    }
    return false;
  }

  _windowResetIn() {
    if (!this.state.windowStart) return 0;
    return Math.max(0, 24 * 3600 * 1000 - (Date.now() - new Date(this.state.windowStart).getTime()));
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

  _recordFirstSend() { if (!this.state.windowStart) this.state.windowStart = new Date().toISOString(); }
  _dailyLimitReached() { this._checkWindowReset(); return this.state.dailySent >= this.dailyLimit; }

  _messagesAvailable() {
    this._checkWindowReset();
    return Math.max(0, this.dailyLimit - this.state.dailySent);
  }

  _pruneSendTimestamps() {
    const cutoff = Date.now() - 3600 * 1000;
    this.state.sendTimestamps = (this.state.sendTimestamps || []).filter(t => t > cutoff);
  }

  _recordMessagesSent(count) {
    if (!count) return;
    this._pruneSendTimestamps();
    const now = Date.now();
    for (let i = 0; i < count; i++) this.state.sendTimestamps.push(now);
  }

  _hourlyWouldExceed(additional) {
    this._pruneSendTimestamps();
    const max = config.maxMessagesPerHour || 80;
    if (max <= 0) return false;
    return (this.state.sendTimestamps.length + additional) > max;
  }

  async _waitForHourlyCapacity(needed) {
    let waits = 0;
    while (this._hourlyWouldExceed(needed)) {
      if (!this.state.running) return false;
      waits++;
      if (waits > 24) {
        this.log('❌ Limite horaire toujours atteinte après 2h — arrêt', 'error');
        return false;
      }
      this.log(`⏳ Limite horaire (~${config.maxMessagesPerHour} msgs/h) — pause 5 min (${this.state.sendTimestamps.length} envoyés cette heure)`, 'warn');
      await sleep(5 * 60 * 1000);
      this._pruneSendTimestamps();
    }
    return true;
  }

  _resetStuckContacts() {
    let fixed = 0;
    this.state.queue.forEach(c => {
      if (c.status === 'processing') { c.status = 'pending'; fixed++; }
    });
    if (fixed > 0) {
      this.log(`♻️ ${fixed} contact(s) débloqué(s) (statut processing → pending)`, 'warn');
      this._saveQueue(true);
    }
    return fixed;
  }

  _estimateQueueSeconds() {
    const pending = this.state.queue.filter(c => c.status === 'pending');
    let sec = 0;
    for (const c of pending) {
      const rawMsg = personalizeMessage((c.message || '').trim() || process.env.DEFAULT_MESSAGE || '', c);
      const link = personalizeMessage((c.link || '').trim(), c);
      const mc = countOutboundMessages(rawMsg, link);
      const base = (config.minDelay + config.maxDelay) / 2;
      sec += mc * base;
      if (mc >= 2) sec += (config.linkDelayMin + config.linkDelayMax) / 2000;
    }
    const sessions = Math.max(0, Math.floor(pending.length / Math.max(config.sessionSize, 1)));
    sec += sessions * ((config.sessionPaus