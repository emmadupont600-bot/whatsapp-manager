const { Client, LocalAuth } = require('whatsapp-web.js');
const { MessageAck } = require('whatsapp-web.js/src/util/Constants');
const qrcode   = require('qrcode');
const express  = require('express');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const csv      = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const ai = require('./lib/ai');
const { isPositiveReply, isNegativeReply, isPositiveReaction, classifyOptInReply } = require('./lib/replies');

process.on('unhandledRejection', (reason) => console.error('[FATAL] Unhandled rejection:', reason));
process.on('uncaughtException',  (err)    => console.error('[FATAL] Uncaught exception:',  err));

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = require('./package.json').version || '1.0.0';
const BUILD_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA || 'dev').slice(0, 12);

function getAuthBase() {
  return process.env.AUTH_PATH || __dirname;
}

function resolveChromiumPath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
}

function ensureDataDirs() {
  const base = getAuthBase();
  for (const d of [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'exports'),
    path.join(base, '.wwebjs_auth'),
    path.join(base, '.wwebjs_cache'),
  ]) {
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {
      console.error(`[BOOT] mkdir ${d}: ${e.message}`);
    }
  }
}

function parseEnabledAccounts() {
  const v = (process.env.ENABLED_ACCOUNTS || '1,2').trim();
  const ids = new Set();
  for (const part of v.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (n === 1 || n === 2) ids.add(n);
  }
  return ids.size ? ids : new Set([1, 2]);
}
const ENABLED_ACCOUNTS = parseEnabledAccounts();
const CHROMIUM_PATH = resolveChromiumPath();
ensureDataDirs();

function parseResetAuthOnStart() {
  const v = (process.env.RESET_AUTH || '').trim();
  if (!v || v === '0' || v === 'false') return new Set();
  if (v === '1' || v === 'true' || v === 'all') return new Set([1, 2]);
  const ids = new Set();
  for (const part of v.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (n === 1 || n === 2) ids.add(n);
  }
  return ids;
}
const RESET_AUTH_ON_START = parseResetAuthOnStart();
const WA_WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1038602566-alpha';
const WA_WEB_CACHE_REMOTE = process.env.WA_WEB_CACHE_REMOTE || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';
const READY_PROBE_DELAY_MS = parseInt(process.env.READY_PROBE_DELAY_MS || '20000', 10);
const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);
const REQUIRE_ACK_DEVICE = process.env.REQUIRE_ACK_DEVICE === '1';
const MANUAL_SEARCH_FLOW = process.env.MANUAL_SEARCH_FLOW !== '0';
const COLD_OPENER_DELAY_MS = parseInt(process.env.COLD_OPENER_DELAY_MS || '8000', 10);

function getColdOpenerText() {
  if (process.env.COLD_OPENER_MESSAGE === '0') return '';
  return (process.env.COLD_OPENER_MESSAGE || 'Hey').trim();
}

function useUiSendAll() {
  return process.env.UI_SEND_ALL !== '0';
}

function useAckColdSoft() {
  return process.env.ACK_COLD_SOFT === '1';
}


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const MAX_AGE_MS   = 60 * 60 * 1000;

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

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
function authMiddleware(req, res, next) {
  if (req.path === '/ping' || req.path === '/health') return next();
  if (!AUTH_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query  = typeof req.query.token === 'string' ? req.query.token : '';
  if (bearer === AUTH_TOKEN || query === AUTH_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Non autorisé. Token Bearer requis (Paramètres dashboard ou ?token=).' });
}
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), commit: BUILD_COMMIT, version: APP_VERSION, bots: Object.keys(bots) });
});
app.use('/api', authMiddleware);

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
  if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ ok: false, error: 'Trop de requêtes. Réessayez dans une minute.' });
  next();
}
app.use('/api', rateLimitMiddleware);

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
    try { fs.writeFileSync(SENT_HISTORY_FILE, JSON.stringify(_sentHistoryCache, null, 2)); }
    catch(e) { console.error('[SENT-HISTORY] Erreur écriture :', e.message); }
  }, SENT_HISTORY_FLUSH_MS);
}
function loadSentHistory() { return _getSentHistoryCache(); }
function saveSentHistory(hist) { _sentHistoryCache = hist; _flushSentHistory(); }

function normalizeHistoryEntry(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.contacts) && raw.contacts.length) return raw;
  if (raw.sentAt || raw.message) {
    return { prenom: raw.prenom || '', nom: raw.nom || '', contacts: [{ sentAt: raw.sentAt || new Date().toISOString(), botId: raw.botId, message: (raw.message || '').substring(0, 500), link: raw.link || '' }] };
  }
  return { prenom: raw.prenom || '', nom: raw.nom || '', contacts: [] };
}
function enrichHistoryEntry(phone, raw) {
  const entry = normalizeHistoryEntry(raw);
  if (!entry) return null;
  const contacts = [...entry.contacts].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
  const last = contacts[0] || {};
  return { phone, prenom: entry.prenom, nom: entry.nom, contactCount: contacts.length, lastSentAt: last.sentAt || null, lastMessage: last.message || '', lastLink: last.link || '', lastBotId: last.botId, contacts };
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
  entry.contacts.push({ sentAt: data.sentAt || new Date().toISOString(), botId: data.botId, message: (data.message || '').substring(0, 500), link: (data.link || '').substring(0, 300) });
  hist[clean] = entry;
  _flushSentHistory();
}
function isAlreadySent(phone, cachedHist) { return getHistoryEntry(phone, cachedHist); }
function removeFromSentHistory(phone) { const hist = _getSentHistoryCache(); delete hist[phone.replace(/\D/g,'')]; _flushSentHistory(); }

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

function getClientPhone(client) {
  try {
    const w = client?.info?.wid;
    if (w && w.user) return String(w.user).replace(/\D/g, '');
    if (typeof w === 'string') return w.replace(/\D/g, '');
  } catch (_) {}
  return null;
}

function isPuppeteerNavigationError(msg) {
  return /execution context was destroyed|most likely because of a navigation|target closed|session closed|Protocol error/i.test(msg || '');
}


function whatsappMsgId(msg) {
  if (!msg || !msg.id) return null;
  return msg.id._serialized || msg.id.id || (typeof msg.id === 'string' ? msg.id : null);
}

const URL_RE = /(https?:\/\/[^\s]+)/i;
const QR_WATCHDOG_MS = parseInt(process.env.QR_WATCHDOG_MS || '120000', 10);

/** Texte et lien toujours séparés — le lien part après opt-in (réponse positive). */
function prepareOutboundContent(rawMsg, link) {
  const text = (rawMsg || '').trim();
  const lnk = (link || '').trim();
  return { rawMsg: text, link: lnk, combined: false };
}

function splitMessageAndLink(msg) {
  const match = msg.match(URL_RE);
  if (!match) return null;
  const url    = match[1];
  const before = msg.slice(0, match.index).trim();
  const after  = msg.slice(match.index + url.length).trim();
  return { text: [before, after].filter(Boolean).join('\n').trim(), url };
}

function countOutboundMessages(rawMsg) {
  return (rawMsg || '').trim() ? 1 : 0;
}

function personalizeMessage(template, contact = {}) {
  if (!template) return template;
  const c = contact || {};
  return template
    .replace(/\{pr[eé]nom\}/gi, c.prenom || c.nom || '')
    .replace(/\{nom\}/gi,       c.nom    || c.prenom || '')
    .replace(/\{name\}/gi,      c.prenom || c.nom || '')
    .replace(/\{phone\}/gi,     c.phone  || '')
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

// ─── rmrf : supprime récursivement un dossier ─────────────────────────────────
function rmrf(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) rmrf(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(dirPath);
  } catch(e) { console.error(`[rmrf] Erreur sur ${dirPath} : ${e.message}`); }
}

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms : ${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
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

async function safeIsRegisteredUser(client, chatId, logger) {
  try {
    return await withTimeout(client.isRegisteredUser(chatId), 8000, `isRegisteredUser(${chatId})`);
  } catch(e) {
    if (logger) logger(`⚠️ isRegisteredUser échoué pour ${chatId} (${e.message}) — on tente l'envoi quand même`, 'warn');
    return true;
  }
}

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

function idsLookDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = (a || '').replace(/@.*$/, '');
  const nb = (b || '').replace(/@.*$/, '');
  if (na === nb) return true;
  if (na.length > 12 && nb.length > 12 && na.slice(0, 16) === nb.slice(0, 16)) return true;
  return false;
}

function assertDistinctMessageIds(ids) {
  if (ids.length < 2) return;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (idsLookDuplicate(ids[i], ids[j])) {
        throw new Error('Session fantôme : même ID WhatsApp pour deux messages distincts — arrêt. Reset Auth + rescannez le QR. Si le numéro a été restreint hier, attendez 24–48h ou utilisez le compte 2.');
      }
    }
  }
}

function minAckRequired() {
  return REQUIRE_ACK_DEVICE ? MessageAck.ACK_DEVICE : MessageAck.ACK_SERVER;
}

function resolveAckLevel(ack, label) {
  if (ack === undefined || ack === null) return null;
  if (ack === MessageAck.ACK_ERROR) {
    throw new Error(`WhatsApp a rejeté le message (${label}) — compte peut-être restreint / signalé`);
  }
  return ack >= minAckRequired() ? ack : null;
}

async function getMessageAckFromStore(client, msgId) {
  const page = client.pupPage;
  if (!page || !msgId) return null;
  try {
    const ack = await withTimeout(
      page.evaluate(async (id) => {
        try {
          const Coll = window.require('WAWebCollections');
          let msg = Coll?.Msg?.get?.(id);
          if (!msg && Coll?.Msg?.getMessagesById) {
            const batch = await Coll.Msg.getMessagesById([id]).catch(() => null);
            msg = batch?.messages?.[0];
          }
          if (!msg) return null;
          return typeof msg.ack === 'number' ? msg.ack : null;
        } catch (_) {
          return null;
        }
      }, msgId),
      6000,
      'getMessageAckFromStore'
    );
    return typeof ack === 'number' ? ack : null;
  } catch (_) {
    return null;
  }
}

async function waitForMessageAck(client, msgId, label, preAck = null) {
  if (!msgId || msgId === 'verified-no-id') return MessageAck.ACK_SERVER;

  let level = resolveAckLevel(preAck, label);
  if (level !== null) return level;

  const storeAck = await getMessageAckFromStore(client, msgId);
  level = resolveAckLevel(storeAck, label);
  if (level !== null) return level;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener('message_ack', onAck);
      reject(new Error(`Timeout accusé réception WhatsApp (${label}) — message peut-être bloqué ou session fantôme`));
    }, MSG_ACK_TIMEOUT_MS);
    const onAck = (msg, ack) => {
      const id = whatsappMsgId(msg);
      if (id !== msgId) return;
      if (ack === MessageAck.ACK_ERROR) {
        clearTimeout(timer);
        client.removeListener('message_ack', onAck);
        reject(new Error(`WhatsApp a rejeté le message (${label}) — compte peut-être restreint / signalé`));
      }
      if (ack >= minAckRequired()) {
        clearTimeout(timer);
        client.removeListener('message_ack', onAck);
        resolve(ack);
      }
    };
    client.on('message_ack', onAck);
  });
}

function isWhatsAppFetchBug(err) {
  const m = (err && err.message) || String(err);
  return /waitForChatLoading|loadEarlierMsgs/i.test(m);
}

function isMessageRejectedError(err) {
  const m = (err && err.message) || String(err);
  return /rejet[eé]|ACK_ERROR/i.test(m);
}

function isGhostSessionError(err) {
  const m = (err && err.message) || String(err);
  return /session fant[oô]me|identiques|silencieux/i.test(m);
}

