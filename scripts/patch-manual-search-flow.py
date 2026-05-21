#!/usr/bin/env python3
"""Mimic manual WhatsApp flow: search → open chat → short opener → main message."""
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

ENV_BLOCK = """
const MANUAL_SEARCH_FLOW = process.env.MANUAL_SEARCH_FLOW !== '0';
const COLD_OPENER_DELAY_MS = parseInt(process.env.COLD_OPENER_DELAY_MS || '8000', 10);

function getColdOpenerText() {
  if (process.env.COLD_OPENER_MESSAGE === '0') return '';
  return (process.env.COLD_OPENER_MESSAGE || 'Hey').trim();
}

function useAckColdSoft() {
  return process.env.ACK_COLD_SOFT !== '0';
}
"""

if "function getColdOpenerText" not in t:
    t = t.replace(
        "const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);",
        "const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);" + ENV_BLOCK,
        1,
    )

# sendAndVerify: add opts + ack soft recovery
OLD_ACK_CATCH = """  } catch (ackErr) {
    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) throw new Error(ackErr.message);
    if (logger) logger(`⚠️ ${ackErr.message} — vérif historique...`, 'warn');
  }"""

NEW_ACK_CATCH = """  } catch (ackErr) {
    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) {
      if (opts.ackSoft && verifyChat) {
        try {
          await verifyMessageInChat(verifyChat, text, msgId, label, { softFail: false, logger });
          if (logger) logger(`⚠️ ACK_ERROR mais message visible (${label}) — envoi accepté (comme manuel)`, 'warn');
          return { id: msgId, verified: true, ackSoftOk: true };
        } catch (_) {}
      }
      throw new Error(ackErr.message);
    }
    if (logger) logger(`⚠️ ${ackErr.message} — vérif historique...`, 'warn');
  }"""

if OLD_ACK_CATCH in t:
    t = t.replace(OLD_ACK_CATCH, NEW_ACK_CATCH, 1)

OLD_SEND_VERIFY_SIG = "async function sendAndVerify(client, chatId, text, label, logger, chatForTyping = null, phoneDigits = null) {"
NEW_SEND_VERIFY_SIG = "async function sendAndVerify(client, chatId, text, label, logger, chatForTyping = null, phoneDigits = null, opts = {}) {"
if OLD_SEND_VERIFY_SIG in t and "opts = {}" not in t.split("async function sendAndVerify")[1][:80]:
    t = t.replace(OLD_SEND_VERIFY_SIG, NEW_SEND_VERIFY_SIG, 1)

# prepareOutboundChat: inject manual search at start of evaluate (after cusWid)
OLD_PREP_START = """        const cusWid = WidFactory.createWid(phone + '@c.us');
        let chat = Collections.Chat.get(cusWid);
        let synced = false;

        if (!chat) {
          chat = (await FindChat.findOrCreateLatestChat(cusWid).catch(() => null))?.chat;
        }"""

NEW_PREP_START = """        const cusWid = WidFactory.createWid(phone + '@c.us');
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
        }"""

if OLD_PREP_START in t:
    t = t.replace(OLD_PREP_START, NEW_PREP_START, 1)

# Return manualOpened in prep result
if "manualOpened" not in t.split("return {")[2][:400] if t.count("return {") > 2 else True:
    t = t.replace(
        """        return {
          ok: true,
          chatId: serialized,
          synced,
          hasWaHistory,
          isMyContact,
          isCold: !hasWaHistory && !isMyContact
        };""",
        """        return {
          ok: true,
          chatId: serialized,
          synced,
          manualOpened,
          hasWaHistory,
          isMyContact,
          isCold: !hasWaHistory && !isMyContact
        };""",
        1,
    )

if "prep.manualOpened" not in t:
    t = t.replace(
        "    if (prep.synced && logger) logger(`🔗 Contact synchronisé WhatsApp (LID) pour +${phoneDigits}`, 'info');",
        "    if (prep.manualOpened && logger) logger(`🔍 Chat ouvert (flux recherche / Discuter) pour +${phoneDigits}`, 'info');\n    if (prep.synced && logger) logger(`🔗 Contact synchronisé WhatsApp (LID) pour +${phoneDigits}`, 'info');",
        1,
    )

