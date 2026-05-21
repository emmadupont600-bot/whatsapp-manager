#!/usr/bin/env python3
"""Envoi campagne via clavier UI (comme manuel) — repli si ACK_ERROR sur API."""
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

if "function useUiSendAll" not in t:
    t = t.replace(
        "function useAckColdSoft() {",
        "function useUiSendAll() {\n  return process.env.UI_SEND_ALL !== '0';\n}\n\nfunction useAckColdSoft() {",
        1,
    )

OLD_SSO = """async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
  const pn = chatId.split('@')[0].replace(/\\D/g, '');
  const useUi = process.env.UI_SEND_OPENER !== '0' && (opts.viaUi || label === 'hey-ui' || label === 'opener-ui');
  if (useUi && client.pupPage && (label.includes('hey') || label.includes('opener') || opts.viaUi)) {
    await openChatViaStore(client, pn, logger);
    const uiOk = await sendTextViaComposerUI(client, normalizeOutboundChatId(chatId, pn), text, logger, label);
    if (uiOk) return { id: 'ui-verified', verified: true, viaUi: true };
    if (logger) logger(`⚠️ Envoi UI échoué (${label}) — repli API`, 'warn');
  }
  return sendAndVerify(client, chatId, text, label, logger, prefetchedChat, pn, opts);
}"""

NEW_SSO = """async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
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

  const uiFirst = await tryUi(label);
  if (uiFirst) {
    if (logger) logger(`✔️ Livré via saisie WhatsApp Web (${label})`, 'success');
    return uiFirst;
  }
  if (wantUi && logger) logger(`⚠️ Saisie UI (${label}) non confirmée — essai API`, 'warn');

  try {
    return await sendAndVerify(client, chatId, text, label, logger, prefetchedChat, pn, opts);
  } catch (e) {
    if (/rejeté|ACK_ERROR/i.test(e.message) && client.pupPage && process.env.UI_RETRY_ON_ACK !== '0') {
      if (logger) logger(`🔁 ACK_ERROR API → retry saisie clavier (${label})`, 'warn');
      const uiRetry = await tryUi(`${label}-ui-retry`);
      if (uiRetry) {
        if (logger) logger(`✔️ Livré après retry UI (${label})`, 'success');
        return uiRetry;
      }
    }
    throw e;
  }
}"""

if OLD_SSO not in t:
    raise SystemExit("sendSingleOutbound not found")
t = t.replace(OLD_SSO, NEW_SSO, 1)

# doSend: force UI on manual route
OLD_DOSEND = """    const doSend = async (text, label, useTypingChat, extra = {}) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const sendLabel = extra.viaUi ? 'hey-ui' : label;
      const result = await sendSingleOutbound(
        this.client, chatId, text, sendLabel, this.log.bind(this), useTypingChat,
        { ackSoft, viaUi: extra.viaUi, manualOpener: opts.manualOpener }
      );"""

NEW_DOSEND = """    const doSend = async (text, label, useTypingChat, extra = {}) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const sendLabel = (extra.viaUi || useUiSendAll()) ? `${label}-ui` : label;
      const result = await sendSingleOutbound(
        this.client, chatId, text, sendLabel, this.log.bind(this), useTypingChat,
        {
          ackSoft,
          viaUi: !!(extra.viaUi || useUiSendAll()),
          forceUi: !!(extra.forceUi || useUiSendAll()),
          manualOpener: opts.manualOpener
        }
      );"""

if OLD_DOSEND in t:
    t = t.replace(OLD_DOSEND, NEW_DOSEND, 1)

# Hey logging
OLD_HEY = """        const uiHey = await sendTextViaComposerUI(this.client, sendId, openerText, this.log.bind(this), 'hey');
        openerResult = uiHey
          ? { messageCount: 1, ids: ['ui-verified'], lastId: 'ui-verified' }
          : await this._sendMessage(sendId, openerText, '', prefetchedChat, { ...sendOpts, manualOpener: true });"""

NEW_HEY = """        const uiHey = await sendTextViaComposerUI(this.client, sendId, openerText, this.log.bind(this), 'hey');
        if (uiHey) {
          this.log('✅ Hey confirmé dans le chat (saisie clavier)', 'success');
          openerResult = { messageCount: 1, ids: ['ui-verified'], lastId: 'ui-verified' };
        } else {
          this.log('⚠️ Hey : saisie UI non confirmée — essai API', 'warn');
          openerResult = await this._sendMessage(sendId, openerText, '', prefetchedChat, { ...sendOpts, manualOpener: true, forceUi: true });
        }"""

if OLD_HEY in t:
    t = t.replace(OLD_HEY, NEW_HEY, 1)

# split route sends with forceUi
t = t.replace(
    "const textResult = await this._sendMessage(sendId, textOnly, '', prefetchedChat, sendOpts);",
    "const textResult = await this._sendMessage(sendId, textOnly, '', prefetchedChat, { ...sendOpts, forceUi: useUiSendAll() });",
    2,
)
t = t.replace(
    "const linkResult = await this._sendMessage(sendId, linkOnly, '', prefetchedChat, sendOpts);",
    "const linkResult = await this._sendMessage(sendId, linkOnly, '', prefetchedChat, { ...sendOpts, forceUi: useUiSendAll() });",
    2,
)

if "uiSendAll: true" not in t:
    t = t.replace(
        "manualRouteSplit: true }",
        "manualRouteSplit: true, uiSendAll: true, uiRetryOnAck: true }",
        1,
    )

P.write_text(t, encoding="utf-8")
print("ok")