function messageAckIsDelivered(ack) {
  if (ack === undefined || ack === null) return null;
  if (ack === MessageAck.ACK_ERROR) return false;
  return ack >= MessageAck.ACK_SERVER;
}

async function verifyMessageInChat(chat, text, msgId, label, opts = {}) {
  const { softFail = false, logger = null, maxAgeMs = 45000, strict = true } = opts;
  await sleep(2500);
  let messages;
  try {
    messages = await withTimeout(chat.fetchMessages({ limit: 25 }), 12000, `fetchMessages verify ${label}`);
  } catch (e) {
    if (isWhatsAppFetchBug(e) && softFail) {
      if (logger) logger(`⚠️ Vérification historique ignorée (${label}) : bug fetchMessages WhatsApp Web`, 'warn');
      return false;
    }
    throw e;
  }
  const now = Date.now();
  const recent = messages.filter(m => m.fromMe && (now - m.timestamp * 1000) < maxAgeMs);
  const trimmed = (text || '').trim();

  const checkAck = (m) => {
    const delivered = messageAckIsDelivered(m.ack);
    if (delivered === false) {
      throw new Error(`Message "${label}" rejeté par WhatsApp (ACK_ERROR) — non livré sur le téléphone du destinataire`);
    }
    return m;
  };

  if (msgId && msgId !== 'verified-no-id' && msgId !== 'ui-sent') {
    const byId = recent.filter(m => whatsappMsgId(m) === msgId);
    if (byId.length) {
      checkAck(byId.sort((a, b) => b.timestamp - a.timestamp)[0]);
      return true;
    }
  }

  if (!trimmed) throw new Error(`Message "${label}" corps vide — vérification impossible`);

  const byBody = recent.filter(m => (m.body || '').trim() === trimmed);
  if (!byBody.length) {
    throw new Error(`Message "${label}" absent du chat récent — non livré (session fantôme ou mauvais fil)`);
  }
  const newest = byBody.sort((a, b) => b.timestamp - a.timestamp)[0];
  const latestFromMe = recent.sort((a, b) => b.timestamp - a.timestamp)[0];
  if (strict && latestFromMe && whatsappMsgId(latestFromMe) !== whatsappMsgId(newest)) {
    throw new Error(`Message "${label}" n'est pas le dernier envoyé — vérification refusée`);
  }
  checkAck(newest);
  if (logger) logger(`✔️ Vérifié dans le chat (${label}, ${Math.round((now - newest.timestamp * 1000) / 1000)}s)`, 'info');
  return true;
}


function normalizeOutboundChatId(_chatId, phoneDigits) {
  return phoneToCusChatId(phoneDigits);
}

function phoneHadSuccessfulSend(phone) {
  const entry = getHistoryEntry(phone);
  return !!(entry && entry.contacts && entry.contacts.length > 0);
}

function shouldUseManualOpener(phoneDigits, isColdContact) {
  if (process.env.COLD_OPENER_MESSAGE === '0') return false;
  if (process.env.OPENER_SKIP_IF_SENT === '1' && phoneHadSuccessfulSend(phoneDigits)) return false;
  return true;
}

function phoneToCusChatId(number) {
  const pn = String(number).replace(/\D/g, '');
  if (!pn || pn.length < 8) throw new Error(`Numéro invalide : ${number}`);
  return `${pn}@c.us`;
}



async function openChatViaStore(client, phoneDigits, logger) {
  const page = client.pupPage;
  if (!page) return false;
  const phone = String(phoneDigits).replace(/\D/g, '');
  try {
    const ok = await withTimeout(page.evaluate(async (ph) => {
      try {
        const WidFactory = window.require('WAWebWidFactory');
        const Cmd = window.require('WAWebCmd');
        const FindChat = window.require('WAWebFindChatAction');
        const Collections = window.require('WAWebCollections');
        const cusWid = WidFactory.createWid(ph + '@c.us');
        if (Cmd?.openChatAt) await Cmd.openChatAt(cusWid);
        let chat = Collections.Chat.get(cusWid);
        if (!chat && FindChat?.findOrCreateLatestChat) {
          chat = (await FindChat.findOrCreateLatestChat(cusWid).catch(() => null))?.chat;
        }
        const Open = window.require('WAWebOpenChatAction') || window.require('WAWebChatAction');
        if (chat && Open?.openChatBottom) await Open.openChatBottom(chat);
        return !!chat || !!Cmd?.openChatAt;
      } catch (e) {
        return false;
      }
    }, phone), 15000, 'openChatViaStore');
    if (ok && logger) logger(`🔍 Chat ouvert (API WAWebCmd / @c.us)`, 'info');
    return !!ok;
  } catch (e) {
    if (logger) logger(`⚠️ openChatViaStore : ${e.message}`, 'warn');
    return false;
  }
}


async function sendTextViaWhatsAppStore(client, phoneDigits, text, logger, label) {
  const page = client.pupPage;
  if (!page || process.env.STORE_SEND === '0') return null;
  const phone = String(phoneDigits).replace(/\D/g, '');
  const body = (text || '').trim();
  const cusChatId = phoneToCusChatId(phone);
  if (!body) return null;

  const result = await withTimeout(
    page.evaluate(async (chatId, msg) => {
      try {
        if (!window.WWebJS?.sendMessage) {
          return { ok: false, err: 'wwebjs_not_injected' };
        }
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) return { ok: false, err: 'no_chat' };

        const sent = await window.WWebJS.sendMessage(chat, msg, { waitUntilMsgSent: true });
        const id =
          sent?.id?._serialized ||
          sent?.id?.id ||
          (typeof sent?.id === 'string' ? sent.id : null);
        const ack = typeof sent?.ack === 'number' ? sent.ack : null;
        return { ok: !!id, id, ack, via: 'WWebJS.sendMessage' };
      } catch (e) {
        return { ok: false, err: e.message || String(e) };
      }
    }, cusChatId, body),
    45000,
    'WWebJS.sendMessage'
  );

  if (!result?.ok || !result.id) {
    if (logger) logger(`⚠️ WWebJS.sendMessage (${label}) : ${result?.err || 'pas d\'id'}`, 'warn');
    return null;
  }
  if (logger) {
    const ackNote = typeof result.ack === 'number' ? ` · ack=${result.ack}` : '';
    logger(`📤 Envoyé via ${result.via} (${label})${ackNote}`, 'info');
  }
  return { id: result.id, viaStore: true, ack: result.ack ?? null };
}


function isHeyLikeLabel(label) {
  return /hey|opener/i.test(label || '');
}

async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {
  const page = client.pupPage;
  if (!page) return false;
  try {
    await page.waitForSelector('footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]', { timeout: 15000 });
  } catch (_) {}
  const selectors = [
    'footer div[contenteditable="true"][data-tab="10"]',
    '#main footer div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-tab="10"]',
    '#main div[contenteditable="true"][data-tab="10"]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.click();
      await page.evaluate((s, selector) => {
        const box = document.querySelector(selector);
        if (!box) return;
        box.focus();
        box.textContent = '';
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, text, sel);
      await page.keyboard.type(text, { delay: 35 });
      await sleep(400);
      await page.keyboard.press('Enter');
      if (logger) logger(`⌨️ Saisie UI (${label}) — vérification livraison...`, 'info');
      await sleep(3500);
      try {
        const chat = await withTimeout(client.getChatById(cusChatId), 12000, 'verify UI send');
        await verifyMessageInChat(chat, text, null, label, { strict: !isHeyLikeLabel(label), maxAgeMs: 60000, logger });
        if (logger) logger(`✔️ Message UI confirmé dans le chat (${label})`, 'info');
        return true;
      } catch (verr) {
        if (logger) logger(`❌ UI composer : pas confirmé dans le chat — ${verr.message}`, 'error');
        return false;
      }
    } catch (e) {
      if (logger) logger(`⚠️ UI composer (${sel}) : ${e.message}`, 'warn');
    }
  }
  return false;
}

async function openChatViaSearchUI(client, phoneDigits, logger) {
  const page = client.pupPage;
  if (!page) return false;
  const phone = String(phoneDigits).replace(/\D/g, '');
  const query = `+${phone}`;

  if (await openChatViaStore(client, phoneDigits, logger)) return true;

  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await sleep(600);
  } catch (_) {}

  const findSearch = async () => {
    return page.evaluate(() => {
      const side = document.querySelector('#side') || document.querySelector('#pane-side');
      if (side) {
        const boxes = [...side.querySelectorAll('[contenteditable="true"]')];
        if (boxes.length) return true;
      }
      return !!document.querySelector('div[contenteditable="true"][data-tab="3"]');
    });
  };

  const typeInSearch = async () => {
    return page.evaluate((q) => {
      const pick = () => {
        const side = document.querySelector('#side') || document.querySelector('#pane-side');
        if (side) {
          const boxes = [...side.querySelectorAll('[contenteditable="true"]')];
          if (boxes[0]) return boxes[0];
        }
        return document.querySelector('div[contenteditable="true"][data-tab="3"]')
          || document.querySelector('[title*="Search" i][contenteditable="true"]')
          || document.querySelector('[aria-label*="Search" i][contenteditable="true"]')
          || document.querySelector('[aria-label*="Recherch" i][contenteditable="true"]');
      };
      const input = pick();
      if (!input) return { ok: false, err: 'no_input' };
      input.focus();
      input.textContent = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const dt = new DataTransfer();
      dt.setData('text', q);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return { ok: true };
    }, query);
  };

  if (!(await findSearch())) {
    if (logger) logger('⚠️ Panneau recherche introuvable (headless)', 'warn');
    return false;
  }

  try {
    const typed = await typeInSearch();
    if (!typed.ok) {
      if (logger) logger(`⚠️ Recherche UI : ${typed.err}`, 'warn');
      return false;
    }
    await sleep(2500);
    const clicked = await page.evaluate((q) => {
      const norm = (s) => (s || '').replace(/\D/g, '');
      const qn = norm(q);
      const click = (el) => { if (el) { el.click(); return true; } return false; };
      for (const el of document.querySelectorAll('div[role="button"], button, span')) {
        const t = (el.textContent || '').trim();
        if (/^(discuter|message|discuss)$/i.test(t) || /discuter avec/i.test(t)) {
          if (click(el)) return 'discuss';
        }
      }
      for (const row of document.querySelectorAll('[data-testid="cell-frame-container"], div[role="listitem"]')) {
        const txt = norm(row.textContent || '');
        if (txt.includes(qn) || txt.includes(qn.slice(-9))) {
          if (click(row)) return 'row';
        }
      }
      const first = document.querySelector('[data-testid="cell-frame-container"]');
      if (click(first)) return 'first_row';
      return null;
    }, query);
    if (clicked) {
      if (logger) logger(`🔍 Chat ouvert via barre de recherche (${clicked})`, 'info');
      await sleep(1200);
      return true;
    }
    if (logger) logger('⚠️ Recherche : aucun résultat cliquable', 'warn');
  } catch (e) {
    if (logger) logger(`⚠️ Recherche UI : ${e.message}`, 'warn');
  }
  return false;
}

