#!/usr/bin/env python3
from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "index.js"
t = INDEX.read_text(encoding="utf-8")

SYNC_FN = r'''
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
    chatId = prep.chatId || cusId;
    isColdContact = !!prep.isCold;
    isKnownContact = !!(prep.isMyContact || prep.hasWaHistory);
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

  if (isColdContact) {
    const coldMs = parseInt(process.env.COLD_CONTACT_DELAY_MS || '15000', 10);
    if (logger) logger(`⏳ Délai nouveau contact : ${(coldMs / 1000).toFixed(0)}s`, 'info');
    await sleep(coldMs);
  }

  return { chatId, chat, isColdContact, isKnownContact };
}

'''

if "async function prepareOutboundChat" not in t:
    t = t.replace(
        "async function resolveOutboundChatId(client, number, logger) {",
        SYNC_FN + "\nasync function resolveOutboundChatId(client, number, logger) {",
        1,
    )

OLD_DELIVER = """    const chatId = await resolveOutboundChatId(this.client, number, this.log.bind(this));
    if (!skipProbe) {"""

NEW_DELIVER = """    await resolveOutboundChatId(this.client, number, this.log.bind(this));
    const { chatId, chat: prefetchedChat, isColdContact } = await prepareOutboundChat(this.client, number, this.log.bind(this));
    if (!skipProbe) {"""

OLD_SENDMSG = """  async _sendMessage(chatId, rawMsg, link) {
    const ids  = [];
    let chat = null;
    try { chat = await getChat(this.client, chatId, this.log.bind(this)); } catch (e) {
      this.log(`⚠️ getChatById pour typing : ${e.message}`, 'warn');
    }"""

NEW_SENDMSG = """  async _sendMessage(chatId, rawMsg, link, prefetchedChat = null) {
    const ids  = [];
    let chat = prefetchedChat;
    if (!chat) {
      try { chat = await getChat(this.client, chatId, this.log.bind(this)); } catch (e) {
        this.log(`⚠️ getChatById pour typing : ${e.message}`, 'warn');
      }
    }"""

OLD_DELIVER_SEND = """    const result = await this._sendMessage(chatId, rawMsg, personalizedLink);"""

NEW_DELIVER_SEND = """    const result = await this._sendMessage(chatId, rawMsg, personalizedLink, prefetchedChat);"""

# sendAndVerify: when we have chat with @lid id, don't force @c.us if chat object provided
OLD_SAV = """  let sendChatId = chatId;
  if (sendChatId.includes('@lid') || !sendChatId.includes('@')) {
    sendChatId = phoneToCusChatId(phoneDigits || chatId);
  }"""

NEW_SAV = """  let sendChatId = chatId;
  const useChatObject = !!chatForTyping;
  if (!useChatObject && (sendChatId.includes('@lid') || !sendChatId.includes('@'))) {
    sendChatId = phoneToCusChatId(phoneDigits || chatId);
  }
  if (useChatObject && chatForTyping.id?._serialized) {
    sendChatId = chatForTyping.id._serialized;
  }"""

for old, new, name in [
    (OLD_DELIVER, NEW_DELIVER, "deliver"),
    (OLD_SENDMSG, NEW_SENDMSG, "sendmsg"),
    (OLD_DELIVER_SEND, NEW_DELIVER_SEND, "deliverSend"),
    (OLD_SAV, NEW_SAV, "sav"),
]:
    if old not in t:
        raise SystemExit(f"missing {name}")
    t = t.replace(old, new, 1)

# health features
if "coldContactSync" not in t:
    t = t.replace(
        "combinedLinkMessage: !useSplitLinkMessages()",
        "combinedLinkMessage: !useSplitLinkMessages(), coldContactSync: true",
        1,
    )

INDEX.write_text(t, encoding="utf-8")
print("ok")
