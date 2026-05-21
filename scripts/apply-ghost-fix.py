#!/usr/bin/env python3
"""Apply ghost-session delivery fixes to index.js."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'index.js'
c = p.read_text()

# 1. Require MessageAck
c = c.replace(
    "const { Client, LocalAuth } = require('whatsapp-web.js');",
    "const { Client, LocalAuth } = require('whatsapp-web.js');\nconst { MessageAck } = require('whatsapp-web.js/src/util/Constants');",
    1,
)

# 2. WA web version constants after RESET_AUTH_ON_START
needle = "const RESET_AUTH_ON_START = parseResetAuthOnStart();\n\napp.use(express.json());"
insert = """const RESET_AUTH_ON_START = parseResetAuthOnStart();
const WA_WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1038602566-alpha';
const WA_WEB_CACHE_REMOTE = process.env.WA_WEB_CACHE_REMOTE || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';
const READY_PROBE_DELAY_MS = parseInt(process.env.READY_PROBE_DELAY_MS || '20000', 10);
const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);

app.use(express.json());"""
if needle not in c:
    raise SystemExit('needle2 missing')
c = c.replace(needle, insert, 1)

# 3. Replace sendAndVerify block - insert helpers before sendAndVerify
old_send = """async function sendAndVerify(client, chat, chatId, text, label, logger) {
  const msg = await withTimeout(chat.sendMessage(text), 15000, `sendMessage(${label})`);
  const msgId = whatsappMsgId(msg);
  if (!msgId) {
    if (logger) logger(`⚠️ sendMessage(${label}) sans id — vérification via fetchMessages...`, 'warn');
    await sleep(3000);
    try {
      const messages = await withTimeout(chat.fetchMessages({ limit: 5 }), 8000, `fetchMessages(${label})`);
      const recent = messages.filter(m => m.fromMe && m.body === text && (Date.now() - m.timestamp * 1000) < 30000);
      if (recent.length === 0) throw new Error(`Message "${label}" non trouvé dans la conversation après envoi — session fantôme détectée`);
      if (logger) logger(`✔️ Message ${label} confirmé via fetchMessages`, 'info');
      return { id: 'verified-no-id', verified: true };
    } catch(verifyErr) {
      if (verifyErr.message.includes('non trouvé')) throw verifyErr;
      throw new Error(`Session WhatsApp instable : sendMessage OK mais fetchMessages échoué (${verifyErr.message})`);
    }
  }
  if (logger) logger(`✔️ Message ${label} envoyé · id: ${msgId.substring(0, 20)}...`, 'info');
  return { id: msgId, verified: true };
}"""

new_send = r"""function idsLookDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = a.replace(/@.*$/, '').slice(0, 28);
  const nb = b.replace(/@.*$/, '').slice(0, 28);
  return na.length > 10 && na === nb;
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

async function waitForMessageAck(client, msgId, label) {
  if (!msgId || msgId === 'verified-no-id') return MessageAck.ACK_SERVER;
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
      if (ack >= MessageAck.ACK_SERVER) {
        clearTimeout(timer);
        client.removeListener('message_ack', onAck);
        resolve(ack);
      }
    };
    client.on('message_ack', onAck);
  });
}

async function verifyMessageInChat(chat, text, msgId, label) {
  await sleep(2500);
  const messages = await withTimeout(chat.fetchMessages({ limit: 20 }), 12000, `fetchMessages verify ${label}`);
  const recent = messages.filter(m => m.fromMe && (Date.now() - m.timestamp * 1000) < 90000);
  const byBody = recent.filter(m => (m.body || '').trim() === (text || '').trim());
  const byId = msgId ? recent.filter(m => whatsappMsgId(m) === msgId) : [];
  if (byBody.length === 0 && byId.length === 0) {
    throw new Error(`Message "${label}" absent de l'historique WhatsApp — session fantôme ou envoi silencieux`);
  }
}

async function probeWhatsAppConnection(client, logger) {
  const page = client.pupPage;
  if (!page) throw new Error('Navigateur Puppeteer non prêt');
  const state = await withTimeout(page.evaluate(() => {
    try {
      const conn = window.Store?.Conn;
      const sock = window.require?.('WAWebSocketModel')?.Socket;
      return {
        connected: conn?.connected ?? null,
        ref: conn?.ref ?? null,
        stream: sock?.stream ?? null,
        state: sock?.state ?? null,
      };
    } catch (e) {
      return { error: e.message };
    }
  }), 15000, 'probe Store.Conn');
  if (state.error) throw new Error(state.error);
  if (state.connected === false) throw new Error('Store.Conn.connected = false');
  if (logger) logger(`🔍 WA Store : connected=${state.connected} stream=${state.stream || '?'}`, 'info');
  return state;
}