async function prepareOutboundChat(client, phoneDigits, logger) {
  const cusId = phoneToCusChatId(phoneDigits);
  let chat = null;
  let chatId = cusId;
  let isColdContact = false;
  let isKnownContact = false;

  if (!client.pupPage) {
    return { chatId, chat, isColdContact, isKnownContact };
  }

  const prep = await withTimeout(
    client.pupPage.evaluate(async (phone) => {
      try {
        const WidFactory = window.require('WAWebWidFactory');
        const Collections = window.require('WAWebCollections');
        const FindChat = window.require('WAWebFindChatAction');
        const cusWid = WidFactory.createWid(phone + '@c.us');
        let chat = Collections.Chat.get(cusWid);
        let synced = false;
        let manualOpened = false;

        // Flux manuel : ouvrir le chat comme "recherche → Discuter" (plusieurs APIs WA Web)
        const tryOpenManual = async () => {
          try {
            const Cmd = window.require('WAWebCmd');
            if (Cmd?.openChatAt) {
              await Cmd.openChatAt(cusWid);
              chat = Collections.Chat.get(cusWid);
              if (chat) return true;
            }
          } catch (_) {}
          try {
            const ChatSearch = window.require('WAWebChatSearch');
            if (ChatSearch?.searchChat) {
              const hit = await ChatSearch.searchChat(phone, { remote: true }).catch(() => null);
              if (hit?.chat) { chat = hit.chat; return true; }
            }
            if (ChatSearch?.query) {
              await ChatSearch.query(phone);
              const hit2 = ChatSearch?.getResultChat?.() || ChatSearch?.getChat?.();
              if (hit2) { chat = hit2; return true; }
            }
          } catch (_) {}
          try {
            const ChatAction = window.require('WAWebChatAction');
            if (ChatAction?.openChatBottom) {
              await ChatAction.openChatBottom(cusWid);
              chat = Collections.Chat.get(cusWid);
              if (chat) return true;
            }
          } catch (_) {}
          try {
            const Sidebar = window.require('WAWebSidebarAction');
            if (Sidebar?.openChat) {
              await Sidebar.openChat(cusWid);
              chat = Collections.Chat.get(cusWid);
              if (chat) return true;
            }
          } catch (_) {}
          return false;
        };

        if (!chat) {
          manualOpened = await tryOpenManual();
        }

        if (!chat) {
          chat = (await FindChat.findOrCreateLatestChat(cusWid).catch(() => null))?.chat;
        }
        if (!chat) {
          try {
            const query = window.require('WAWebContactSyncUtils').constructUsyncDeltaQuery([{
              type: 'add',
              phoneNumber: phone
            }]);
            const result = await query.execute();
            const lid = result?.list?.[0]?.lid;
            if (lid) {
              synced = true;
              const lidWid = WidFactory.createWid(lid);
              chat = (await FindChat.findOrCreateLatestChat(lidWid).catch(() => null))?.chat;
            }
          } catch (_) {}
        }

        if (!chat) return { ok: false, error: 'chat_introuvable' };

        try {
          const open = window.require('WAWebOpenChatAction') || window.require('WAWebChatAction');
          if (open?.openChatBottom) await open.openChatBottom(chat);
          else if (open?.openChat) await open.openChat(chat);
        } catch (_) {}

        const serialized = chat.id?._serialized || cusWid._serialized;
        const msgs = chat.msgs?.getModelsArray?.() || [];
        const hasWaHistory = msgs.some(m => !m.isNotification);
        let isMyContact = false;
        try {
          const Contact = Collections.Contact;
          const c = Contact.get(cusWid) || (await Contact.find?.(cusWid));
          isMyContact = !!(c && (c.isMyContact || c.isAddressBookContact));
        } catch (_) {}

        return {
          ok: true,
          chatId: serialized,
          synced,
          manualOpened,
          hasWaHistory,
          isMyContact,
          isCold: !hasWaHistory && !isMyContact
        };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }, phoneDigits),
    20000,
    'prepareOutboundChat'
  );

  if (prep && prep.ok) {
    if (prep.chatId && prep.chatId.includes('@lid') && logger) {
      logger(`ℹ️ Chat interne LID détecté — envoi forcé via ${cusId}`, 'info');
    }
    chatId = cusId;
    isColdContact = !!prep.isCold;
    isKnownContact = !!(prep.isMyContact || prep.hasWaHistory);
    if (prep.manualOpened && logger) logger(`🔍 Chat ouvert (flux recherche / Discuter) pour +${phoneDigits}`, 'info');
    if (prep.synced && logger) logger(`🔗 Contact synchronisé WhatsApp (LID) pour +${phoneDigits}`, 'info');
    if (isKnownContact && logger) logger(`💬 Historique ou contact connu pour +${phoneDigits}`, 'info');
    if (isColdContact && logger) {
      logger(`👤 Nouveau numéro (jamais discuté) — WhatsApp peut refuser le 1er message (anti-spam)`, 'warn');
    }
    try {
      chat = await withTimeout(client.getChatById(chatId), 12000, 'getChatById after sync');
    } catch (e) {
      if (logger) logger(`⚠️ getChatById(${chatId}) : ${e.message}`, 'warn');
      try { chat = await getChat(client, cusId, logger); chatId = cusId; } catch (_) {}
    }
  } else if (logger && prep && prep.error) {
    logger(`⚠️ Préparation chat +${phoneDigits} : ${prep.error} — envoi via @c.us`, 'warn');
    try { chat = await getChat(client, cusId, logger); } catch (_) {}
  }

  if (process.env.MANUAL_SEARCH_DOM !== '0') {
    await openChatViaSearchUI(client, phoneDigits, logger);
  }

  if (isColdContact) {
    const coldMs = parseInt(process.env.COLD_CONTACT_DELAY_MS || '15000', 10);
    if (logger) logger(`⏳ Délai nouveau contact : ${(coldMs / 1000).toFixed(0)}s`, 'info');
    await sleep(coldMs);
  }

  chatId = cusId;
  return { chatId, chat, isColdContact, isKnownContact };
}


async function resolveOutboundChatId(client, number, logger) {
  const chatId = phoneToCusChatId(number);
  // Ne pas utiliser @lid pour l'envoi — provoque waitForChatLoading dans whatsapp-web.js
  try {
    const wid = await withTimeout(client.getNumberId(chatId.replace('@c.us', '')), 5000, 'getNumberId');
    if (wid && wid._serialized && wid._serialized.includes('@lid') && logger) {
      logger(`ℹ️ +${number} a un LID interne — envoi via ${chatId} (format classique)`, 'info');
    }
  } catch (_) {}
  return chatId;
}

async function probeWhatsAppConnection(client, logger, opts = {}) {
  const strict = opts.strict === true;
  const phone = getClientPhone(client);
  if (!phone) throw new Error('WhatsApp non authentifié (client.info.wid manquant)');

  let store = null;
  if (client.pupPage) {
    try {
      store = await withTimeout(client.pupPage.evaluate(() => {
        try {
          const conn = window.Store?.Conn;
          const sock = window.require?.('WAWebSocketModel')?.Socket;
          return { connected: conn?.connected ?? null, stream: sock?.stream ?? null };
        } catch (e) {
          return { error: e.message };
        }
      }), 12000, 'probe Store');
    } catch (e) {
      if (logger) logger(`⚠️ Probe Store (non bloquant) : ${e.message}`, 'warn');
    }
  }

  if (strict && store) {
    if (store.error) throw new Error(store.error);
    if (store.connected === false) throw new Error('Store.Conn.connected = false');
    const stream = String(store.stream || '').toUpperCase();
    if (stream.includes('DISCONNECT') || stream === 'CLOSING') {
      throw new Error(`Socket déconnecté (${store.stream})`);
    }
  }

  if (logger) logger(`🔍 Session OK — +${phone}`, 'info');
  return { phone, store };
}

async function deliverOutboundMessage(client, sendChatId, text, label, chatObj, logger) {
  const clientSend = () => withTimeout(client.sendMessage(sendChatId, text, { sendSeen: false }), 25000, `client.sendMessage(${label})`);
  const chatSend = (chat) => withTimeout(chat.sendMessage(text), 25000, `chat.sendMessage(${label})`);

  if (chatObj) {
    try { return await chatSend(chatObj); } catch (e) {
      if (!isWhatsAppFetchBug(e)) throw e;
      if (logger) logger(`⚠️ chat.sendMessage(${label}) : ${e.message} — repli client.sendMessage`, 'warn');
    }
  }
  try {
    return await clientSend();
  } catch (e) {
    if (!isWhatsAppFetchBug(e)) throw e;
    await sleep(2000);
    if (chatObj) {
      try { return await chatSend(chatObj); } catch (_) {}
    }
    try {
      const chat = await getChat(client, sendChatId, logger);
      return await chatSend(chat);
    } catch (e2) {
      if (!isWhatsAppFetchBug(e2)) throw e2;
      return await clientSend();
    }
  }
}


async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
  const pn = chatId.split('@')[0].replace(/\D/g, '');
  const cusId = normalizeOutboundChatId(chatId, pn);
  const wantAlt = process.env.UI_SEND_OPENER !== '0' && (
    useUiSendAll() || opts.viaUi || opts.manualOpener || opts.forceUi ||
    /hey|ui-retry/i.test(label)
  );

  const tryStoreSend = async (stepLabel) => {
    if (!client.pupPage) return null;
    await openChatViaStore(client, pn, logger);
    const sent = await sendTextViaWhatsAppStore(client, pn, text, logger, stepLabel);
    if (!sent?.id) return null;
    try {
      const ack = await waitForMessageAck(client, sent.id, stepLabel, sent.ack);
      const chat = await withTimeout(client.getChatById(cusId), 12000, 'verify store send');
      await verifyMessageInChat(chat, text, sent.id, stepLabel, {
        strict: !isHeyLikeLabel(stepLabel),
        maxAgeMs: 90000,
        logger
      });
      if (logger) logger(`✔️ ACK ${stepLabel} via module WA (niveau ${ack})`, 'success');
      return { id: sent.id, verified: true, viaStore: true };
    } catch (e) {
      if (/Timeout accusé/i.test(e.message)) {
        try {
          const chat = await withTimeout(client.getChatById(cusId), 12000, 'verify store timeout');
          await verifyMessageInChat(chat, text, sent.id, stepLabel, {
            strict: !isHeyLikeLabel(stepLabel),
            maxAgeMs: 90000,
            logger
          });
          if (logger) logger(`✔️ ${stepLabel} confirmé dans le chat (ACK déjà passé avant écoute)`, 'success');
          return { id: sent.id, verified: true, viaStore: true };
        } catch (_) {}
      }
      if (logger) logger(`❌ Module WA (${stepLabel}) : ${e.message}`, 'error');
      return null;
    }
  };

  const tryUi = async (stepLabel) => {
    if (!wantAlt || !client.pupPage) return null;
    await openChatViaStore(client, pn, logger);
    const uiOk = await sendTextViaComposerUI(client, cusId, text, logger, stepLabel);
    if (uiOk) return { id: 'ui-verified', verified: true, viaUi: true };
    return null;
  };

  const storeFirst = await tryStoreSend(label);
  if (storeFirst) return storeFirst;

  const uiFirst = await tryUi(label);
  if (uiFirst) {
    if (logger) logger(`✔️ Livré via saisie WhatsApp Web (${label})`, 'success');
    return uiFirst;
  }
  if (wantAlt && logger) logger(`⚠️ Saisie UI (${label}) non confirmée — essai API`, 'warn');

  try {
    return await sendAndVerify(client, chatId, text, label, logger, prefetchedChat, pn, opts);
  } catch (e) {
    if (/rejeté|ACK_ERROR/i.test(e.message) && client.pupPage && process.env.UI_RETRY_ON_ACK !== '0') {
      if (logger) logger(`🔁 ACK_ERROR API → retry module WA puis clavier (${label})`, 'warn');
      const storeRetry = await tryStoreSend(`${label}-store-retry`);
      if (storeRetry) {
        if (logger) logger(`✔️ Livré après retry module WA (${label})`, 'success');
        return storeRetry;
      }
      const uiRetry = await tryUi(`${label}-ui-retry`);
      if (uiRetry) {
        if (logger) logger(`✔️ Livré après retry UI (${label})`, 'success');
        return uiRetry;
      }
    }
    throw e;
  }
}