# _sendMessage: pass coldContact opts to sendAndVerify
OLD_DO_SEND = """    const doSend = async (text, label, useTypingChat) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const result = await sendAndVerify(this.client, chatId, text, label, this.log.bind(this), useTypingChat, pn);
      ids.push(result.id);
      return result.id;
    };"""

NEW_DO_SEND = """    const ackSoft = !!(opts.coldContact && useAckColdSoft());
    const doSend = async (text, label, useTypingChat) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const result = await sendAndVerify(this.client, chatId, text, label, this.log.bind(this), useTypingChat, pn, { ackSoft });
      ids.push(result.id);
      return result.id;
    };"""

if OLD_DO_SEND in t:
    t = t.replace(
        "  async _sendMessage(chatId, rawMsg, link, prefetchedChat = null) {",
        "  async _sendMessage(chatId, rawMsg, link, prefetchedChat = null, opts = {}) {",
        1,
    )
    t = t.replace(OLD_DO_SEND, NEW_DO_SEND, 1)

# _deliverToNumber: cold opener + pass opts to _sendMessage
OLD_DELIVER_SEND = """    this._recordFirstSend();
    const result = await this._sendMessage(chatId, rawMsg, personalizedLink, prefetchedChat);
    this.state.sessionHealthy = true;
    return { chatId, number, rawMsg, personalizedLink, msgCount, result, combined };"""

NEW_DELIVER_SEND = """    const opener = isColdContact ? getColdOpenerText() : '';
    if (opener) {
      this.log(`👋 Étape 1 (comme manuel) : "${opener}" puis message campagne`, 'info');
      await sleep(rand(400, 1200));
    }
    this._recordFirstSend();
    const sendOpts = { coldContact: isColdContact };
    let result;
    if (opener) {
      const openerResult = await this._sendMessage(chatId, opener, '', prefetchedChat, sendOpts);
      await sleep(COLD_OPENER_DELAY_MS);
      const mainResult = await this._sendMessage(chatId, rawMsg, personalizedLink, prefetchedChat, sendOpts);
      result = {
        messageCount: openerResult.messageCount + mainResult.messageCount,
        ids: [...(openerResult.ids || []), ...(mainResult.ids || [])],
        lastId: mainResult.lastId
      };
    } else {
      result = await this._sendMessage(chatId, rawMsg, personalizedLink, prefetchedChat, sendOpts);
    }
    this.state.sessionHealthy = true;
    const totalMsgCount = opener ? msgCount + 1 : msgCount;
    return { chatId, number, rawMsg, personalizedLink, msgCount: totalMsgCount, result, combined, openerUsed: !!opener };"""

if OLD_DELIVER_SEND in t:
    t = t.replace(OLD_DELIVER_SEND, NEW_DELIVER_SEND, 1)

# Fix quota check before opener - need extra slot for opener
OLD_MSG_COUNT = """    const msgCount = countOutboundMessages(rawMsg, personalizedLink);
    if (msgCount === 0) throw new Error('Message vide');
    if (msgCount > this._messagesAvailable()) {"""

NEW_MSG_COUNT = """    let msgCount = countOutboundMessages(rawMsg, personalizedLink);
    const openerForQuota = isColdContact ? getColdOpenerText() : '';
    if (openerForQuota) msgCount += 1;
    if (msgCount === 0) throw new Error('Message vide');
    if (msgCount > this._messagesAvailable()) {"""

if OLD_MSG_COUNT in t:
    t = t.replace(OLD_MSG_COUNT, NEW_MSG_COUNT, 1)

# health features
if "manualSearchFlow" not in t:
    t = t.replace(
        "coldContactSync: true }",
        "coldContactSync: true, manualSearchFlow: true, coldOpener: true, ackColdSoft: true }",
        1,
    )

# Softer reject log message
t = t.replace(
    "compte peut être limité). Reprenez plus tard ou Compte 2.",
    "échec technique ou anti-spam ciblé — pas forcément un ban complet. Testez un envoi manuel sur ce numéro.",
    1,
)

P.write_text(t, encoding="utf-8")
print("ok", len(t.splitlines()), "lines")
