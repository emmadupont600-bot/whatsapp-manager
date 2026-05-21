#!/usr/bin/env python3
"""Envoi via modules internes WhatsApp Web (sendTextMsgToChat) — prioritaire avant clavier/API."""
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

STORE_FN = r'''
async function sendTextViaWhatsAppStore(client, phoneDigits, text, logger, label) {
  const page = client.pupPage;
  if (!page || process.env.STORE_SEND === '0') return null;
  const phone = String(phoneDigits).replace(/\D/g, '');
  const body = (text || '').trim();
  if (!body) return null;

  const result = await withTimeout(
    page.evaluate(async (ph, msg) => {
      const out = { ok: false, err: null, id: null, via: null, tries: [] };
      try {
        const WidFactory = window.require('WAWebWidFactory');
        const FindChat = window.require('WAWebFindChatAction');
        const cusWid = WidFactory.createWid(ph + '@c.us');
        let chat = (await FindChat.findOrCreateLatestChat(cusWid).catch(() => null))?.chat;
        if (!chat) {
          out.err = 'no_chat';
          return out;
        }
        try {
          const Open = window.require('WAWebOpenChatAction') || window.require('WAWebChatAction');
          if (Open?.openChatBottom) await Open.openChatBottom(chat);
        } catch (_) {}

        const attempt = async (name, fn) => {
          try {
            const m = await fn();
            const id = m?.id?._serialized || m?.id?.id || (typeof m?.id === 'string' ? m.id : null);
            out.tries.push({ name, id: id || null });
            if (id) return { name, id };
          } catch (e) {
            out.tries.push({ name, err: e.message || String(e) });
          }
          return null;
        };

        const SendAction = window.require('WAWebSendMsgChatAction');
        if (SendAction) {
          let r = await attempt('sendTextMsgToChat', () => SendAction.sendTextMsgToChat(chat, msg, {}));
          if (!r && SendAction.sendMsg) {
            r = await attempt('sendMsg', () => SendAction.sendMsg(chat, msg, {}));
          }
          if (r) { out.ok = true; out.via = r.name; out.id = r.id; return out; }
        }

        const AddSend = window.require('WAWebAddAndSendMsgToChat');
        if (AddSend?.addAndSendMsgToChat) {
          const r = await attempt('addAndSendMsgToChat', () =>
            AddSend.addAndSendMsgToChat(chat, { body: msg, type: 'chat' }, {})
          );
          if (r) { out.ok = true; out.via = r.name; out.id = r.id; return out; }
        }

        const Front = window.require('WAWebFrontendMsgSendActions');
        if (Front?.sendTextMsgToChat) {
          const r = await attempt('frontendSend', () => Front.sendTextMsgToChat(chat, msg));
          if (r) { out.ok = true; out.via = r.name; out.id = r.id; return out; }
        }

        out.err = 'no_send_module';
        return out;
      } catch (e) {
        out.err = e.message || String(e);
        return out;
      }
    }, phone, body),
    35000,
    'sendTextViaWhatsAppStore'
  );

  if (!result?.ok || !result.id) {
    if (logger) logger(`⚠️ Module WA (${label}) : ${result?.err || 'pas d\'id'}`, 'warn');
    return null;
  }
  if (logger) logger(`📤 Message via ${result.via} (${label})`, 'info');
  return { id: result.id, viaStore: true };
}

function isHeyLikeLabel(label) {
  return /hey|opener/i.test(label || '');
}
'''

if "async function sendTextViaWhatsAppStore" not in t:
    t = t.replace(
        "async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {",
        STORE_FN + "\nasync function sendTextViaComposerUI(client, cusChatId, text, logger, label) {",
        1,
    )

# Composer: wait for footer + strict false for hey
t = t.replace(
    "async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {\n  const page = client.pupPage;\n  if (!page) return false;\n  const selectors = [",
    """async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {
  const page = client.pupPage;
  if (!page) return false;
  try {
    await page.waitForSelector('footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]', { timeout: 15000 });
  } catch (_) {}
  const selectors = [""",
    1,
)

t = t.replace(
    "await verifyMessageInChat(chat, text, null, label, { strict: true, maxAgeMs: 35000, logger });",
    "await verifyMessageInChat(chat, text, null, label, { strict: !isHeyLikeLabel(label), maxAgeMs: 60000, logger });",
    1,
)

# sendSingleOutbound: try store first
OLD_SSO_START = """async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
  const pn = chatId.split('@')[0].replace(/\\D/g, '');
  const cusId = normalizeOutboundChatId(chatId, pn);
  const wantUi = process.env.UI_SEND_OPENER !== '0' && (
    useUiSendAll() || opts.viaUi || opts.manualOpener || opts.forceUi ||
    /hey|ui-retry/i.test(label)
  );

  const tryUi = async (stepLabel) => {
    if (!wantUi || !client.pupPage) return null;
    await openChatViaStore(client, pn, logger);
    const uiOk = await sendTextViaComposerUI(client, cusId, text, logger, stepLabel);
    if (uiOk) return { id: 'ui-verified', verified: true, viaUi: true };
    return null;
  };

  const uiFirst = await tryUi(label);"""

NEW_SSO_START = """async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
  const pn = chatId.split('@')[0].replace(/\\D/g, '');
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
      const ack = await waitForMessageAck(client, sent.id, stepLabel);
      const chat = await withTimeout(client.getChatById(cusId), 12000, 'verify store send');
      await verifyMessageInChat(chat, text, sent.id, stepLabel, {
        strict: !isHeyLikeLabel(stepLabel),
        maxAgeMs: 90000,
        logger
      });
      if (logger) logger(`✔️ ACK ${stepLabel} via module WA (niveau ${ack})`, 'success');
      return { id: sent.id, verified: true, viaStore: true };
    } catch (e) {
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

  const uiFirst = await tryUi(label);"""

if OLD_SSO_START not in t:
    raise SystemExit("sendSingleOutbound block not found")
t = t.replace(OLD_SSO_START, NEW_SSO_START, 1)

# retry on ACK: try store before ui retry
OLD_RETRY = """      if (logger) logger(`🔁 ACK_ERROR API → retry saisie clavier (${label})`, 'warn');
      const uiRetry = await tryUi(`${label}-ui-retry`);"""

NEW_RETRY = """      if (logger) logger(`🔁 ACK_ERROR API → retry module WA puis clavier (${label})`, 'warn');
      const storeRetry = await tryStoreSend(`${label}-store-retry`);
      if (storeRetry) {
        if (logger) logger(`✔️ Livré après retry module WA (${label})`, 'success');
        return storeRetry;
      }
      const uiRetry = await tryUi(`${label}-ui-retry`);"""

if OLD_RETRY in t:
    t = t.replace(OLD_RETRY, NEW_RETRY, 1)

if "storeSend: true" not in t:
    t = t.replace("uiRetryOnAck: true }", "uiRetryOnAck: true, storeSend: true }", 1)

P.write_text(t, encoding="utf-8")
print("ok", len(t.splitlines()))