async function sendAndVerify(client, chat, chatId, text, label, logger) {
  const msg = await withTimeout(chat.sendMessage(text), 20000, `sendMessage(${label})`);
  let msgId = whatsappMsgId(msg);
  if (!msgId) {
    if (logger) logger(`⚠️ sendMessage(${label}) sans id — vérification via fetchMessages...`, 'warn');
    await verifyMessageInChat(chat, text, null, label);
    if (logger) logger(`✔️ Message ${label} confirmé via fetchMessages (sans id)`, 'info');
    return { id: 'verified-no-id', verified: true };
  }
  try {
    const ack = await waitForMessageAck(client, msgId, label);
    if (logger) logger(`✔️ ACK ${label} (niveau ${ack}) · id: ${msgId.substring(0, 24)}...`, 'info');
  } catch (ackErr) {
    if (logger) logger(`⚠️ ${ackErr.message} — double-check historique...`, 'warn');
  }
  await verifyMessageInChat(chat, text, msgId, label);
  return { id: msgId, verified: true };
}"""

if old_send not in c:
    raise SystemExit('sendAndVerify block missing')
c = c.replace(old_send, new_send, 1)

# 4. state.sessionHealthy in constructor
c = c.replace(
    "      qr: null, ready: false, running: false, paused: false,",
    "      qr: null, ready: false, running: false, paused: false, sessionHealthy: null,",
    1,
)

# 5. _detectBan
c = c.replace(
    "  _detectBan(errMessage) {\n    return [/rate.?limit/i,/too many/i,/spam/i,/blocked/i,/account.*banned/i,/restrict/i,/ECONNRESET/i,/WAWebDisconnected/i].some(p=>p.test(errMessage));\n  }",
    "  _detectBan(errMessage) {\n    return [/rate.?limit/i,/too many/i,/spam/i,/blocked/i,/account.*banned/i,/restrict/i,/session fant[oô]me/i,/ghost/i,/ACK_ERROR/i,/rejet[eé]/i,/silencieux/i,/ECONNRESET/i,/WAWebDisconnected/i,/identiques/i].some(p=>p.test(errMessage));\n  }",
    1,
)

# 6. Add _handleGhostSession after _handleBan
c = c.replace(
    "  _handleBan(err) {\n    this.state.running = false; this.state.bannedAt = new Date().toISOString(); this.state.paused = true;\n    this.log(`🚫 BAN / RESTRICTION DÉTECTÉ : ${err.message} — Bot arrêté pour protection`, 'error');\n    this._saveQueue(true);\n  }\n\n  _makeClient()",
    """  _handleBan(err) {
    this.state.running = false; this.state.bannedAt = new Date().toISOString(); this.state.paused = true;
    this.log(`🚫 BAN / RESTRICTION DÉTECTÉ : ${err.message} — Bot arrêté pour protection`, 'error');
    this._saveQueue(true);
  }

  _handleGhostSession(err) {
    this.state.sessionHealthy = false;
    this.state.running = false;
    this.state.paused = true;
    this._queueLoopActive = false;
    this._resetStuckContacts();
    this.log(`👻 ${err.message}`, 'error');
    this.log('🛑 Queue arrêtée — Reset Auth + rescannez. Si numéro restreint: pause 24–48h ou Compte 2.', 'error');
    this._saveQueue(true);
  }

  async _schedulePostReadyCheck() {
    this.state.sessionHealthy = null;
    await sleep(READY_PROBE_DELAY_MS);
    if (!this.state.ready || !this.client) return;
    try {
      await probeWhatsAppConnection(this.client, this.log.bind(this));
      this.state.sessionHealthy = true;
      this.log('✅ Session WhatsApp synchronisée avec les serveurs', 'success');
      const pending = this.state.queue.filter(x => x.status === 'pending').length;
      if (pending > 0 && config.autoResume && process.env.AUTO_START_ON_READY !== '0' && !this.state.running && !this._dailyLimitReached()) {
        this.log(`▶️ Reprise auto dans 15s (${pending} contacts) — faites un message test vers vous-même avant si doute`, 'warn');
        await sleep(15000);
        if (this.state.ready && this.state.sessionHealthy && !this.state.running) this.runQueue(this._partner);
      }
    } catch (e) {
      this.state.sessionHealthy = false;
      this.log(`⚠️ Session non fiable : ${e.message}`, 'error');
      this.log('💡 Envoyez un message test vers votre numéro, ou Reset Auth, ou passez au Compte 2', 'warn');
    }
  }

  _makeClient()""",
    1,
)

# 7. _makeClient
old_client = """  _makeClient() {
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
  }"""

new_client = """  _makeClient() {
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath, clientId: `bot${this.id}` }),
      webVersion: WA_WEB_VERSION,
      webVersionCache: {
        type: 'remote',
        remotePath: WA_WEB_CACHE_REMOTE,
        strict: false,
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        timeout: 120000, protocolTimeout: 120000,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-gpu','--no-first-run','--no-zygote',
          '--disable-extensions','--disable-background-networking',
          '--disable-sync','--mute-audio','--no-default-browser-check',
          '--safebrowsing-disable-auto-update','--disable-features=TranslateUI','--memory-pressure-off']
      }
    });
  }"""

if old_client not in c:
    raise SystemExit('_makeClient block missing')
c = c.replace(old_client, new_client, 1)

# 8. ready handler
old_ready = """    c.on('ready', async () => {
      this.retryCount = 0; this.state.ready = true; this.state.qr = null;
      try {
        const info = c.info;
        const phone = info && info.wid ? info.wid.user : '?';
        this.log(`WhatsApp connecté ✅ — Numéro actif : +${phone}`, 'success');
      } catch(_) { this.log('WhatsApp connecté ✅', 'success'); }
      const pending = this.state.queue.filter(c => c.status === 'pending').length;
      if (pending > 0 && !this.state.running && !this._dailyLimitReached()) {
        this.log(`▶️ Reprise automatique : ${pending} contacts restants`, 'warn');
        this.runQueue(this._partner);
      }
    });"""

new_ready = """    c.on('ready', async () => {
      this.retryCount = 0; this.state.ready = true; this.state.qr = null;
      this.state.sessionHealthy = null;
      try {
        const info = c.info;
        const phone = info && info.wid ? info.wid.user : '?';
        this.log(`WhatsApp connecté ✅ — Numéro actif : +${phone}`, 'success');
      } catch(_) { this.log('WhatsApp connecté ✅', 'success'); }
      this.log(`⏳ Vérification session dans ${READY_PROBE_DELAY_MS / 1000}s avant envoi...`, 'info');
      this._schedulePostReadyCheck().catch(e => this.log(`Erreur probe ready : ${e.message}`, 'error'));
    });"""

if old_ready not in c:
    raise SystemExit('ready handler missing')
c = c.replace(old_ready, new_ready, 1)

# 9. resetAuth with logout
old_reset = """  async resetAuth() {
    this._resettingAuth = true;
    this.state.ready    = false;
    this.state.running  = false;
    this.state.qr       = null;
    this._queueLoopActive = false;
    this.retryCount = 0;

    // 1. Arrêter le client Puppeteer proprement
    if (this.client) {
      try { await withTimeout(this.client.destroy(), 8000, 'client.destroy()'); }
      catch(e) { console.warn(`[BOT${this.id}] destroy() échoué (ignoré) : ${e.message}`); }
      this.client = null;
    }

    // 2. Supprimer la session sauvegardée (forcer nouveau QR)
    this.log(`🗑️ Suppression session auth : ${this.authPath}`, 'warn');
    rmrf(this.authPath);

    // 3. Remettre les contacts processing → pending
    this._resetStuckContacts();

    // 4. Réinitialiser un nouveau client après 2s
    await sleep(2000);
    this._resettingAuth = false;
    this._initClient();
    this.log('🔄 Session réinitialisée — scannez le nouveau QR sur le dashboard', 'warn');
  }"""

new_reset = """  async resetAuth() {
    this._resettingAuth = true;
    this.state.ready    = false;
    this.state.running  = false;
    this.state.qr       = null;
    this.state.sessionHealthy = null;
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
    this._initClient();
    this.log('🔄 Session réinitialisée — scannez le nouveau QR (déconnectez autres sessions Web sur le téléphone)', 'warn');
  }"""

if old_reset not in c:
    raise SystemExit('resetAuth missing')
c = c.replace(old_reset, new_reset, 1)

# 10. _sendMessage - add assertDistinctMessageIds before returns
c = c.replace(
    """      await doSend(link.trim(), 'lien');
      return { messageCount: text ? 2 : 1, ids, lastId: ids[ids.length - 1] };
    }
    const parts = splitMessageAndLink(rawMsg);""",
    """      await doSend(link.trim(), 'lien');
      assertDistinctMessageIds(ids);
      return { messageCount: text ? 2 : 1, ids, lastId: ids[ids.length - 1] };
    }
    const parts = splitMessageAndLink(rawMsg);""",
    1,
)
c = c.replace(
    """        await doSend(parts.url, 'lien');
        return { messageCount: 2, ids, lastId: ids[ids.length - 1] };
      }
      await this._typing(chat);
      await doSend(parts.url, 'url-seule');""",
    """        await doSend(parts.url, 'lien');
        assertDistinctMessageIds(ids);
        return { messageCount: 2, ids, lastId: ids[ids.length - 1] };
      }
      await this._typing(chat);
      await doSend(parts.url, 'url-seule');""",
    1,
)

# 11. runQueue - session check at start
c = c.replace(
    """    if (!this.state.ready) { this.log('❌ WhatsApp non connecté — scannez le QR dans l\\'onglet Connexion', 'error'); return; }
    if (this._dailyLimitReached())""",
    """    if (!this.state.ready) { this.log('❌ WhatsApp non connecté — scannez le QR dans l\\'onglet Connexion', 'error'); return; }
    if (this.state.sessionHealthy === false) {
      this.log('❌ Session marquée non fiable — Reset Auth ou message test vers vous-même d\\'abord', 'error');
      return;
    }
    if (this._dailyLimitReached())""",
    1,
)

# 12. runQueue catch - ghost handling
c = c.replace(
    """        } catch(err) {
          if (this._detectBan(err.message)) { contact.status='pending'; this._handleBan(err); break; }
          if (contact.status === 'processing') contact.status = 'failed';""",
    """        } catch(err) {
          if (/session fant[oô]me|identiques|silencieux|ACK_ERROR|rejet[eé]/i.test(err.message)) {
            contact.status = 'pending';
            this._handleGhostSession(err);
            break;
          }
          if (this._detectBan(err.message)) { contact.status='pending'; this._handleBan(err); break; }
          if (contact.status === 'processing') contact.status = 'failed';""",
    1,
)

# 13. getStatus sessionHealthy
c = c.replace(
    "      resettingAuth: this._resettingAuth,\n      stats:this.state.stats,",
    "      resettingAuth: this._resettingAuth,\n      sessionHealthy: this.state.sessionHealthy,\n      waWebVersion: WA_WEB_VERSION,\n      stats:this.state.stats,",
    1,
)

# 14. start route - warn if session unhealthy
c = c.replace(
    """  if(!b.state.ready) return res.status(400).json({ok:false,error:'WhatsApp non connecté — onglet Connexion, scannez le QR code'});
  const pending = b.state.queue.filter(c => c.status === 'pending').length;""",
    """  if(!b.state.ready) return res.status(400).json({ok:false,error:'WhatsApp non connecté — onglet Connexion, scannez le QR code'});
  if(b.state.sessionHealthy === false) return res.status(400).json({ok:false,error:'Session WhatsApp non fiable — Reset Auth ou envoyez un message test vers votre numéro avant de lancer la queue'});
  const pending = b.state.queue.filter(c => c.status === 'pending').length;""",
    1,
)

# 15. check-session route after reset-auth
route_needle = "app.post('/api/reset-auth', (req, res) => handleResetAuth(bots[1], res));"
route_add = """app.post('/api/reset-auth', (req, res) => handleResetAuth(bots[1], res));

app.post('/api/:account/check-session', async (req, res) => {
  const b = requireBot(req, res); if (!b) return;
  if (!b.state.ready) return res.status(400).json({ ok: false, error: 'WhatsApp non connecté' });
  try {
    await probeWhatsAppConnection(b.client, (m, t) => b.log(m, t));
    b.state.sessionHealthy = true;
    res.json({ ok: true, sessionHealthy: true, message: 'Session synchronisée' });
  } catch (e) {
    b.state.sessionHealthy = false;
    res.status(400).json({ ok: false, sessionHealthy: false, error: e.message });
  }
});"""
if route_needle in c and "check-session" not in c:
    c = c.replace(route_needle, route_add, 1)

# 16. health features
c = c.replace(
    "features: { resetAuth: true },",
    "features: { resetAuth: true, ghostDetection: true, messageAck: true },",
    1,
)

p.write_text(c)
print('OK — patched', p)
