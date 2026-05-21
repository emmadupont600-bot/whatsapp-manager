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
// Si AUTH_TOKEN n'est pas défini, TOUTES les routes /api sont publiques.
// Définir la variable d'environnement AUTH_TOKEN pour activer la protection.
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
  /** Afficher le quota en « contacts » (texte+lien) : limite ÷ 2 côté UI */
  quotaAsContacts: true
};
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf-8'));
    Object.assign(config, saved);
    // FIX : valider la cohérence cross-champs au chargement depuis le disque
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

/** Nombre de messages WhatsApp réellement envoyés (texte + lien séparé = 2). */
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

// ─── getContactById avec timeout + retry ─────────────────────────────────────
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
    sec += sessions * ((config.sessionPauseMin + config.sessionPauseMax) / 2);
    return Math.round(sec);
  }

  _detectBan(errMessage) {
    return [/rate.?limit/i,/too many/i,/spam/i,/blocked/i,/account.*banned/i,/restrict/i,/ECONNRESET/i,/WAWebDisconnected/i].some(p=>p.test(errMessage));
  }

  _handleBan(err) {
    this.state.running = false; this.state.bannedAt = new Date().toISOString(); this.state.paused = true;
    this.log(`🚫 BAN / RESTRICTION DÉTECTÉ : ${err.message} — Bot arrêté pour protection`, 'error');
    this._saveQueue(true);
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
        this.runQueue(this._partner);
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

  async _delayMsg()     { const ms=rand(config.minDelay,config.maxDelay)*1000;               this.log(`⏳ Pause : ${(ms/1000).toFixed(0)}s`,'info');          await sleep(ms); }
  async _delaySession() { const ms=rand(config.sessionPauseMin,config.sessionPauseMax)*1000; this.log(`☕ Pause session : ${(ms/60000).toFixed(0)}min`,'warn'); await sleep(ms); }
  async _typing(chat)   { try { await chat.sendStateTyping(); await sleep(rand(config.typingMin,config.typingMax)); await chat.clearState(); } catch(e) {} }

  async _sendMessage(chatId, rawMsg, link) {
    const chat = await this.client.getChatById(chatId);
    const ids = [];
    const assertSent = (msg, label) => {
      const id = whatsappMsgId(msg);
      if (!id)
        throw new Error(`sendMessage() sans accusé WhatsApp (${label}). Reconnectez le compte.`);
      ids.push(id);
      return id;
    };
    if (link && link.trim()) {
      const text = (rawMsg || '').trim();
      if (text) {
        await this._typing(chat);
        assertSent(await this.client.sendMessage(chatId, text), 'texte');
        const delay = rand(config.linkDelayMin, config.linkDelayMax);
        this.log(`⏱ Délai anti-ban avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
        await sleep(delay);
      }
      await this._typing(chat);
      assertSent(await this.client.sendMessage(chatId, link.trim()), 'lien');
      return { messageCount: text ? 2 : 1, ids, lastId: ids[ids.length - 1] };
    }
    const parts = splitMessageAndLink(rawMsg);
    if (parts) {
      if (parts.text) {
        await this._typing(chat);
        assertSent(await this.client.sendMessage(chatId, parts.text), 'texte');
        await sleep(rand(config.linkDelayMin, config.linkDelayMax));
        assertSent(await this.client.sendMessage(chatId, parts.url), 'lien');
        return { messageCount: 2, ids, lastId: ids[ids.length - 1] };
      }
      await this._typing(chat);
      assertSent(await this.client.sendMessage(chatId, parts.url), 'url-seule');
      return { messageCount: 1, ids, lastId: ids[ids.length - 1] };
    }
    await this._typing(chat);
    assertSent(await this.client.sendMessage(chatId, rawMsg), 'texte-simple');
    return { messageCount: 1, ids, lastId: ids[ids.length - 1] };
  }

  async sendTest(phone, message, link) {
    if (!this.state.ready) throw new Error('WhatsApp non connecté');
    const number=phone.replace(/\D/g,''), chatId=`${number}@c.us`;
    if (!await this.client.isRegisteredUser(chatId)) throw new Error(`+${number} n'est pas sur WhatsApp`);
    const fakeContact={phone:number,prenom:'Test',nom:'Test'};
    const pMsg = personalizeMessage(message||'Message de test 👋',fakeContact);
    const pLink = personalizeMessage(link||'',fakeContact);
    const need = countOutboundMessages(pMsg, pLink);
    if (need > this._messagesAvailable()) {
      throw new Error(`Quota insuffisant : ${need} message(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`);
    }
    if (!(await this._waitForHourlyCapacity(need))) throw new Error('Envoi annulé');
    const result = await this._sendMessage(chatId, pMsg, pLink);
    this.state.dailySent += result.messageCount;
    this._recordMessagesSent(result.messageCount);
    this._recordFirstSend();
    this._saveQueue();
    this.log(`🧪 Test envoyé à +${number} (${result.messageCount} msg WhatsApp) [${this.state.dailySent}/${this.dailyLimit}]`,'success');
  }

  async runQueue(relayBot) {
    if (this._queueLoopActive) {
      this.log('⚠️ Envoi déjà en cours', 'warn');
      return;
    }
    this._resetStuckContacts();
    const pendingCount = this.state.queue.filter(c => c.status === 'pending').length;
    if (!pendingCount) {
      this.log('ℹ️ Aucun contact en attente dans la queue', 'warn');
      return;
    }
    if (!this.state.ready) {
      this.log('❌ WhatsApp non connecté — scannez le QR dans l’onglet Connexion', 'error');
      return;
    }
    if (this._dailyLimitReached()) {
      this.log(`⏸ Quota journalier atteint (${this.state.dailySent}/${this.dailyLimit} msgs WA)`, 'warn');
      this.state.limitReached = true;
      return;
    }

    this._queueLoopActive = true;
    this.state.running = true;
    this.state.limitReached = false;
    const startStats={...this.state.stats}, startTime=Date.now();
    let notReadyTicks = 0;
    this.log(`🚀 Démarrage : ${pendingCount} contact(s) · quota ${this.state.dailySent}/${this.dailyLimit} msgs WA`,'success');

    try {
    while (this.state.queue.some(c => c.status === 'pending')) {
      if (!this.state.running) break;
      if (!this.state.ready) {
        notReadyTicks++;
        if (notReadyTicks === 1 || notReadyTicks % 6 === 0) {
          this.log('⏳ En attente connexion WhatsApp (scannez le QR si besoin)...', 'warn');
        }
        await sleep(10000);
        continue;
      }
      notReadyTicks = 0;
      if (this.state.paused)  { await sleep(3000);  continue; }

      if (this._dailyLimitReached()) {
        this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
        const remaining=this.state.queue.filter(c=>c.status==='pending');
        const resetIn=this._windowResetIn();
        const relay = relayBot || this._partner;
        if (relay && relay.state.ready && remaining.length>0) {
          this.log(`🔁 Limite ${this.dailyLimit} msgs atteinte → relais vers Compte ${relay.id} (${remaining.length} contacts)`,'warn');
          for (const c of remaining) {
            const cleanPhone=c.phone.replace(/\D/g,'');
            const alreadyInRelay=relay.state.queue.some(x=>x.phone.replace(/\D/g,'')=== cleanPhone&&['pending','processing','done'].includes(x.status));
            if (!alreadyInRelay) relay.state.queue.push({...c,status:'pending',relayedFrom:this.id,relayedAt:new Date().toISOString()});
            else this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`,'warn');
            c.status='relayed';
          }
          this._saveQueue(true); relay._saveQueue(true);
          if (!relay.state.running) relay.runQueue(this);
        } else {
          this.log(`⏸ Limite ${this.dailyLimit} atteinte. Quota reset dans ${Math.round(resetIn/3600000*10)/10}h`,'warn');
          if (config.autoResume) this._scheduleAutoResume(relay);
        }
        this._saveQueue(true); break;
      }

      if (this.state.sessionCount > 0 && this.state.sessionCount % config.sessionSize === 0) {
        this.log(`📊 Session ${Math.floor(this.state.sessionCount/config.sessionSize)} terminée`,'info');
        await this._delaySession();
        // FIX : sortir si le bot a été stoppé pendant la pause session (peut durer 20 min)
        if (!this.state.running) break;
      }

      const contact=this.state.queue.find(c=>c.status==='pending');
      if (!contact) break;
      contact.status='processing'; this._saveQueue(true);

      try {
        const number=contact.phone.replace(/\D/g,''), chatId=`${number}@c.us`;
        if (isBlacklisted(number)) {
          contact.status='blacklisted'; this.state.stats.blacklisted++;
          this.log(`🚫 Blacklisté : +${number}`,'warn');
          this._saveQueue(); await sleep(rand(1000,3000)); continue;
        }
        if (!await this.client.isRegisteredUser(chatId)) {
          contact.status='skipped'; this.state.stats.skipped++;
          this.log(`⏭️ Non inscrit : +${number}`,'warn');
          this._saveQueue(); await sleep(rand(3000,8000)); continue;
        }
        await sleep(rand(800, 2500));
        const rawMsg=personalizeMessage((contact.message||'').trim()||process.env.DEFAULT_MESSAGE||'Bonjour ! 👋',contact);
        const personalizedLink=personalizeMessage((contact.link||'').trim(),contact);
        const msgCount = countOutboundMessages(rawMsg, personalizedLink);
        if (msgCount === 0) {
          contact.status='skipped'; this.state.stats.skipped++;
          this.log(`⏭️ Message vide : +${number}`,'warn');
          this._saveQueue(); continue;
        }
        if (msgCount > this._messagesAvailable()) {
          this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
          contact.status='pending';
          const remaining=this.state.queue.filter(c=>c.status==='pending');
          const resetIn=this._windowResetIn();
          const relay = relayBot || this._partner;
          this.log(`⏸ Quota : ${msgCount} msg(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`,'warn');
          if (relay && relay.state.ready && remaining.length>0) {
            this.log(`🔁 Relais vers Compte ${relay.id} (${remaining.length} contacts)`,'warn');
            for (const c of remaining) {
              const cleanPhone=c.phone.replace(/\D/g,'');
              const alreadyInRelay=relay.state.queue.some(x=>x.phone.replace(/\D/g,'')=== cleanPhone&&['pending','processing','done'].includes(x.status));
              if (!alreadyInRelay) relay.state.queue.push({...c,status:'pending',relayedFrom:this.id,relayedAt:new Date().toISOString()});
              else this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`,'warn');
              c.status='relayed';
            }
            this._saveQueue(true); relay._saveQueue(true);
            if (!relay.state.running) relay.runQueue(this);
          } else if (config.autoResume) this._scheduleAutoResume(relay);
          this._saveQueue(true); break;
        }
        if (!(await this._waitForHourlyCapacity(msgCount))) {
          contact.status = 'pending';
          this._saveQueue(true);
          this.log('⏸ Arrêt : limite horaire anti-ban', 'warn');
          break;
        }
        this._recordFirstSend();
        const result = await this._sendMessage(chatId, rawMsg, personalizedLink);
        contact.status='done'; contact.sentAt=new Date().toISOString();
        contact.waMessageId=result.lastId; contact.whatsappMessagesSent=result.messageCount;
        this.state.stats.sent++; this.state.sessionCount++;
        this.state.dailySent += result.messageCount;
        this._recordMessagesSent(result.messageCount);
        const linkNote = result.messageCount >= 2 ? ' (texte + lien = 2 msgs)' : '';
        this.log(`✅ Envoyé à +${number}${contact.prenom?' ('+contact.prenom+')':''}${linkNote} [${this.state.dailySent}/${this.dailyLimit} msgs]`,'success');
        addToSentHistory(number, { sentAt: contact.sentAt, botId: this.id, message: rawMsg, link: personalizedLink, prenom: contact.prenom, nom: contact.nom });
        this._saveQueue();
        await this._delayMsg();
        // FIX : sortir si le bot a été stoppé pendant le délai inter-messages
        if (!this.state.running) break;
      } catch(err) {
        if (this._detectBan(err.message)) { contact.status='pending'; this._handleBan(err); break; }
        if (contact.status === 'processing') contact.status = 'failed';
        this.state.stats.failed++;
        this.log(`❌ Erreur ${contact.phone} : ${err.message}`,'error');
        this._saveQueue(); await sleep(rand(30000,60000));
        if (!this.state.running) break;
      }
    }
    } finally {
      this._queueLoopActive = false;
      this.state.running = false;
      this._resetStuckContacts();
      if (!this.state.queue.some(c=>c.status==='pending')&&!this.state.bannedAt) this.log('🏁 Queue terminée','success');
      const sentThisRun=this.state.stats.sent-(startStats.sent||0);
      const skipThisRun=this.state.stats.skipped-(startStats.skipped||0);
      const failThisRun=this.state.stats.failed-(startStats.failed||0);
      if (sentThisRun+skipThisRun+failThisRun>0)
        recordSessionEnd(this.id,{sent:sentThisRun,skipped:skipThisRun,failed:failThisRun,duration:Math.round((Date.now()-startTime)/1000)});
      this._saveQueue(true);
    }
  }

  importCSV(content, defaultMessage, defaultLink, forceIncludeDuplicates = []) {
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    const blacklistCache   = loadBlacklist();
    const sentHistoryCache = loadSentHistory();
    let added=0, blacklisted=0, skippedQueue=0;
    const duplicates=[];
    for (const row of records) {
      const phone=(row.telephone||row.phone||row['Telephone']||row['Phone']||Object.values(row)[0]||'').replace(/\D/g,'');
      if (!phone||phone.length<8) continue;
      const prenom=row.prenom||row.prénom||row.firstname||row.first_name||row.Prenom||row['Prénom']||'';
      const nom=row.nom||row.name||row.lastname||row.last_name||row.Nom||row['Nom']||'';
      if (isBlacklisted(phone, blacklistCache)) { blacklisted++; continue; }
      if (this.state.queue.find(c=>c.phone.replace(/\D/g,'')=== phone)) { skippedQueue++; continue; }
      const histEntry = getHistoryEntry(phone, sentHistoryCache);
      if (histEntry && !forceIncludeDuplicates.includes(phone)) {
        duplicates.push({
          phone,
          prenom: prenom.trim() || histEntry.prenom,
          nom: nom.trim() || histEntry.nom,
          contactCount: histEntry.contactCount,
          lastSentAt: histEntry.lastSentAt,
          lastMessage: histEntry.lastMessage,
          lastLink: histEntry.lastLink,
          lastBotId: histEntry.lastBotId,
          contacts: histEntry.contacts.slice(0, 15)
        });
        continue;
      }
      this.state.queue.push({ phone, status:'pending', prenom:prenom.trim(), nom:nom.trim(), message:row.message||defaultMessage, link:row.link||defaultLink||'', addedAt:new Date().toISOString() });
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
    const pendingList = this.state.queue.filter(c => c.status === 'pending');
    let pendingWhatsAppMessages = 0;
    let pendingWithDoubleMessage = 0;
    for (const c of pendingList) {
      const mc = countOutboundMessages(
        personalizeMessage((c.message || '').trim() || process.env.DEFAULT_MESSAGE || '', c),
        personalizeMessage((c.link || '').trim(), c)
      );
      pendingWhatsAppMessages += mc;
      if (mc >= 2) pendingWithDoubleMessage++;
    }
    this._pruneSendTimestamps();
    return {
      id:this.id, ready:this.state.ready, qr:this.state.qr,
      running:this.state.running, paused:this.state.paused,
      stats:this.state.stats,
      pending:    pendingList.length,
      pendingWhatsAppMessages,
      pendingWithDoubleMessage,
      estimatedQueueSec: this._estimateQueueSeconds(),
      messagesAvailable: this._messagesAvailable(),
      hourlySent: this.state.sendTimestamps.length,
      maxMessagesPerHour: config.maxMessagesPerHour,
      relayed:    this.state.queue.filter(c=>c.status==='relayed').length,
      replied:    this.state.queue.filter(c=>c.replied===true).length,
      blacklisted:this.state.queue.filter(c=>c.status==='blacklisted').length,
      total:      this.state.queue.length,
      sessionCount:this.state.sessionCount,
      dailySent:this.state.dailySent, dailyLimit:this.dailyLimit,
      quotaCountsMessages: true,
      quotaAsContacts: config.quotaAsContacts !== false,
      limitReached:this.state.limitReached, limitReachedAt:this.state.limitReachedAt,
      resumeAt:this.state.resumeAt, windowStart:this.state.windowStart, resetInMs,
      autoResume:config.autoResume, bannedAt:this.state.bannedAt,
      repliesReceived:this.state.repliesReceived,
      scheduledAt:schedules[this.id]?.scheduledAt||null,
      minDelay:config.minDelay, maxDelay:config.maxDelay, sessionSize:config.sessionSize,
      sessionPauseMin:config.sessionPauseMin, sessionPauseMax:config.sessionPauseMax,
      typingMin:config.typingMin,             typingMax:config.typingMax,
      linkDelayMin:config.linkDelayMin,       linkDelayMax:config.linkDelayMax,
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
    this._saveQueue(true); this.log('🔄 Queue réinitialisée','warn');
  }

  clear() {
    this.state.queue=[]; this.state.stats={sent:0,failed:0,skipped:0,blacklisted:0};
    this.state.sessionCount=0; this.state.dailySent=0;
    this.state.windowStart=null; this.state.limitReached=false;
    this.state.limitReachedAt=null; this.state.resumeAt=null; this.state.bannedAt=null;
    if(this._resumeTimer){clearTimeout(this._resumeTimer);this._resumeTimer=null;}
    this._saveQueue(true); this.log('🗑️ Queue vidée','warn');
  }

  clearLogs() {
    this.state.log = [];
    saveLogs(this.id, []);
    console.log(`[BOT${this.id}] Logs effacés`);
  }
}

// ─── Deux comptes ─────────────────────────────────────────────────────────────
const bots={1:new BotAccount(1),2:new BotAccount(2)};

bots[1]._partner = bots[2];
bots[2]._partner = bots[1];

function getBot(req) {
  const id = parseInt(req.params.account || req.query.account || '');
  return (!isNaN(id) && bots[id]) ? bots[id] : null;
}
function requireBot(req, res) {
  const bot = getBot(req);
  if (!bot) { res.status(404).json({ ok: false, error: `Compte invalide. Comptes disponibles : ${Object.keys(bots).join(', ')}` }); return null; }
  return bot;
}
function otherBot(bot){return bot.id===1?bots[2]:bots[1];}

// ─── Routes API ───────────────────────────────────────────────────────────────
app.get('/api/:account/status', (req,res)=>{ const b=requireBot(req,res); if(!b) return; res.json(b.getStatus()); });
app.post('/api/:account/start', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  if(!b.state.ready) return res.status(400).json({ok:false,error:'WhatsApp non connecté — onglet Connexion, scannez le QR code'});
  const pending = b.state.queue.filter(c => c.status === 'pending').length;
  if (!pending) return res.status(400).json({ok:false,error:'Aucun contact en attente — importez un CSV d’abord'});
  if (b._dailyLimitReached()) {
    return res.status(400).json({
      ok:false,
      error:`Quota atteint (${b.state.dailySent}/${b.dailyLimit} messages WA). Attendez le reset ou augmentez la limite.`,
      limitReached:true
    });
  }
  b.state.paused=false; b.state.limitReached=false; b.state.bannedAt=null;
  cancelSchedule(b.id);
  b.runQueue(otherBot(b));
  res.json({ok:true, pending, dailySent:b.state.dailySent, dailyLimit:b.dailyLimit});
});
// FIX : pause annule aussi le planning si actif (cohérence avec clear/reset)
app.post('/api/:account/pause', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  b.state.paused=!b.state.paused;
  if (b.state.paused) {
    cancelSchedule(b.id);
    b.state.running = false;
    b._resetStuckContacts();
  }
  b.log(b.state.paused?'⏸️ Pause (planning annulé si actif)':'▶️ Reprise','warn');
  res.json({ok:true,paused:b.state.paused});
});

app.post('/api/:account/unstick', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  b.state.running = false;
  b._queueLoopActive = false;
  const fixed = b._resetStuckContacts();
  b.log('🔧 Queue débloquée manuellement', 'warn');
  res.json({ok:true, fixed});
});
app.post('/api/:account/clear', (req,res)=>{ const b=requireBot(req,res); if(!b) return; cancelSchedule(b.id); b.clear(); res.json({ok:true}); });
app.post('/api/:account/reset', (req,res)=>{ const b=requireBot(req,res); if(!b) return; cancelSchedule(b.id); b.reset(); res.json({ok:true}); });

app.post('/api/:account/set-limit', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  const limit=parseInt(req.body.limit);
  if(!limit||limit<1||limit>1000) return res.status(400).json({ok:false,error:'Limite invalide (1-1000)'});
  dailyLimitMap[b.id]=limit; saveConfig();
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

app.delete('/api/:account/logs', (req,res)=>{ const b=requireBot(req,res); if(!b) return; b.clearLogs(); res.json({ok:true}); });

app.get('/api/stats', (req,res)=>{
  const sessions=loadSessions();
  const totalSent=sessions.reduce((s,x)=>s+(x.sent||0),0);
  const totalSkipped=sessions.reduce((s,x)=>s+(x.skipped||0),0);
  const totalFailed=sessions.reduce((s,x)=>s+(x.failed||0),0);
  const total=totalSent+totalSkipped+totalFailed;
  const deliveryRate=total>0?Math.round(totalSent/total*100):0;
  const skipRate=total>0?Math.round(totalSkipped/total*100):0;
  const last30=sessions.slice(-30).map(s=>({date:s.date,botId:s.botId,sent:s.sent||0,skipped:s.skipped||0,failed:s.failed||0,duration:s.duration||0}));
  const totalReplies=Object.values(bots).reduce((sum,b)=>sum+(b.state.repliesReceived||0),0);
  const byAccount={};
  for(const s of sessions){
    const id=s.botId||1;
    if(!byAccount[id]) byAccount[id]={account:id,sent:0,failed:0,skipped:0,replies:0};
    byAccount[id].sent+=s.sent||0; byAccount[id].failed+=s.failed||0; byAccount[id].skipped+=s.skipped||0;
  }
  for(const b of Object.values(bots)){
    if(!byAccount[b.id]) byAccount[b.id]={account:b.id,sent:0,failed:0,skipped:0,replies:0};
    byAccount[b.id].replies=b.state.repliesReceived||0;
  }
  res.json({ totalSent,totalSkipped,totalFailed,total,deliveryRate,skipRate,totalReplies,totalSessions:sessions.length,sessions:last30,accounts:Object.values(byAccount).sort((a,b)=>a.account-b.account) });
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
  let forceInclude;
  try { forceInclude = JSON.parse(req.body.forceInclude||'[]'); }
  catch(_) { forceInclude = []; }
  let result;
  try {
    const content=fs.readFileSync(req.file.path,'utf-8');
    const message=(req.body.message||'').trim();
    const link=(req.body.link||'').trim();
    if(!message && !link) return res.status(400).json({ok:false,error:'Message ou lien requis'});
    result=bot.importCSV(content,message,link,forceInclude);
  } catch(e){
    return res.status(400).json({ok:false,error:e.message});
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
  if(result.duplicates.length>0 && forceInclude.length===0)
    res.json({ok:true,...result,needsConfirmation:true});
  else
    res.json({ok:true,...result,needsConfirmation:false});
});

app.delete('/api/:account/queue/:phone', (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  res.json({ok:true,removed:bot.removeContact(req.params.phone)});
});

app.get('/api/sent-history', (req,res)=>{
  const hist = loadSentHistory();
  let list = Object.entries(hist)
    .map(([phone, raw]) => enrichHistoryEntry(phone, raw))
    .filter(Boolean);
  list.sort((a, b) => new Date(b.lastSentAt || 0) - new Date(a.lastSentAt || 0));
  const { page = 1, limit = 100, q = '', minCount = 0 } = req.query;
  const perPage = Math.min(Math.max(parseInt(limit) || 100, 1), 50000);
  const qLower = String(q).toLowerCase();
  let filtered = list;
  if (qLower) {
    filtered = filtered.filter(x =>
      x.phone.includes(q) ||
      (x.prenom || '').toLowerCase().includes(qLower) ||
      (x.nom || '').toLowerCase().includes(qLower) ||
      (x.lastMessage || '').toLowerCase().includes(qLower) ||
      String(x.lastBotId || '').includes(q)
    );
  }
  const min = parseInt(minCount) || 0;
  if (min > 1) filtered = filtered.filter(x => x.contactCount >= min);
  const start = (parseInt(page) - 1) * perPage;
  res.json({ total: filtered.length, items: filtered.slice(start, start + perPage) });
});
app.delete('/api/sent-history/:phone',(req,res)=>{ removeFromSentHistory(req.params.phone); res.json({ok:true}); });
app.delete('/api/sent-history',       (req,res)=>{ saveSentHistory({}); res.json({ok:true}); });

app.get('/api/blacklist',(req,res)=>res.json({list:loadBlacklist()}));
app.post('/api/blacklist/add', (req,res)=>{
  const phone=(req.body.phone||'').replace(/\D/g,'');
  if(!phone||phone.length<8) return res.status(400).json({ok:false,error:'Numéro invalide'});
  const list=loadBlacklist();
  if(!list.some(p=>p.replace(/\D/g,'')=== phone)){list.push(phone);saveBlacklist(list);}
  res.json({ok:true,phone,total:list.length});
});
app.post('/api/blacklist/remove', (req,res)=>{
  const phone=(req.body.phone||'').replace(/\D/g,'');
  saveBlacklist(loadBlacklist().filter(p=>p.replace(/\D/g,'')!==phone));
  res.json({ok:true,total:loadBlacklist().length});
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
      if(phone&&phone.length>=8&&!list.some(p=>p.replace(/\D/g,'')=== phone)){list.push(phone);added++;}
    }
    saveBlacklist(list); total=list.length;
  } catch(e){
    return res.status(400).json({ok:false,error:e.message});
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
  res.json({ok:true,added,total});
});

app.get('/api/config',(req,res)=>res.json({ ...config, dailyLimit: { ..._dailyLimitOverrides } }));

app.post('/api/config', (req, res) => {
  const errors = [];
  const setInt = (key, min, max) => {
    if (req.body[key] === undefined) return;
    const v = parseInt(req.body[key]);
    if (isNaN(v) || v < min || v > max)
      errors.push(`${key} doit être un entier entre ${min} et ${max}`);
    else
      config[key] = v;
  };
  setInt('minDelay',        10,    3600);
  setInt('maxDelay',        10,    3600);
  setInt('sessionSize',      1,     100);
  setInt('sessionPauseMin', 60,    7200);
  setInt('sessionPauseMax', 60,    7200);
  setInt('typingMin',      500,   30000);
  setInt('typingMax',      500,   30000);
  setInt('linkDelayMin',  1000,   60000);
  setInt('linkDelayMax',  1000,   60000);
  setInt('maxMessagesPerHour', 5, 200);
  if (config.minDelay        > config.maxDelay)        errors.push('minDelay doit être ≤ maxDelay');
  if (config.sessionPauseMin > config.sessionPauseMax) errors.push('sessionPauseMin doit être ≤ sessionPauseMax');
  if (config.typingMin       > config.typingMax)       errors.push('typingMin doit être ≤ typingMax');
  if (config.linkDelayMin    > config.linkDelayMax)    errors.push('linkDelayMin doit être ≤ linkDelayMax');
  if (errors.length > 0) return res.status(400).json({ ok: false, errors });
  if (req.body.autoResume !== undefined) config.autoResume = Boolean(req.body.autoResume);
  if (req.body.quotaAsContacts !== undefined) config.quotaAsContacts = Boolean(req.body.quotaAsContacts);
  saveConfig();
  res.json({ ok: true, config });
});

app.get('/api/:account/groups', async (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  if(!bot.state.ready) return res.json([]);
  try {
    const chats=await bot.client.getChats();
    res.json(chats.filter(c=>c.isGroup).map(c=>({name:c.name,count:c.participants?.length||0})));
  } catch(e) {
    console.error(`[BOT${bot.id}] getChats erreur :`, e.message);
    res.status(500).json({ok:false,error:'Erreur récupération groupes : ' + e.message});
  }
});

// FIX : export-group en streaming CSV pour éviter le timeout HTTP sur les grands groupes
app.get('/api/:account/export-group/:name', async (req, res) => {
  const bot = requireBot(req, res); if (!bot) return;
  if (!bot.state.ready) return res.status(400).json({ ok: false, error: 'Non connecté' });

  let chats;
  try {
    chats = await bot.client.getChats();
  } catch(e) {
    return res.status(500).json({ ok: false, error: 'Erreur récupération groupes : ' + e.message });
  }

  const groupName = decodeURIComponent(req.params.name);
  const group     = chats.find(c => c.isGroup && c.name === groupName);
  if (!group) return res.status(404).json({ ok: false, error: 'Groupe introuvable' });

  const participants = group.participants || [];
  const total        = participants.length;

  console.log(`[export-group] 📤 "${groupName}" — ${total} participants`);

  // Streaming : envoyer les headers immédiatement pour éviter le timeout navigateur
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(groupName)}.csv"`);
  res.write('telephone,prenom,nom,admin\n');

  for (let i = 0; i < participants.length; i++) {
    if (res.writableEnded) {
      console.log(`[export-group] ⚠️ Connexion client fermée à ${i}/${total}, export annulé`);
      return;
    }
    const p = participants[i];
    if (i > 0 && i % 25 === 0) console.log(`[export-group] ⏳ ${i}/${total} traités...`);
    const { prenom, nom } = await getContactName(bot.client, p.id.user);
    // Échapper les virgules/guillemets pour le CSV
    const esc = v => `"${(v||'').replace(/"/g,'""')}"`;
    res.write(`+${p.id.user},${esc(prenom)},${esc(nom)},${p.isAdmin?'Oui':'Non'}\n`);
    if (i < participants.length - 1) await sleep(EXPORT_GROUP_INTER_DELAY_MS);
  }

  console.log(`[export-group] ✅ ${total} contacts exportés`);
  res.end();
});

// ─── Routes legacy (Compte 1 uniquement) ─────────────────────────────────────
app.get('/api/status',(req,res)=>res.json(bots[1].getStatus()));
app.post('/api/start',(req,res)=>{
  if(!bots[1].state.ready) return res.status(400).json({ok:false,error:'Non connecté'});
  bots[1].state.paused=false; bots[1].state.limitReached=false; bots[1].state.bannedAt=null;
  cancelSchedule(bots[1].id);
  bots[1].runQueue(bots[2]); res.json({ok:true});
});
// FIX : pause legacy annule aussi le planning si actif
app.post('/api/pause',(req,res)=>{
  bots[1].state.paused=!bots[1].state.paused;
  if (bots[1].state.paused) cancelSchedule(bots[1].id);
  bots[1].log(bots[1].state.paused?'⏸️ Pause (planning annulé si actif)':'▶️ Reprise','warn');
  res.json({ok:true,paused:bots[1].state.paused});
});
app.post('/api/clear',(req,res)=>{
  cancelSchedule(bots[1].id);
  bots[1].clear(); res.json({ok:true});
});
app.post('/api/reset',(req,res)=>{
  cancelSchedule(bots[1].id);
  bots[1].reset(); res.json({ok:true});
});
app.get('/api/groups',async(req,res)=>{
  if(!bots[1].state.ready) return res.json([]);
  try {
    const c=await bots[1].client.getChats();
    res.json(c.filter(x=>x.isGroup).map(x=>({name:x.name,count:x.participants?.length||0})));
  } catch(e) {
    res.status(500).json({ok:false,error:'Erreur récupération groupes : ' + e.message});
  }
});

app.listen(PORT,()=>console.log(`WhatsApp Manager → http://localhost:${PORT}`));