async function sendAndVerify(client, chatId, text, label, logger, chatForTyping = null, phoneDigits = null, opts = {}) {
  let sendChatId = chatId;
  const useChatObject = !!chatForTyping;
  if (!useChatObject && (sendChatId.includes('@lid') || !sendChatId.includes('@'))) {
    sendChatId = phoneToCusChatId(phoneDigits || chatId);
  }
  sendChatId = normalizeOutboundChatId(sendChatId, phoneDigits || chatId);
  if (chatForTyping) {
    try {
      await chatForTyping.sendStateTyping();
      await sleep(rand(config.typingMin, config.typingMax));
      await chatForTyping.clearState();
    } catch (_) {}
  } else {
    try {
      const warm = await withTimeout(client.getChatById(sendChatId), 12000, 'warm chat');
      await warm.sendStateTyping();
      await sleep(rand(config.typingMin, config.typingMax));
      await warm.clearState();
    } catch (_) {}
  }
  const msg = await deliverOutboundMessage(client, sendChatId, text, label, chatForTyping, logger);
  let msgId = whatsappMsgId(msg);
  let ackLevel = null;
  let verifyChat = chatForTyping;
  if (!verifyChat) {
    try { verifyChat = await withTimeout(client.getChatById(sendChatId), 10000, 'getChat verify'); } catch (_) {}
  }
  if (!msgId) {
    if (logger) logger(`⚠️ sendMessage(${label}) sans id — vérification via fetchMessages...`, 'warn');
    let vChat = chatForTyping;
    if (!vChat) { try { vChat = await withTimeout(client.getChatById(sendChatId), 10000, 'verify chat'); } catch (_) {} }
    if (vChat) {
      try {
        await verifyMessageInChat(vChat, text, null, label, { softFail: false, logger });
      } catch (e) {
        if (!isWhatsAppFetchBug(e)) throw e;
        if (logger) logger(`⚠️ fetchMessages indisponible (${label}) — envoi considéré OK sans id`, 'warn');
      }
    }
    if (logger) logger(`✔️ Message ${label} confirmé (sans id)`, 'info');
    return { id: 'verified-no-id', verified: true };
  }
  try {
    ackLevel = await waitForMessageAck(client, msgId, label);
    if (logger) logger(`✔️ ACK ${label} (niveau ${ackLevel}) · id: ${msgId.substring(0, 24)}...`, 'info');
  } catch (ackErr) {
    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) {
      if (opts.ackSoft && verifyChat) {
        try {
          await verifyMessageInChat(verifyChat, text, msgId, label, { softFail: false, logger, strict: true });
          if (logger) logger(`⚠️ ACK_ERROR mais trace dans le chat (${label}) — vérifiez sur votre téléphone`, 'warn');
          if (useAckColdSoft()) {
            return { id: msgId, verified: true, ackSoftOk: true };
          }
        } catch (verifyErr) {
          if (logger) logger(`❌ ACK_ERROR + absent du chat (${label}) — message NON livré`, 'error');
        }
      } else if (logger) {
        logger(`❌ WhatsApp ACK_ERROR (${label}) — message probablement non livré au destinataire`, 'error');
      }
      throw new Error(ackErr.message);
    }
    if (logger) logger(`⚠️ ${ackErr.message} — vérif historique...`, 'warn');
  }
  const ackOk = ackLevel !== null && ackLevel >= MessageAck.ACK_SERVER;
  if (verifyChat) {
    try {
      await verifyMessageInChat(verifyChat, text, msgId, label, { softFail: ackOk, logger });
    } catch (e) {
      if (ackOk && isWhatsAppFetchBug(e)) {
        if (logger) logger(`⚠️ Vérification historique ignorée (${label}) après ACK`, 'warn');
      } else throw e;
    }
  }
  return { id: msgId, verified: true };
}

