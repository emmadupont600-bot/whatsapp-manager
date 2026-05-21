#!/usr/bin/env python3
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'index.js'
c = p.read_text()

if 'function getClientPhone' not in c:
    c = c.replace(
        'function isPuppeteerNavigationError(msg) {',
        """function getClientPhone(client) {
  try {
    const w = client?.info?.wid;
    if (w && w.user) return String(w.user).replace(/\\D/g, '');
    if (typeof w === 'string') return w.replace(/\\D/g, '');
  } catch (_) {}
  return null;
}

function isPuppeteerNavigationError(msg) {""",
        1,
    )

old_probe = """async function probeWhatsAppConnection(client, logger) {
  const page = client.pupPage;
  if (!page) throw new Error('Navigateur Puppeteer non prêt');
  const state = await withTimeout(page.evaluate(() => {
    try {
      const conn = window.Store?.Conn;
      const sock = window.require?.('WAWebSocketModel')?.Socket;
      const wid = conn?.wid?._serialized || conn?.me?._serialized || null;
      return {
        connected: conn?.connected ?? null,
        hasSynced: conn?.hasSynced ?? null,
        wid,
        stream: sock?.stream ?? null,
        socketState: sock?.state ?? null,
      };
    } catch (e) {
      return { error: e.message };
    }
  }), 15000, 'probe Store.Conn');
  if (state.error) throw new Error(state.error);
  if (state.connected === false) throw new Error('Store.Conn.connected = false');
  if (!state.wid) throw new Error('Session fantôme : numéro connecté (wid) absent côté WhatsApp Web');
  const stream = String(state.stream || state.socketState || '').toUpperCase();
  if (stream.includes('DISCONNECT') || stream === 'CLOSING') {
    throw new Error(`Socket WhatsApp déconnecté (${state.stream}) — fermez autres sessions Web et Reset Auth`);
  }
  if (state.hasSynced === false) throw new Error('WhatsApp pas encore synchronisé (hasSynced=false)');
  if (logger) logger(`🔍 WA OK : wid=${(state.wid || '').slice(0, 18)}… stream=${state.stream || '?'}`, 'info');
  return state;
}"""

new_probe = """async function probeWhatsAppConnection(client, logger, opts = {}) {
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
}"""

if old_probe not in c:
    raise SystemExit('probe not found')
c = c.replace(old_probe, new_probe, 1)

if 'await verifyMessageInChat(chat, text, null, label)' in c:
    c = c.replace(
        "    await verifyMessageInChat(chat, text, null, label);",
        """    let vChat = chatForTyping;
    if (!vChat) { try { vChat = await withTimeout(client.getChatById(chatId), 10000, 'verify chat'); } catch (_) {} }
    if (vChat) await verifyMessageInChat(vChat, text, null, label);""",
        1,
    )

old_sched = """  async _schedulePostReadyCheck() {
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
  }"""

new_sched = """  async _schedulePostReadyCheck() {
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
  }"""

if old_sched not in c:
    raise SystemExit('schedule not found')
c = c.replace(old_sched, new_sched, 1)

c = c.replace(
    """          if (this.state.sessionHealthy === false) {
            throw new Error('Session fantôme — Reset Auth requis avant envoi');
          }
          await probeWhatsAppConnection(this.client, this.log.bind(this));
          if (isBlacklisted(number)) {""",
    "          if (isBlacklisted(number)) {",
    1,
)

c = c.replace(
    """    if (this.state.sessionHealthy === false) {
      this.log('❌ Session marquée non fiable — Reset Auth ou message test vers vous-même d\\'abord', 'error');
      return;
    }
    if (this._dailyLimitReached())""",
    """    if (this.state.sessionHealthy === false && !getClientPhone(this.client)) {
      this.log('❌ WhatsApp non authentifié — scannez le QR', 'error');
      return;
    }
    if (this._dailyLimitReached())""",
    1,
)

c = c.replace(
    "if(b.state.sessionHealthy === false) return res.status(400).json({ok:false,error:'Session WhatsApp non fiable — Reset Auth ou envoyez un message test vers votre numéro avant de lancer la queue'});",
    "if(b.state.sessionHealthy === false && !getClientPhone(b.client)) return res.status(400).json({ok:false,error:'WhatsApp non authentifié — scannez le QR'});",
    1,
)

c = c.replace(
    "    await probeWhatsAppConnection(b.client, (m, t) => b.log(m, t));",
    "    await probeWhatsAppConnection(b.client, (m, t) => b.log(m, t), { strict: false });",
    1,
)

# sendTest only
st = c.find('async sendTest')
if st > 0:
    end = c.find('async runQueue', st)
    block = c[st:end]
    block2 = block.replace(
        'await probeWhatsAppConnection(this.client, this.log.bind(this));',
        "try { await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false }); } catch (e) { this.log(`⚠️ ${e.message}`, 'warn'); }",
        1,
    )
    c = c[:st] + block2 + c[end:]

c = c.replace(
    "const cacheType = (process.env.WA_WEB_CACHE_TYPE || 'local').toLowerCase();",
    "const cacheType = (process.env.WA_WEB_CACHE_TYPE || 'none').toLowerCase();",
    1,
)

c = c.replace(
    """    const webVersionCache = cacheType === 'remote'
      ? { type: 'remote', remotePath: WA_WEB_CACHE_REMOTE, strict: false }
      : { type: 'local' };
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      webVersion: WA_WEB_VERSION,
      webVersionCache,""",
    """    let webVersionCache = { type: 'none' };
    const clientExtra = {};
    if (cacheType === 'remote') {
      webVersionCache = { type: 'remote', remotePath: WA_WEB_CACHE_REMOTE, strict: false };
      clientExtra.webVersion = WA_WEB_VERSION;
    } else if (cacheType === 'local') {
      webVersionCache = { type: 'local' };
      clientExtra.webVersion = WA_WEB_VERSION;
    }
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      ...clientExtra,
      webVersionCache,""",
    1,
)

c = c.replace(
    "      this.log(`⏳ Vérification session dans ${READY_PROBE_DELAY_MS / 1000}s avant envoi...`, 'info');",
    "      this.log('⏳ Préparation session...', 'info');",
    1,
)

p.write_text(c)
print('ok')
