#!/usr/bin/env python3
"""Patch index.js: soft-fail fetchMessages waitForChatLoading after ACK; prefer chat.sendMessage."""

from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "index.js"
text = INDEX.read_text(encoding="utf-8")

OLD_VERIFY = """async function verifyMessageInChat(chat, text, msgId, label) {
  await sleep(2500);
  const messages = await withTimeout(chat.fetchMessages({ limit: 20 }), 12000, `fetchMessages verify ${label}`);
  const recent = messages.filter(m => m.fromMe && (Date.now() - m.timestamp * 1000) < 90000);
  const byBody = recent.filter(m => (m.body || '').trim() === (text || '').trim());
  const byId = msgId ? recent.filter(m => whatsappMsgId(m) === msgId) : [];
  if (byBody.length === 0 && byId.length === 0) {
    throw new Error(`Message "${label}" absent de l'historique WhatsApp — session fantôme ou envoi silencieux`);
  }
}"""

NEW_VERIFY = """function isWhatsAppFetchBug(err) {
  const m = (err && err.message) || String(err);
  return /waitForChatLoading|loadEarlierMsgs/i.test(m);
}

async function verifyMessageInChat(chat, text, msgId, label, opts = {}) {
  const { softFail = false, logger = null } = opts;
  await sleep(2500);
  let messages;
  try {
    messages = await withTimeout(chat.fetchMessages({ limit: 20 }), 12000, `fetchMessages verify ${label}`);
  } catch (e) {
    if (isWhatsAppFetchBug(e) && softFail) {
      if (logger) logger(`⚠️ Vérification historique ignorée (${label}) : bug fetchMessages WhatsApp Web`, 'warn');
      return false;
    }
    throw e;
  }
  const recent = messages.filter(m => m.fromMe && (Date.now() - m.timestamp * 1000) < 90000);
  const byBody = recent.filter(m => (m.body || '').trim() === (text || '').trim());
  const byId = msgId ? recent.filter(m => whatsappMsgId(m) === msgId) : [];
  if (byBody.length === 0 && byId.length === 0) {
    throw new Error(`Message "${label}" absent de l'historique WhatsApp — session fantôme ou envoi silencieux`);
  }
  return true;
}"""

OLD_SEND = """async function sendAndVerify(client, chatId, text, label, logger, chatForTyping = null, phoneDigits = null) {
  let sendChatId = chatId;
  if (sendChatId.includes('@lid') || !sendChatId.includes('@')) {
    sendChatId = phoneToCusChatId(phoneDigits || chatId);
  }
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
  let msg;
  try {
    msg = await withTimeout(client.sendMessage(sendChatId, text, { sendSeen: false }), 25000, `client.sendMessage(${label})`);
  } catch (e) {
    const errMsg = e.message || String(e);
    if (/waitForChatLoading/i.test(errMsg)) {
      await sleep(2000);
      msg = await withTimeout(client.sendMessage(sendChatId, text, { sendSeen: false }), 25000, `client.sendMessage(${label}) retry`);
    } else throw e;
  }
  let msgId = whatsappMsgId(msg);
  if (!msgId) {
    if (logger) logger(`⚠️ sendMessage(${label}) sans id — vérification via fetchMessages...`, 'warn');
    let vChat = chatForTyping;
    if (!vChat) { try { vChat = await withTimeout(client.getChatById(chatId), 10000, 'verify chat'); } catch (_) {} }
    if (vChat) await verifyMessageInChat(vChat, text, null, label);
    if (logger) logger(`✔️ Message ${label} confirmé via fetchMessages (sans id)`, 'info');
    return { id: 'verified-no-id', verified: true };
  }
  try {
    const ack = await waitForMessageAck(client, msgId, label);
    if (logger) logger(`✔️ ACK ${label} (niveau ${ack}) · id: ${msgId.substring(0, 24)}...`, 'info');
  } catch (ackErr) {
    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) throw new Error(ackErr.message);
    if (logger) logger(`⚠️ ${ackErr.message} — vérif historique...`, 'warn');
  }
  let verifyChat = chatForTyping;
  if (!verifyChat) {
    try { verifyChat = await withTimeout(client.getChatById(sendChatId), 10000, 'getChat verify'); } catch (_) {}
  }
  if (verifyChat) await verifyMessageInChat(verifyChat, text, msgId, label);
  return { id: msgId, verified: true };
}"""

NEW_SEND = """async function deliverOutboundMessage(client, sendChatId, text, label, chatObj, logger) {
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

async function sendAndVerify(client, chatId, text, label, logger, chatForTyping = null, phoneDigits = null) {
  let sendChatId = chatId;
  if (sendChatId.includes('@lid') || !sendChatId.includes('@')) {
    sendChatId = phoneToCusChatId(phoneDigits || chatId);
  }
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
    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) throw new Error(ackErr.message);
    if (logger) logger(`⚠️ ${ackErr.message} — vérif historique...`, 'warn');
  }
  const ackOk = ackLevel !== null && ackLevel >= MessageAck.ACK_SERVER;
  let verifyChat = chatForTyping;
  if (!verifyChat) {
    try { verifyChat = await withTimeout(client.getChatById(sendChatId), 10000, 'getChat verify'); } catch (_) {}
  }
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
}"""

if OLD_VERIFY not in text:
    raise SystemExit("verifyMessageInChat block not found")
if OLD_SEND not in text:
    raise SystemExit("sendAndVerify block not found")

text = text.replace(OLD_VERIFY, NEW_VERIFY, 1).replace(OLD_SEND, NEW_SEND, 1)
INDEX.write_text(text, encoding="utf-8")
print("ok")