// ─── BotAccount ──────────────────────────────────────────────────────────────
class BotAccount {
  constructor(id) {
    this.id         = id;
    this.authPath   = path.join(getAuthBase(), '.wwebjs_auth', `account${id}`);
    this.dataFile   = path.join(__dirname, 'data', `queue_${id}.json`);
    this.client     = null;
    this.retryCount = 0;
    this._resumeTimer    = null;
    this._logFlushTimer  = null;
    this._saveQueueTimer = null;
    this._queueLoopActive = false;
    this._resettingAuth  = false;
    this._consecutiveRejects = 0;
    this._initializing   = false;
    this._postReadyScheduled = false;
    this._qrWatchdogTimer = null;
    this._lastInitError = null;
    this._effectiveCacheType = null;
    this._triedCacheFallback = false;
    this.bootAt = new Date().toISOString();
    this.state = {
      qr: null, ready: false, running: false, paused: false, sessionHealthy: null,
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
    this.log(`🚀 Compte ${id} — initialisation (auth: ${this.authPath})`, 'info');
    this.log(`🌐 Chromium: ${CHROMIUM_PATH} (${fs.existsSync(CHROMIUM_PATH) ? 'OK' : 'INTROUVABLE'})`, fs.existsSync(CHROMIUM_PATH) ? 'info' : 'error');
    this._loadQueue();
    this._autoResume();
    if (RESET_AUTH_ON_START.has(id)) {
      rmrf(this.authPath);
      console.log(`[BOT${id}] 🗑️ RESET_AUTH au démarrage — session supprimée : ${this.authPath}`);
    }
    const stagger = id === 2 ? parseInt(process.env.BOT2_START_DELAY_MS || '60000', 10) : 0;
    if (stagger > 0) this.log(`⏳ Démarrage WhatsApp dans ${Math.round(stagger / 1000)}s (évite 2 Chrome en même temps)`, 'info');
    setTimeout(() => {
      this._initClient().catch(e => this.log(`❌ Init fatal : ${e.message}`, 'error'));
    }, stagger);
  }

  get dailyLimit() { return dailyLimitMap[this.id]; }

  _flushLogs() {
    if (this._logFlushTimer) return;
    this._logFlushTimer = setTimeout(() => { this._logFlushTimer = null; saveLogs(this.id, this.state.log); }, LOG_FLUSH_DEBOUNCE_MS);
  }

  _saveQueue(immediate = false) {
    if (immediate) {
      if (this._saveQueueTimer) { clearTimeout(this._saveQueueTimer); this._saveQueueTimer = null; }
      this._writeQueueToDisk(); return;
    }
    if (this._saveQueueTimer) return;
    this._saveQueueTimer = setTimeout(() => { this._saveQueueTimer = null; this._writeQueueToDisk(); }, 500);
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
        campaign: this.state.campaign || null,
        spinUsed: this.state.spinUsed || [],
        savedAt: new Date().toISOString()
      }, null, 2));
    } catch(e) { console.error(`[BOT${this.id}] Erreur écriture queue : ${e.message}`); }
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
        this.state.campaign = data.campaign || null;
        this.state.spinUsed = data.spinUsed || [];
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
      this._saveQueue(true); return true;
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
  _messagesAvailable() { this._checkWindowReset(); return Math.max(0, this.dailyLimit - this.state.dailySent); }

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
      if (waits > 24) { this.log('❌ Limite horaire toujours atteinte après 2h — arrêt', 'error'); return false; }
      this.log(`⏳ Limite horaire (~${config.maxMessagesPerHour} msgs/h) — pause 5 min (${this.state.sendTimestamps.length} envoyés cette heure)`, 'warn');
      await sleep(5 * 60 * 1000);
      this._pruneSendTimestamps();
    }
    return true;
  }

  _resetStuckContacts() {
    let fixed = 0;
    this.state.queue.forEach(c => { if (c.status === 'processing') { c.status = 'pending'; fixed++; } });
    if (fixed > 0) { this.log(`♻️ ${fixed} contact(s) débloqué(s) (statut processing → pending)`, 'warn'); this._saveQueue(true); }
    return fixed;
  }

  _estimateQueueSeconds() {
    const pending = this.state.queue.filter(c => c.status === 'pending');
    let sec = 0;
    for (const c of pending) {
      const rawMsg = personalizeMessage((c.message || '').trim() || process.env.DEFAULT_MESSAGE || '', c);
      const mc = countOutboundMessages(rawMsg);
      const base = (config.minDelay + config.maxDelay) / 2;
      sec += mc * base;
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

  _handleGhostSession(err) {
    this.state.sessionHealthy = false;
    this.state.ready = false;
    this.state.qr = null;
    this.state.running = false;
    this.state.paused = true;
    this._queueLoopActive = false;
    this._resetStuckContacts();
    this.log(`👻 ${err.message}`, 'error');
    this.log('🛑 Queue arrêtée — Reset Auth + rescannez. Si numéro restreint: pause 24–48h ou Compte 2.', 'error');
    this._saveQueue(true);
  }

  async _schedulePostReadyCheck() {
    await sleep(Math.min(READY_PROBE_DELAY_MS, 5000));
    if (!this.state.ready || !this.client) return;
    const phone = getClientPhone(this.client);
    if (!phone) {
      this.state.sessionHealthy = false;
      this.log('⚠️ Numéro non détecté — attendez ou Reset Auth', 'warn');
      return;
    }
    this.state.sessionHealthy = true;
    this.log(`✅ WhatsApp prêt — +${phone}`, 'success');
    try {
      await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
    } catch (e) {
      this.log(`⚠️ ${e.message}`, 'warn');
    }
    const pending = this.state.queue.filter(x => x.status === 'pending').length;
    if (pending > 0 && config.autoResume && process.env.AUTO_START_ON_READY !== '0' && !this.state.running && !this._dailyLimitReached()) {
      this.log(`▶️ Reprise automatique : ${pending} contacts restants`, 'warn');
      this.runQueue(this._partner);
    }
  }

  _clearQrWatchdog() {
    if (this._qrWatchdogTimer) {
      clearTimeout(this._qrWatchdogTimer);
      this._qrWatchdogTimer = null;
    }
  }

  _scheduleQrWatchdog() {
    this._clearQrWatchdog();
    if (!QR_WATCHDOG_MS || QR_WATCHDOG_MS < 30000) return;
    this._qrWatchdogTimer = setTimeout(() => {
      this._qrWatchdogTimer = null;
      if (this._resettingAuth || this.state.ready || this.state.qr || this._initializing) return;
      this.log('⚠️ Aucun QR après attente — réinitialisation automatique de la session', 'warn');
      this.resetAuth().catch(e => this.log(`❌ Watchdog reset : ${e.message}`, 'error'));
    }, QR_WATCHDOG_MS);
  }

  _makeClient() {
    const takeover = process.env.TAKEOVER_ON_CONFLICT === '1';
    const cacheType = (this._effectiveCacheType || process.env.WA_WEB_CACHE_TYPE || 'remote').toLowerCase();
    let webVersionCache = { type: 'none' };
    const clientExtra = {};
    if (cacheType === 'remote') {
      webVersionCache = { type: 'remote', remotePath: WA_WEB_CACHE_REMOTE, strict: false };
      clientExtra.webVersion = WA_WEB_VERSION;
    } else if (cacheType === 'local') {
      webVersionCache = { type: 'local' };
      clientExtra.webVersion = WA_WEB_VERSION;
    }
    this.log(`🔧 Client WA — cache=${cacheType} version=${cacheType !== 'none' ? WA_WEB_VERSION : 'auto'}`, 'info');
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      ...clientExtra,
      webVersionCache,
      takeoverOnConflict: takeover,
      takeoverTimeoutMs: takeover ? 10000 : 0,
      puppeteer: {
        headless: true,
        executablePath: CHROMIUM_PATH,
        timeout: 120000, protocolTimeout: 120000,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-gpu','--no-first-run','--no-zygote',
          '--disable-extensions','--disable-background-networking',
          '--disable-sync','--mute-audio','--no-default-browser-check',
          '--safebrowsing-disable-auto-update','--disable-features=TranslateUI','--memory-pressure-off']
      }
    });
  }

  _bindEvents(c) {
    c.on('qr', async qr => {
      this._clearQrWatchdog();
      this.retryCount = 0;
      this.state.qr = await qrcode.toDataURL(qr);
      this.state.ready = false;
      this.state.sessionHealthy = null;
      this.log('QR Code généré — scannez-le sur le dashboard (onglet Connexion)', 'warn');
    });
    c.on('loading_screen', (pct, msg) => {
      if (pct === 0 || pct === 100) this.log(`Chargement WA Web : ${msg || pct + '%'}`, 'info');
    });
    c.on('authenticated', () => {
      this._clearQrWatchdog();
      this.log('Authentification réussie — finalisation connexion...', 'info');
    });
    c.on('ready', async () => {
      this._clearQrWatchdog();
      this.retryCount = 0; this.state.ready = true; this.state.qr = null;
      if (this._postReadyScheduled) return;
      this._postReadyScheduled = true;
      this.state.sessionHealthy = null;
      try {
        const info = c.info;
        const phone = info && info.wid ? info.wid.user : '?';
        this.log(`WhatsApp connecté ✅ — Numéro actif : +${phone}`, 'success');
      } catch(_) { this.log('WhatsApp connecté ✅', 'success'); }
      this.log('⏳ Préparation session...', 'info');
      this._schedulePostReadyCheck().catch(e => this.log(`Erreur probe ready : ${e.message}`, 'error'));
    });
    c.on('message', async msg => {
      try { await this._handleInboundMessage(msg); } catch (e) {
        console.error(`[BOT${this.id}] message:`, e.message);
      }
    });
    c.on('message_reaction', async reaction => {
      try {
        if (!reaction) return;
        const phone = String(reaction.senderId || '').replace('@c.us', '').replace(/\D/g, '');
        if (!phone) return;
        const contact = this.state.queue.find(x => x.phone.replace(/\D/g, '') === phone);
        if (!contact || contact.linkSent) return;
        if (!(contact.status === 'awaiting_reply' || contact.awaitingLink)) return;
        if (!isPositiveReaction(reaction)) return;
        this.log(`👍 Réaction positive de +${phone} — envoi du lien`, 'success');
        contact.replied = true;
        contact.replyText = reaction.reaction || '👍';
        await this._sendPendingLink(contact, phone);
      } catch (e) {
        console.error(`[BOT${this.id}] reaction:`, e.message);
      }
    });
    c.on('disconnected', reason => {
      this.state.ready = false;
      this.state.qr = null;
      this.state.sessionHealthy = null;
      this.state.running = false;
      this._postReadyScheduled = false;
      this.log(`WhatsApp déconnecté : ${reason}`, 'error');
      if (!this._resettingAuth) {
        this._scheduleQrWatchdog();
        this._scheduleRetry(reason === 'LOGOUT' ? 30000 : 8000);
      }
    });
    c.on('auth_failure', msg => {
      this.state.ready = false;
      this.state.qr = null;
      this.state.sessionHealthy = false;
      this._postReadyScheduled = false;
      this.log(`Erreur auth : ${msg} — nouvelle tentative`, 'error');
      if (!this._resettingAuth) {
        this._clearQrWatchdog();
        this._scheduleRetry(10000);
      }
    });
  }

  async _destroyClient() {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try { await withTimeout(c.destroy(), 12000, 'client.destroy()'); }
    catch (e) { console.warn(`[BOT${this.id}] destroy: ${e.message}`); }
    await sleep(2500);
  }

  _scheduleRetry(delay) {
    const MAX = 10;
    if (this.retryCount >= MAX) { this.log('❌ Trop de tentatives, arrêt.', 'error'); return; }
    this.retryCount++;
    const wait = delay || Math.min(10000 * this.retryCount, 60000);
    this.log(`🔄 Tentative ${this.retryCount}/${MAX} dans ${wait/1000}s`, 'warn');
    setTimeout(() => { this._initClient().catch(() => {}); }, wait);
  }

  async _initClient() {
    if (this._initializing || this._resettingAuth) return;
    this._initializing = true;
    this._clearQrWatchdog();
    this.log('📲 Connexion WhatsApp Web en cours...', 'info');
    try {
      await this._destroyClient();
      removeLocks(this.authPath);
      this.client = this._makeClient();
      this._bindEvents(this.client);
      await withTimeout(this.client.initialize(), 180000, 'WhatsApp.initialize()');
      this.retryCount = 0;
      this._lastInitError = null;
      if (!this.state.ready && !this.state.qr) {
        this.log('⏳ Session en attente — QR ou reconnexion automatique sous peu', 'warn');
        this._scheduleQrWatchdog();
      }
    } catch (err) {
      const msg = err.message || String(err);
      this._lastInitError = msg;
      const nav = isPuppeteerNavigationError(msg);
      const cacheType = (this._effectiveCacheType || process.env.WA_WEB_CACHE_TYPE || 'remote').toLowerCase();
      if (!this._triedCacheFallback && cacheType === 'remote') {
        this._triedCacheFallback = true;
        this._effectiveCacheType = 'none';
        this.log('⚠️ Échec cache remote — nouvel essai sans version épinglée', 'warn');
        await this._destroyClient();
        this._initializing = false;
        return this._initClient();
      }
      if (!fs.existsSync(CHROMIUM_PATH)) {
        this.log(`❌ Chromium introuvable (${CHROMIUM_PATH}) — vérifiez le Dockerfile Railway`, 'error');
      }
      this.log(`Erreur initialisation : ${msg}${nav ? ' (rechargement WA Web — nouvelle tentative)' : ''}`, 'error');
      await this._destroyClient();
      this._scheduleRetry(nav ? 30000 : 15000);
    } finally {
      this._initializing = false;
    }
  }

  // ─── FIX PRINCIPAL : resetAuth supprime la session et force un nouveau QR ────
  async resetAuth() {
    this._resettingAuth = true;
    this._clearQrWatchdog();
    this.state.ready    = false;
    this.state.running  = false;
    this.state.qr       = null;
    this.state.sessionHealthy = null;
    this._postReadyScheduled = false;
    this._queueLoopActive = false;
    this.retryCount = 0;

    if (this.client) {
      try { await withTimeout(this.client.logout(), 10000, 'client.logout()'); }
      catch(e) { console.warn(`[BOT${this.id}] logout() ignoré : ${e.message}`); }
      try { await withTimeout(this.client.destroy(), 8000, 'client.destroy()'); }
      catch(e) { console.warn(`[BOT${this.id}] destroy() ignoré : ${e.message}`); }
      this.client = null;
    }

    this.log(`🗑️ Suppression session auth : ${this.authPath}`, 'warn');
    rmrf(this.authPath);
    const cacheDir = path.join(getAuthBase(), '.wwebjs_cache');
    rmrf(cacheDir);

    this._resetStuckContacts();
    await sleep(3000);
    this._resettingAuth = false;
    await this._initClient();
    this.log('🔄 Session réinitialisée — scannez le nouveau QR (déconnectez autres sessions Web sur le téléphone)', 'warn');
  }

  async _delayMsg()     { const ms=rand(config.minDelay,config.maxDelay)*1000;               this.log(`⏳ Pause : ${(ms/1000).toFixed(0)}s`,'info');          await sleep(ms); }
  async _delaySession() { const ms=rand(config.sessionPauseMin,config.sessionPauseMax)*1000; this.log(`☕ Pause session : ${(ms/60000).toFixed(0)}min`,'warn'); await sleep(ms); }
  async _typing(chat)   { try { await chat.sendStateTyping(); await sleep(rand(config.typingMin,config.typingMax)); await chat.clearState(); } catch(e) {} }


  _campaignUsesAiSpin() {
    const c = this.state.campaign;
    if (c && c.aiSpin === false) return false;
    if (c && c.aiSpin === true) return ai.isAiEnabled();
    return ai.isAiEnabled() && process.env.AI_SPIN !== '0';
  }

  async _resolveContactMessage(contact, sendIndex) {
    const toSend = (contact.message || '').trim();
    const spinBase = (contact.messageOriginal || contact.message || '').trim();
    if (!toSend && !spinBase) return '';
    if (sendIndex === 0 || !this._campaignUsesAiSpin()) {
      return personalizeMessage(toSend || spinBase, contact);
    }
    if (!ai.isAiEnabled()) return personalizeMessage(toSend || spinBase, contact);
    try {
      const spun = await ai.spinMessage(spinBase, {
        prenom: contact.prenom,
        index: sendIndex,
        previousSpins: this.state.spinUsed || [],
      });
      if (!this.state.spinUsed) this.state.spinUsed = [];
      this.state.spinUsed.push(spun);
      if (this.state.spinUsed.length > 200) this.state.spinUsed = this.state.spinUsed.slice(-200);
      this.log(`🤖 Spin IA #${sendIndex + 1} (Groq) pour +${contact.phone.replace(/\D/g, '')}`, 'info');
      return personalizeMessage(spun, contact);
    } catch (e) {
      this.log(`⚠️ Spin IA : ${e.message} — texte original`, 'warn');
      return personalizeMessage(toSend || spinBase, contact);
    }
  }

  async _sendPendingLink(contact, phoneDigits) {
    const link = (contact.link || this.state.campaign?.link || '').trim();
    if (!link || contact.linkSent) return false;
    const number = phoneDigits.replace(/\D/g, '');
    const cusChatId = normalizeOutboundChatId(`${number}@c.us`, number);
    const personalizedLink = personalizeMessage(link, contact);
    if (!(await this._waitForHourlyCapacity(1))) return false;
    if (this._dailyLimitReached()) return false;
    await resolveOutboundChatId(this.client, number, this.log.bind(this));
    const sendOpts = { coldContact: false };
    const linkResult = await this._sendMessage(cusChatId, personalizedLink, '', null, sendOpts);
    contact.linkSent = true;
    contact.linkSentAt = new Date().toISOString();
    contact.status = 'done';
    contact.awaitingLink = false;
    this.state.dailySent += linkResult.messageCount;
    this._recordMessagesSent(linkResult.messageCount);
    this._saveQueue(true);
    addToSentHistory(number, {
      sentAt: contact.linkSentAt, botId: this.id,
      message: '(lien après opt-in)', link: personalizedLink,
      prenom: contact.prenom, nom: contact.nom,
    });
    this.log(`🔗 Lien envoyé à +${number} après réponse positive`, 'success');
    return true;
  }

  async _handleInboundMessage(msg) {
    if (msg.fromMe) return;
    const phone = msg.from.replace('@c.us', '').replace(/\D/g, '');
    const body = msg.body ? msg.body.substring(0, 500) : '';
    const contact = this.state.queue.find(x => x.phone.replace(/\D/g, '') === phone);
    if (!contact) return;
    const awaiting = contact.status === 'awaiting_reply' || (contact.awaitingLink && !contact.linkSent);
    if (awaiting && body) {
      contact.replied = true;
      contact.repliedAt = new Date().toISOString();
      contact.replyText = body.substring(0, 200);
      this.state.repliesReceived++;
      this._saveQueue();

      const intent = classifyOptInReply(body);
      if (intent === 'negative') {
        contact.status = 'declined';
        contact.awaitingLink = false;
        contact.optInResult = 'no';
        this._saveQueue(true);
        this.log(`🚫 +${phone} a dit non — aucun lien envoyé`, 'warn');
        return;
      }
      if (intent === 'positive') {
        const link = (contact.link || this.state.campaign?.link || '').trim();
        if (!link) {
          this.log(`⚠️ +${phone} a dit oui mais aucun lien configuré dans la campagne`, 'error');
          return;
        }
        this.log(`✅ +${phone} a dit oui — envoi du lien`, 'success');
        try {
          const sent = await this._sendPendingLink(contact, phone);
          if (sent) contact.optInResult = 'yes';
        } catch (e) {
          this.log(`❌ Lien non envoyé à +${phone} : ${e.message}`, 'error');
        }
        this._saveQueue(true);
        return;
      }
      contact.optInResult = 'pending';
      this.log(`💬 +${phone} : réponse ambiguë — pas de lien ("${contact.replyText}")`, 'info');
      return;
    }
    if (contact.status === 'done') {
      contact.replied = true;
      contact.repliedAt = new Date().toISOString();
      contact.replyText = body ? body.substring(0, 200) : '(media)';
      this.state.repliesReceived++;
      this.log(`💬 Réponse de +${phone} : "${contact.replyText}"`, 'success');
      this._saveQueue();
    }
  }

  async _sendMessage(chatId, rawMsg, link, prefetchedChat = null, opts = {}) {
    void link;
    const text = (rawMsg || '').trim();
    if (!text) throw new Error('Message vide');
    const ids = [];
    let chat = prefetchedChat;
    if (!chat) {
      try { chat = await getChat(this.client, chatId, this.log.bind(this)); } catch (e) {
        this.log(`⚠️ getChatById pour typing : ${e.message}`, 'warn');
      }
    }
    const ackSoft = !!((opts.coldContact || opts.manualOpener) && useAckColdSoft());
    await this._typing(chat);
    const sendLabel = useUiSendAll() ? 'question-ui' : 'question';
    const result = await sendSingleOutbound(
      this.client, chatId, text, sendLabel, this.log.bind(this), chat,
      {
        ackSoft,
        viaUi: !!useUiSendAll(),
        forceUi: !!(opts.forceUi || useUiSendAll()),
        manualOpener: opts.manualOpener
      }
    );
    ids.push(result.id);
    return { messageCount: 1, ids, lastId: result.id };
  }


  /**
   * Chemin d'envoi unique : test dashboard et queue campagne utilisent exactement la même logique.
   */
  async _deliverToNumber(number, contact, { message, link, skipProbe = false, sendIndex = 0 } = {}) {
    await resolveOutboundChatId(this.client, number, this.log.bind(this));
    const { chatId, chat: prefetchedChat, isColdContact } = await prepareOutboundChat(this.client, number, this.log.bind(this));
    const cusChatId = normalizeOutboundChatId(chatId, number);
    if (!skipProbe) {
      try {
        await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
      } catch (e) {
        this.log(`⚠️ ${e.message}`, 'warn');
      }
    }
    if (!await safeIsRegisteredUser(this.client, cusChatId, this.log.bind(this))) {
      throw new Error(`+${number} n'est pas sur WhatsApp`);
    }
    const workContact = {
      ...contact,
      message: (message ?? contact.message ?? '').trim() || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋',
      messageOriginal: contact.messageOriginal || contact.message,
    };
    const rawMsg = await this._resolveContactMessage(workContact, sendIndex);
    const personalizedLink = personalizeMessage((link ?? contact.link ?? '').trim(), contact);
    const hasLink = !!personalizedLink;
    const useOpener = !hasLink && shouldUseManualOpener(number, isColdContact);
    const openerText = useOpener ? getColdOpenerText() : '';
    let msgCount = countOutboundMessages(rawMsg);
    if (openerText) msgCount += 1;
    if (msgCount === 0) throw new Error('Message vide');
    if (msgCount > this._messagesAvailable()) {
      throw new Error(`Quota insuffisant : ${msgCount} message(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`);
    }
    if (!(await this._waitForHourlyCapacity(msgCount))) {
      throw new Error('Envoi annulé : limite horaire');
    }
    if (!hasLink) {
      throw new Error('Lien de campagne requis — renseignez le champ « Lien du groupe » dans Import (envoyé seulement si la personne dit oui)');
    }
    this.log('💬 Question envoyée — si oui → lien · si non → rien', 'info');
    if (useOpener && openerText) {
      this.log(`👋 Envoi Hey (${openerText})...`, 'info');
      await sleep(rand(400, 1200));
    }
    this._recordFirstSend();
    const sendOpts = { coldContact: isColdContact || useOpener, manualOpener: useOpener };
    const sendId = cusChatId;
    let result;
    if (openerText) {
      const openerResult = await this._sendMessage(sendId, openerText, '', prefetchedChat, {
        ...sendOpts, manualOpener: true, forceUi: true
      });
      await sleep(COLD_OPENER_DELAY_MS);
      const mainResult = await this._sendMessage(sendId, rawMsg, '', prefetchedChat, sendOpts);
      result = {
        messageCount: openerResult.messageCount + mainResult.messageCount,
        ids: [...openerResult.ids, ...mainResult.ids],
        lastId: mainResult.lastId
      };
    } else {
      result = await this._sendMessage(sendId, rawMsg, '', prefetchedChat, sendOpts);
    }
    this.state.sessionHealthy = true;
    return {
      chatId: sendId, number, rawMsg, personalizedLink, msgCount,
      result, combined: false, openerUsed: !!openerText, splitRoute: false,
      awaitingLink: hasLink
    };
  }

  async sendTest(phone, message, link) {
    if (!this.state.ready) throw new Error('WhatsApp non connecté');
    const number = phone.replace(/\D/g, '');
    const contact = { phone: number, prenom: 'Test', nom: 'Test' };
    const { result } = await this._deliverToNumber(number, contact, { message, link });
    this.state.dailySent += result.messageCount;
    this._recordMessagesSent(result.messageCount);
    this._saveQueue();
    this.log(`🧪 Test envoyé à +${number} (${result.messageCount} msg WhatsApp) [${this.state.dailySent}/${this.dailyLimit}]`, 'success');
  }

  async runQueue(relayBot) {
    if (this._queueLoopActive) { this.log('⚠️ Envoi déjà en cours', 'warn'); return; }
    this._resetStuckContacts();
    const pendingCount = this.state.queue.filter(c => c.status === 'pending').length;
    if (!pendingCount) { this.log('ℹ️ Aucun contact en attente dans la queue', 'warn'); return; }
    if (!this.state.ready) { this.log('❌ WhatsApp non connecté — scannez le QR dans l\'onglet Connexion', 'error'); return; }
    if (this.state.sessionHealthy === false && !getClientPhone(this.client)) {
      this.log('❌ WhatsApp non authentifié — scannez le QR', 'error');
      return;
    }
    if (this._dailyLimitReached()) { this.log(`⏸ Quota journalier atteint (${this.state.dailySent}/${this.dailyLimit} msgs WA)`, 'warn'); this.state.limitReached = true; return; }

    this._queueLoopActive = true;
    this.state.running = true;
    this.state.limitReached = false;
    const startStats={...this.state.stats}, startTime=Date.now();
    let notReadyTicks = 0;
    if (this._campaignUsesAiSpin()) this.log('🤖 Spin IA (Groq) : 1er contact = texte validé, suivants = variantes', 'info');
    this.log('💬 1 question par contact — lien uniquement après réponse positive', 'info');
    this.log(`🚀 Démarrage : ${pendingCount} contact(s) · quota ${this.state.dailySent}/${this.dailyLimit} msgs WA`,'success');
    let campaignSendIndex = 0;
    try {
      await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
      this.state.sessionHealthy = true;
    } catch (e) {
      this.log(`⚠️ Probe session : ${e.message}`, 'warn');
    }

    try {
      while (this.state.queue.some(c => c.status === 'pending')) {
        if (!this.state.running) break;
        if (!this.state.ready) {
          notReadyTicks++;
          if (notReadyTicks === 1 || notReadyTicks % 6 === 0) this.log('⏳ En attente connexion WhatsApp (scannez le QR si besoin)...', 'warn');
          await sleep(10000); continue;
        }
        notReadyTicks = 0;
        if (this.state.paused) { await sleep(3000); continue; }

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
          if (!this.state.running) break;
        }

        const contact=this.state.queue.find(c=>c.status==='pending');
        if (!contact) break;
        contact.status='processing'; this._saveQueue(true);

        try {
          const number=contact.phone.replace(/\D/g,'');
          if (isBlacklisted(number)) {
            contact.status='blacklisted'; this.state.stats.blacklisted++;
            this.log(`🚫 Blacklisté : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(1000,3000)); continue;
          }
          await sleep(rand(800, 2500));
          const delivery = await this._deliverToNumber(number, contact, { skipProbe: true, sendIndex: campaignSendIndex++ });
          const { rawMsg, personalizedLink, result, awaitingLink } = delivery;
          this._consecutiveRejects = 0;
          contact.sentAt = new Date().toISOString();
          contact.waMessageId = result.lastId;
          contact.whatsappMessagesSent = result.messageCount;
          if (awaitingLink) {
            contact.status = 'awaiting_reply';
            contact.awaitingLink = true;
            contact.linkSent = false;
            this.log(`✅ Question à +${number}${contact.prenom ? ' (' + contact.prenom + ')' : ''} — lien si réponse +`, 'success');
          } else {
            contact.status = 'done';
            this.log(`✅ Envoyé à +${number}${contact.prenom ? ' (' + contact.prenom + ')' : ''} [${this.state.dailySent + result.messageCount}/${this.dailyLimit}]`, 'success');
          }
          this.state.stats.sent++;
          this.state.sessionCount++;
          this.state.dailySent += result.messageCount;
          this._recordMessagesSent(result.messageCount);
          addToSentHistory(number, {
            sentAt: contact.sentAt, botId: this.id, message: rawMsg,
            link: awaitingLink ? '(lien après opt-in)' : personalizedLink,
            prenom: contact.prenom, nom: contact.nom,
          });
          this._saveQueue();
          await this._delayMsg();
          if (!this.state.running) break;
        } catch(err) {
          const number=contact.phone.replace(/\D/g,'');
          if (/n'est pas sur WhatsApp/i.test(err.message)) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Non inscrit sur WhatsApp : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(3000,8000)); continue;
          }
          if (/Message vide/i.test(err.message)) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Message vide : +${number}`,'warn');
            this._saveQueue(); continue;
          }
          if (/Quota insuffisant/i.test(err.message)) {
            const msgCount = countOutboundMessages(personalizeMessage((contact.message||'').trim()||process.env.DEFAULT_MESSAGE||'Bonjour ! 👋'),
              personalizeMessage((contact.link||'').trim(), contact)
            );
            this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
            contact.status='pending';
            const remaining=this.state.queue.filter(c=>c.status==='pending');
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
          if (/limite horaire/i.test(err.message)) {
            contact.status = 'pending'; this._saveQueue(true);
            this.log('⏸ Arrêt : limite horaire anti-ban', 'warn'); break;
          }
          if (isGhostSessionError(err)) {
            contact.status = 'pending';
            this._handleGhostSession(err);
            break;
          }
          if (isMessageRejectedError(err)) {
            if (contact.status === 'processing') contact.status = 'failed';
            contact.lastError = err.message;
            this.state.stats.failed++;
            this._consecutiveRejects = (this._consecutiveRejects || 0) + 1;
            const maxRejects = parseInt(process.env.MAX_CONSECUTIVE_REJECTS || '12', 10);
            this.log(`⛔ Refus WhatsApp pour +${number} : ${err.message} — contact ignoré (${this._consecutiveRejects}/${maxRejects} consécutifs)`, 'warn');
            this._saveQueue();
            if (this._consecutiveRejects >= maxRejects) {
              this.log(`🛑 ${maxRejects} refus consécutifs — pause queue (échec technique ou anti-spam ciblé — pas forcément un ban complet. Testez un envoi manuel sur ce numéro.`, 'error');
              this.state.paused = true;
              this.state.running = false;
              break;
            }
            await sleep(rand(45000, 90000));
            continue;
          }
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

  setCampaign(opts = {}) {
    this.state.campaign = {
      messageOriginal: (opts.messageOriginal || opts.message || '').trim(),
      message: (opts.message || '').trim(),
      link: (opts.link || '').trim(),
      conversational: true,
      aiSpin: opts.aiSpin !== false,
      preparedAt: new Date().toISOString(),
    };
    if (!this.state.spinUsed) this.state.spinUsed = [];
    this._saveQueue(true);
  }

  importCSV(content, defaultMessage, defaultLink, forceIncludeDuplicates = [], campaignOpts = {}) {
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
        duplicates.push({ phone, prenom: prenom.trim() || histEntry.prenom, nom: nom.trim() || histEntry.nom, contactCount: histEntry.contactCount, lastSentAt: histEntry.lastSentAt, lastMessage: histEntry.lastMessage, lastLink: histEntry.lastLink, lastBotId: histEntry.lastBotId, contacts: histEntry.contacts.slice(0, 15) });
        continue;
      }
      const msg = (row.message || defaultMessage || '').trim();
      const hasLink = !!(row.link || defaultLink);
      let aiSpin = campaignOpts.aiSpin !== false && (this.state.campaign?.aiSpin !== false);
      if (campaignOpts.aiSpin === false) aiSpin = false;
      this.state.queue.push({
        phone, status: 'pending', prenom: prenom.trim(), nom: nom.trim(),
        message: msg,
        messageOriginal: (campaignOpts.messageOriginal || msg).trim(),
        link: (row.link || defaultLink || this.state.campaign?.link || '').trim(),
        aiSpin, awaitingLink: false, linkSent: false,
        addedAt: new Date().toISOString(),
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
    if (!this.state.stats || typeof this.state.stats !== 'object') {
      this.state.stats = { sent: 0, failed: 0, skipped: 0, blacklisted: 0 };
    }
    this._checkWindowReset();
    const resetInMs=this._windowResetIn();
    const pendingList = this.state.queue.filter(c => c.status === 'pending');
    let pendingWhatsAppMessages = 0;
    for (const c of pendingList) {
      pendingWhatsAppMessages += countOutboundMessages(
        personalizeMessage((c.message || '').trim() || process.env.DEFAULT_MESSAGE || '', c)
      );
    }
    this._pruneSendTimestamps();
    const pendingWithDoubleMessage = pendingList.filter(c => !!(c.link || this.state.campaign?.link || '').trim()).length;
    return {
      id:this.id, ready:this.state.ready, qr:this.state.qr,
      running:this.state.running, paused:this.state.paused,
      initializing: this._initializing,
      resettingAuth: this._resettingAuth,
      sessionHealthy: this.state.sessionHealthy,
      lastInitError: this._lastInitError,
      waWebCacheType: (this._effectiveCacheType || process.env.WA_WEB_CACHE_TYPE || 'remote').toLowerCase(),
      waWebVersion: WA_WEB_VERSION,
      stats:this.state.stats,
      pending: pendingList.length, pendingWhatsAppMessages, pendingWithDoubleMessage,
      estimatedQueueSec: this._estimateQueueSeconds(),
      messagesAvailable: this._messagesAvailable(),
      hourlySent: this.state.sendTimestamps.length,
      maxMessagesPerHour: config.maxMessagesPerHour,
      relayed:    this.state.queue.filter(c=>c.status==='relayed').length,
      awaitingReply: this.state.queue.filter(c=>c.status==='awaiting_reply').length,
      linksSent:  this.state.queue.filter(c=>c.linkSent===true).length,
      declined:   this.state.queue.filter(c=>c.status==='declined').length,
      replied:    this.state.queue.filter(c=>c.replied===true).length,
      campaign:   this.state.campaign || null,
      aiEnabled:  ai.isAiEnabled(),
      aiProvider: ai.getAiProvider()?.name || null,
      blacklisted:this.state.queue.filter(c=>c.status==='blacklisted').length,
      total:      this.state.queue.length,
      sessionCount:this.state.sessionCount,
      dailySent:this.state.dailySent, dailyLimit:this.dailyLimit,
      quotaCountsMessages: true, quotaAsContacts: config.quotaAsContacts !== false,
      limitReached:this.state.limitReached, limitReachedAt:this.state.limitReachedAt,
      resumeAt:this.state.resumeAt, windowStart:this.state.windowStart, resetInMs,
      autoResume:config.autoResume, bannedAt:this.state.bannedAt,
      repliesReceived:this.state.repliesReceived,
      scheduledAt:schedules[this.id]?.scheduledAt||null,
      minDelay:config.minDelay, maxDelay:config.maxDelay, sessionSize:config.sessionSize,
      sessionPauseMin:config.sessionPauseMin, sessionPauseMax:config.sessionPauseMax,
      typingMin:config.typingMin, typingMax:config.typingMax,
      linkDelayMin:config.linkDelayMin, linkDelayMax:config.linkDelayMax,
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

  clearLogs() { this.state.log = []; saveLogs(this.id, []); console.log(`[BOT${this.id}] Logs effacés`); }
}

// ─── Comptes actifs (démarrés après app.listen pour garder l'API en ligne) ───
const bots = {};
let botsBootstrapped = false;

function stubBotStatus(id) {
  return {
    id,
    ok: true,
    ready: false,
    qr: null,
    running: false,
    paused: false,
    initializing: true,
    resettingAuth: false,
    sessionHealthy: null,
    lastInitError: null,
    stats: { sent: 0, failed: 0, skipped: 0, blacklisted: 0 },
    pending: 0,
    pendingWhatsAppMessages: 0,
    pendingWithDoubleMessage: 0,
    total: 0,
    dailySent: 0,
    dailyLimit: dailyLimitMap[id] || DEFAULT_DAILY_LIMIT,
    log: [{ time: new Date().toISOString(), msg: '⏳ Démarrage du bot WhatsApp...', type: 'info' }],
  };
}

function startBots() {
  if (botsBootstrapped) return;
  botsBootstrapped = true;
  try {
    if (ENABLED_ACCOUNTS.has(1)) bots[1] = new BotAccount(1);
    if (ENABLED_ACCOUNTS.has(2)) bots[2] = new BotAccount(2);
    if (bots[1] && bots[2]) {
      bots[1]._partner = bots[2];
      bots[2]._partner = bots[1];
    } else if (bots[1]) {
      bots[1]._partner = bots[1];
    } else if (bots[2]) {
      bots[2]._partner = bots[2];
    }
    console.log(`[BOOT] Comptes actifs : ${Object.keys(bots).join(', ') || 'aucun'} · Chromium=${CHROMIUM_PATH} · exists=${fs.existsSync(CHROMIUM_PATH)}`);
  } catch (e) {
    console.error('[BOOT] Échec démarrage bots :', e);
  }
}

function getBot(req) {
  const id = parseInt(req.params.account || req.query.account || '');
  return (!isNaN(id) && bots[id]) ? bots[id] : null;
}
function requireBot(req, res) {
  const bot = getBot(req);
  if (!bot) { res.status(404).json({ ok: false, error: `Compte invalide. Comptes disponibles : ${Object.keys(bots).join(', ')}` }); return null; }
  return bot;
}
function otherBot(bot) {
  if (bot.id === 1 && bots[2]) return bots[2];
  if (bot.id === 2 && bots[1]) return bots[1];
  return bot;
}

// ─── Routes API ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const botDiag = {};
  for (const [id, b] of Object.entries(bots)) {
    botDiag[id] = {
      ready: b.state.ready,
      hasQr: !!b.state.qr,
      initializing: b._initializing,
      resettingAuth: b._resettingAuth,
      sessionHealthy: b.state.sessionHealthy,
      lastInitError: b._lastInitError,
      cacheType: b._effectiveCacheType || process.env.WA_WEB_CACHE_TYPE || 'remote',
      logCount: b.state.log.length,
      lastLog: b.state.log[0] ? b.state.log[0].msg : null,
      bootAt: b.bootAt,
    };
  }
  res.json({
    ok: true,
    version: APP_VERSION,
    commit: BUILD_COMMIT,
    authTokenRequired: !!AUTH_TOKEN,
    chromiumPath: CHROMIUM_PATH,
    chromiumExists: fs.existsSync(CHROMIUM_PATH),
    authBase: getAuthBase(),
    enabledAccounts: [...ENABLED_ACCOUNTS],
    features: { resetAuth: true, ghostDetection: true, messageAck: true, optInLinkFlow: true, coldContactSync: true, manualSearchFlow: MANUAL_SEARCH_FLOW, coldOpener: !!getColdOpenerText(), aiSpin: true, storeSend: true },
    resetAuthOnStart: [...RESET_AUTH_ON_START],
    uptimeSec: Math.round(process.uptime()),
    bots: botDiag,
  });
});

app.get('/api/:account/status', (req, res) => {
  const id = parseInt(req.params.account, 10);
  if (isNaN(id) || !ENABLED_ACCOUNTS.has(id)) {
    return res.status(404).json({ ok: false, error: `Compte invalide. Actifs : ${[...ENABLED_ACCOUNTS].join(', ')}` });
  }
  const b = bots[id];
  if (!b) return res.json(stubBotStatus(id));
  try {
    res.json(b.getStatus());
  } catch (e) {
    console.error(`[API] getStatus bot${b.id}:`, e.message);
    let fallback;
    try { fallback = stubBotStatus(b.id); fallback.ok = false; fallback.error = e.message; fallback.log = (b.state.log || []).slice(0, 20); }
    catch (_) { fallback = { ok: false, id: b.id, error: e.message, stats: { sent: 0, failed: 0, skipped: 0, blacklisted: 0 }, log: [] }; }
    res.status(500).json(fallback);
  }
});

app.post('/api/:account/start', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  if(!b.state.ready) return res.status(400).json({ok:false,error:'WhatsApp non connecté — onglet Connexion, scannez le QR code'});
  if(b.state.sessionHealthy === false && !getClientPhone(b.client)) return res.status(400).json({ok:false,error:'WhatsApp non authentifié — scannez le QR'});
  const pending = b.state.queue.filter(c => c.status === 'pending').length;
  if (!pending) return res.status(400).json({ok:false,error:'Aucun contact en attente — importez un CSV d\'abord'});
  if (b._dailyLimitReached()) return res.status(400).json({ok:false,error:`Quota atteint (${b.state.dailySent}/${b.dailyLimit} messages WA). Attendez le reset ou augmentez la limite.`,limitReached:true});
  b.state.paused=false; b.state.limitReached=false; b.state.bannedAt=null;
  cancelSchedule(b.id);
  b.runQueue(otherBot(b));
  res.json({ok:true, pending, dailySent:b.state.dailySent, dailyLimit:b.dailyLimit});
});

app.post('/api/:account/pause', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  b.state.paused=!b.state.paused;
  if (b.state.paused) { cancelSchedule(b.id); b.state.running = false; b._resetStuckContacts(); }
  b.log(b.state.paused?'⏸️ Pause (planning annulé si actif)':'▶️ Reprise','warn');
  res.json({ok:true,paused:b.state.paused});
});

app.post('/api/:account/unstick', (req,res)=>{
  const b=requireBot(req,res); if(!b) return;
  b.state.running = false; b._queueLoopActive = false;
  const fixed = b._resetStuckContacts();
  b.log('🔧 Queue débloquée manuellement', 'warn');
  res.json({ok:true, fixed});
});

// ─── reset-auth — supprime la session et génère un nouveau QR ────────────────
function handleResetAuth(b, res) {
  if (b._resettingAuth) return res.status(409).json({ ok: false, error: 'Reset déjà en cours' });
  b.log('🔑 Reset auth demandé via API', 'warn');
  res.json({ ok: true, message: 'Réinitialisation de la session en cours — un nouveau QR va apparaître dans le dashboard dans quelques secondes' });
  b.resetAuth().catch(e => b.log(`❌ Erreur resetAuth : ${e.message}`, 'error'));
}
app.post('/api/:account/reset-auth', (req, res) => {
  const b = requireBot(req, res); if (!b) return;
  handleResetAuth(b, res);
});
app.post('/api/reset-auth', (req, res) => handleResetAuth(bots[1], res));

app.post('/api/:account/check-session', async (req, res) => {
  const b = requireBot(req, res); if (!b) return;
  if (!b.state.ready) return res.status(400).json({ ok: false, error: 'WhatsApp non connecté' });
  try {
    await probeWhatsAppConnection(b.client, (m, t) => b.log(m, t), { strict: false });
    b.state.sessionHealthy = true;
    res.json({ ok: true, sessionHealthy: true, message: 'Session synchronisée' });
  } catch (e) {
    b.state.sessionHealthy = false;
    res.status(400).json({ ok: false, sessionHealthy: false, error: e.message });
  }
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
  for(const s of sessions){ const id=s.botId||1; if(!byAccount[id]) byAccount[id]={account:id,sent:0,failed:0,skipped:0,replies:0}; byAccount[id].sent+=s.sent||0; byAccount[id].failed+=s.failed||0; byAccount[id].skipped+=s.skipped||0; }
  for(const b of Object.values(bots)){ if(!byAccount[b.id]) byAccount[b.id]={account:b.id,sent:0,failed:0,skipped:0,replies:0}; byAccount[b.id].replies=b.state.repliesReceived||0; }
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

app.post('/api/:account/prepare-campaign', async (req, res) => {
  const bot = requireBot(req, res);
  if (!bot) return;
  const pitch = (req.body.message || '').trim();
  const link = (req.body.link || '').trim();
  const aiSpin = req.body.aiSpin !== false;
  if (!pitch) return res.status(400).json({ ok: false, error: 'Message (question) requis' });
  if (!link) return res.status(400).json({ ok: false, error: 'Lien du groupe requis — envoyé uniquement si la personne répond oui' });
  let question = pitch;
  let aiQuestionUsed = false;
  if (link && ai.isAiEnabled()) {
    try {
      question = await ai.generateConversationalQuestion(pitch, link);
      aiQuestionUsed = true;
      bot.log('🤖 Question générée (Groq)', 'info');
    } catch (e) {
      bot.log(`⚠️ IA question : ${e.message}`, 'warn');
    }
  } else if (link && !ai.isAiEnabled()) {
    bot.log('⚠️ GROQ_API_KEY absente', 'warn');
  }
  bot.setCampaign({ messageOriginal: question, message: question, pitch, link, aiSpin });
  const provider = ai.getAiProvider();
  res.json({
    ok: true, message: question, messageOriginal: pitch, link, aiSpin,
    aiQuestionUsed, aiEnabled: ai.isAiEnabled(), aiProvider: provider?.name || null,
  });
});

app.post('/api/:account/import', upload.single('file'), (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  if (!req.file) return res.status(400).json({ok:false,error:'Fichier manquant'});
  let forceInclude;
  try { forceInclude = JSON.parse(req.body.forceInclude||'[]'); } catch(_) { forceInclude = []; }
  const aiSpin = req.body.aiSpin !== '0' && req.body.aiSpin !== 'false';
  const messageOriginal = (req.body.messageOriginal || req.body.message || '').trim();
  let result;
  try {
    const content=fs.readFileSync(req.file.path,'utf-8');
    const message=(req.body.message||'').trim();
    const link=(req.body.link||'').trim();
    if(!message) return res.status(400).json({ok:false,error:'Message (question) requis'});
    if(!link) return res.status(400).json({ok:false,error:'Lien du groupe requis — envoyé si oui, rien si non'});
    if (!bot.state.campaign) bot.setCampaign({ messageOriginal, message, link, aiSpin });
    else { bot.state.campaign.message = message; bot.state.campaign.link = link; }
    result=bot.importCSV(content, message, link, forceInclude, { messageOriginal, aiSpin });
  } catch(e){ return res.status(400).json({ok:false,error:e.message}); }
  finally { try { fs.unlinkSync(req.file.path); } catch(_) {} }
  if(result.duplicates.length>0 && forceInclude.length===0) res.json({ok:true,...result,needsConfirmation:true});
  else res.json({ok:true,...result,needsConfirmation:false});
});

app.delete('/api/:account/queue/:phone', (req,res)=>{
  const bot=requireBot(req,res); if(!bot) return;
  res.json({ok:true,removed:bot.removeContact(req.params.phone)});
});

app.get('/api/sent-history', (req,res)=>{
  const hist = loadSentHistory();
  let list = Object.entries(hist).map(([phone, raw]) => enrichHistoryEntry(phone, raw)).filter(Boolean);
  list.sort((a, b) => new Date(b.lastSentAt || 0) - new Date(a.lastSentAt || 0));
  const { page = 1, limit = 100, q = '', minCount = 0 } = req.query;
  const perPage = Math.min(Math.max(parseInt(limit) || 100, 1), 50000);
  const qLower = String(q).toLowerCase();
  let filtered = list;
  if (qLower) filtered = filtered.filter(x => x.phone.includes(q) || (x.prenom || '').toLowerCase().includes(qLower) || (x.nom || '').toLowerCase().includes(qLower) || (x.lastMessage || '').toLowerCase().includes(qLower) || String(x.lastBotId || '').includes(q));
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
  } catch(e){ return res.status(400).json({ok:false,error:e.message}); }
  finally { try { fs.unlinkSync(req.file.path); } catch(_) {} }
  res.json({ok:true,added,total});
});

app.get('/api/config',(req,res)=>res.json({ ...config, dailyLimit: { ..._dailyLimitOverrides } }));
app.post('/api/config', (req, res) => {
  const errors = [];
  const setInt = (key, min, max) => {
    if (req.body[key] === undefined) return;
    const v = parseInt(req.body[key]);
    if (isNaN(v) || v < min || v > max) errors.push(`${key} doit être un entier entre ${min} et ${max}`);
    else config[key] = v;
  };
  setInt('minDelay',10,3600); setInt('maxDelay',10,3600); setInt('sessionSize',1,100);
  setInt('sessionPauseMin',60,7200); setInt('sessionPauseMax',60,7200);
  setInt('typingMin',500,30000); setInt('typingMax',500,30000);
  setInt('linkDelayMin',1000,60000); setInt('linkDelayMax',1000,60000);
  setInt('maxMessagesPerHour',5,200);
  if (config.minDelay > config.maxDelay) errors.push('minDelay doit être ≤ maxDelay');
  if (config.sessionPauseMin > config.sessionPauseMax) errors.push('sessionPauseMin doit être ≤ sessionPauseMax');
  if (config.typingMin > config.typingMax) errors.push('typingMin doit être ≤ typingMax');
  if (config.linkDelayMin > config.linkDelayMax) errors.push('linkDelayMin doit être ≤ linkDelayMax');
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
  } catch(e) { res.status(500).json({ok:false,error:'Erreur récupération groupes : ' + e.message}); }
});

app.get('/api/:account/export-group/:name', async (req, res) => {
  const bot = requireBot(req, res); if (!bot) return;
  if (!bot.state.ready) return res.status(400).json({ ok: false, error: 'Non connecté' });
  let chats;
  try { chats = await bot.client.getChats(); }
  catch(e) { return res.status(500).json({ ok: false, error: 'Erreur récupération groupes : ' + e.message }); }
  const groupName = decodeURIComponent(req.params.name);
  const group     = chats.find(c => c.isGroup && c.name === groupName);
  if (!group) return res.status(404).json({ ok: false, error: 'Groupe introuvable' });
  const participants = group.participants || [];
  const total        = participants.length;
  console.log(`[export-group] 📤 "${groupName}" — ${total} participants`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(groupName)}.csv"`);
  res.write('telephone,prenom,nom,admin\n');
  for (let i = 0; i < participants.length; i++) {
    if (res.writableEnded) { console.log(`[export-group] ⚠️ Connexion client fermée à ${i}/${total}, export annulé`); return; }
    const p = participants[i];
    if (i > 0 && i % 25 === 0) console.log(`[export-group] ⏳ ${i}/${total} traités...`);
    const { prenom, nom } = await getContactName(bot.client, p.id.user);
    const esc = v => `"${(v||'').replace(/"/g,'""')}"`;
    res.write(`+${p.id.user},${esc(prenom)},${esc(nom)},${p.isAdmin?'Oui':'Non'}\n`);
    if (i < participants.length - 1) await sleep(EXPORT_GROUP_INTER_DELAY_MS);
  }
  console.log(`[export-group] ✅ ${total} contacts exportés`);
  res.end();
});

// ─── Routes legacy (Compte 1 uniquement) ─────────────────────────────────────
app.get('/api/status', (req, res) => {
  const b = bots[1];
  if (!b) return res.status(503).json({ ok: false, error: 'Compte 1 désactivé (ENABLED_ACCOUNTS)' });
  try { res.json(b.getStatus()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/start',(req,res)=>{
  const b=bots[1]; if(!b) return res.status(503).json({ok:false,error:'Compte 1 pas encore démarré'});
  if(!b.state.ready) return res.status(400).json({ok:false,error:'Non connecté'});
  b.state.paused=false; b.state.limitReached=false; b.state.bannedAt=null;
  cancelSchedule(b.id);
  b.runQueue(otherBot(b)); res.json({ok:true});
});
app.post('/api/pause',(req,res)=>{
  const b=bots[1]; if(!b) return res.status(503).json({ok:false,error:'Compte 1 pas encore démarré'});
  b.state.paused=!b.state.paused;
  if (b.state.paused) cancelSchedule(b.id);
  b.log(b.state.paused?'⏸️ Pause (planning annulé si actif)':'▶️ Reprise','warn');
  res.json({ok:true,paused:b.state.paused});
});
app.post('/api/clear',(req,res)=>{ const b=bots[1]; if(!b) return res.status(503).json({ok:false}); cancelSchedule(b.id); b.clear(); res.json({ok:true}); });
app.post('/api/reset',(req,res)=>{ const b=bots[1]; if(!b) return res.status(503).json({ok:false}); cancelSchedule(b.id); b.reset(); res.json({ok:true}); });
app.get('/api/groups',async(req,res)=>{
  const b=bots[1]; if(!b||!b.state.ready) return res.json([]);
  try {
    const c=await b.client.getChats();
    res.json(c.filter(x=>x.isGroup).map(x=>({name:x.name,count:x.participants?.length||0})));
  } catch(e) { res.status(500).json({ok:false,error:'Erreur récupération groupes : ' + e.message}); }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Route introuvable',
    method: req.method,
    path: req.path,
    commit: BUILD_COMMIT,
    hint: 'Vérifiez GET /api/health puis POST /api/1/reset-auth (utilisez votre URL Railway réelle)',
  });
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`WhatsApp Manager → http://${HOST}:${PORT}`);
  console.log(`[BUILD] v${APP_VERSION} commit=${BUILD_COMMIT} reset-auth=ok`);
  console.log(`[BOOT] chromium=${CHROMIUM_PATH} exists=${fs.existsSync(CHROMIUM_PATH)} authToken=${AUTH_TOKEN ? 'oui' : 'non'}`);
  if (RESET_AUTH_ON_START.size) console.log(`[RESET_AUTH] Comptes au démarrage : ${[...RESET_AUTH_ON_START].join(', ')}`);
  if (AUTH_TOKEN) console.log('[BOOT] ⚠️ AUTH_TOKEN actif — renseignez le token dans Paramètres du dashboard');
  setImmediate(() => startBots());
});
