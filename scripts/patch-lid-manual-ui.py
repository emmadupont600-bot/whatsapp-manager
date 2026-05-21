#!/usr/bin/env python3
"""Fix @lid send path + UI search open + Hey before campaign like manual WhatsApp."""
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

HELPERS = """
function normalizeOutboundChatId(_chatId, phoneDigits) {
  return phoneToCusChatId(phoneDigits);
}

function phoneHadSuccessfulSend(phone) {
  const entry = getHistoryEntry(phone);
  return !!(entry && entry.contacts && entry.contacts.length > 0);
}

function shouldUseManualOpener(phoneDigits, isColdContact) {
  if (process.env.COLD_OPENER_MESSAGE === '0') return false;
  if (process.env.OPENER_ALWAYS === '1') return true;
  if (isColdContact) return true;
  if (!phoneHadSuccessfulSend(phoneDigits)) return true;
  return false;
}

function useManualRouteSplit() {
  return process.env.MANUAL_ROUTE_SPLIT !== '0';
}
"""

if "function normalizeOutboundChatId" not in t:
    t = t.replace("function phoneToCusChatId(number) {", HELPERS + "\nfunction phoneToCusChatId(number) {", 1)

UI_FN = r'''
async function openChatViaSearchUI(client, phoneDigits, logger) {
  const page = client.pupPage;
  if (!page) return false;
  const phone = String(phoneDigits).replace(/\D/g, '');
  const query = phone.length >= 10 && !phone.startsWith('+') ? `+${phone}` : `+${phone}`;

  const selectors = [
    'div[contenteditable="true"][data-tab="3"]',
    '#side div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Search" i][contenteditable="true"]',
    'div[aria-label*="Recherch" i][contenteditable="true"]',
    'div[title*="Search" i][contenteditable="true"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(query, { delay: 40 });
      await sleep(2000);
      const clicked = await page.evaluate((q) => {
        const norm = (s) => (s || '').replace(/\D/g, '');
        const qn = norm(q);
        const tryClick = (el) => {
          if (!el) return false;
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.click();
          return true;
        };
        for (const el of document.querySelectorAll('div[role="button"], button, span')) {
          const t = (el.textContent || '').trim();
          if (/^(discuter|message|discuss|chat)$/i.test(t) || /discuter avec/i.test(t)) {
            if (tryClick(el)) return 'discuss_btn';
          }
        }
        for (const row of document.querySelectorAll('[data-testid="cell-frame-container"], div[role="listitem"]')) {
          const txt = norm(row.textContent || '');
          if (txt.includes(qn) || txt.includes(qn.slice(-9))) {
            if (tryClick(row)) return 'search_row';
          }
        }
        return null;
      }, query);
      if (clicked) {
        if (logger) logger(`🔍 Chat ouvert via recherche WhatsApp (${clicked})`, 'info');
        await sleep(1200);
        return true;
      }
    } catch (e) {
      if (logger) logger(`⚠️ Recherche UI (${sel}) : ${e.message}`, 'warn');
    }
  }

  try {
    const ok = await withTimeout(page.evaluate(async (q) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const paste = (el, text) => {
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      };
      let input = document.querySelector('div[contenteditable="true"][data-tab="3"]')
        || document.querySelector('#side div[contenteditable="true"][role="textbox"]');
      if (!input) return { ok: false, err: 'no_input' };
      paste(input, q);
      await sleep(2200);
      const nodes = [...document.querySelectorAll('[data-testid="cell-frame-container"], div[role="listitem"]')];
      if (nodes[0]) { nodes[0].click(); await sleep(600); return { ok: true, via: 'paste_row' }; }
      return { ok: false, err: 'no_row' };
    }, query), 20000, 'searchUI paste');
    if (ok.ok) {
      if (logger) logger(`🔍 Chat ouvert via collage recherche (${ok.via})`, 'info');
      await sleep(1000);
      return true;
    }
    if (logger) logger(`⚠️ Recherche UI collage : ${ok.err}`, 'warn');
  } catch (e) {
    if (logger) logger(`⚠️ Recherche UI collage : ${e.message}`, 'warn');
  }
  return false;
}
'''

if "async function openChatViaSearchUI" not in t:
    t = t.replace("async function prepareOutboundChat(client, phoneDigits, logger) {", UI_FN + "\nasync function prepareOutboundChat(client, phoneDigits, logger) {", 1)

# prepareOutboundChat: DOM open + force cus chatId at end
OLD_PREP_END = """  if (isColdContact) {
    const coldMs = parseInt(process.env.COLD_CONTACT_DELAY_MS || '15000', 10);
    if (logger) logger(`⏳ Délai nouveau contact : ${(coldMs / 1000).toFixed(0)}s`, 'info');
    await sleep(coldMs);
  }

  return { chatId, chat, isColdContact, isKnownContact };
}"""

NEW_PREP_END = """  if (process.env.MANUAL_SEARCH_DOM !== '0') {
    await openChatViaSearchUI(client, phoneDigits, logger);
  }

  if (isColdContact) {
    const coldMs = parseInt(process.env.COLD_CONTACT_DELAY_MS || '15000', 10);
    if (logger) logger(`⏳ Délai nouveau contact : ${(coldMs / 1000).toFixed(0)}s`, 'info');
    await sleep(coldMs);
  }

  chatId = cusId;
  return { chatId, chat, isColdContact, isKnownContact };
}"""

if OLD_PREP_END in t:
    t = t.replace(OLD_PREP_END, NEW_PREP_END, 1)

# After prep.ok block, force chatId to cus when serialized is lid
if "if (prep.chatId && prep.chatId.includes('@lid')" not in t:
    t = t.replace(
        "    chatId = prep.chatId || cusId;",
        "    if (prep.chatId && prep.chatId.includes('@lid') && logger) {\n      logger(`ℹ️ Chat interne LID détecté — envoi forcé via ${cusId}`, 'info');\n    }\n    chatId = cusId;",
        1,
    )

# sendAndVerify: never send via @lid
OLD_SENDID = """  if (useChatObject && chatForTyping.id?._serialized) {
    sendChatId = chatForTyping.id._serialized;
  }"""

NEW_SENDID = """  sendChatId = normalizeOutboundChatId(sendChatId, phoneDigits || chatId);"""

if OLD_SENDID in t:
    t = t.replace(OLD_SENDID, NEW_SENDID, 1)
elif "sendChatId = chatForTyping.id._serialized" in t:
    t = t.replace(
        "  if (useChatObject && chatForTyping.id?._serialized) {\n    sendChatId = chatForTyping.id._serialized;\n  }",
        "  sendChatId = normalizeOutboundChatId(sendChatId, phoneDigits || chatId);",
        1,
    )

# _deliverToNumber: cus for register + opener logic + split text/link
OLD_DELIVER_START = """    const { chatId, chat: prefetchedChat, isColdContact } = await prepareOutboundChat(this.client, number, this.log.bind(this));
    if (!skipProbe) {
      try {
        await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
      } catch (e) {
        this.log(`⚠️ ${e.message}`, 'warn');
      }
    }
    if (!await safeIsRegisteredUser(this.client, chatId, this.log.bind(this))) {
      throw new Error(`+${number} n'est pas sur WhatsApp`);
    }"""

NEW_DELIVER_START = """    const { chatId, chat: prefetchedChat, isColdContact } = await prepareOutboundChat(this.client, number, this.log.bind(this));
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
    }"""

if OLD_DELIVER_START in t:
    t = t.replace(OLD_DELIVER_START, NEW_DELIVER_START, 1)

OLD_OPENER_BLOCK = """    let msgCount = countOutboundMessages(rawMsg, personalizedLink);
    const openerForQuota = isColdContact ? getColdOpenerText() : '';
    if (openerForQuota) msgCount += 1;"""

NEW_OPENER_BLOCK = """    const useOpener = shouldUseManualOpener(number, isColdContact);
    const openerText = useOpener ? getColdOpenerText() : '';
    const splitRoute = useManualRouteSplit() && combined && !!(linkBase && linkBase.trim());
    let msgCount = countOutboundMessages(rawMsg, personalizedLink);
    if (openerText) msgCount += 1;
    if (splitRoute) msgCount += 1;"""

if OLD_OPENER_BLOCK in t:
    t = t.replace(OLD_OPENER_BLOCK, NEW_OPENER_BLOCK, 1)

OLD_OPENER_SEND = """    const opener = isColdContact ? getColdOpenerText() : '';
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
    return { chatId, number, rawMsg, personalizedLink, msgCount, result, combined, openerUsed: !!opener };"""

NEW_OPENER_SEND = """    if (useOpener && openerText) {
      this.log(`👋 Étape 1 (comme manuel) : "${openerText}" puis campagne`, 'info');
      await sleep(rand(400, 1200));
    } else if (combined) {
      this.log('📨 Envoi direct (déjà contacté avec succès avant)', 'info');
    }
    this._recordFirstSend();
    const sendOpts = { coldContact: isColdContact || useOpener };
    let result;
    const sendId = cusChatId;
    if (openerText) {
      const openerResult = await this._sendMessage(sendId, openerText, '', prefetchedChat, sendOpts);
      await sleep(COLD_OPENER_DELAY_MS);
      if (splitRoute) {
        const textOnly = personalizeMessage((message ?? contact.message ?? '').trim() || process.env.DEFAULT_MESSAGE || '', contact);
        const linkOnly = personalizeMessage((link ?? contact.link ?? '').trim(), contact);
        const textResult = await this._sendMessage(sendId, textOnly, '', prefetchedChat, sendOpts);
        await sleep(rand(config.linkDelayMin, config.linkDelayMax));
        const linkResult = await this._sendMessage(sendId, linkOnly, '', prefetchedChat, sendOpts);
        result = {
          messageCount: openerResult.messageCount + textResult.messageCount + linkResult.messageCount,
          ids: [...(openerResult.ids || []), ...(textResult.ids || []), ...(linkResult.ids || [])],
          lastId: linkResult.lastId
        };
      } else {
        const mainResult = await this._sendMessage(sendId, rawMsg, personalizedLink, prefetchedChat, sendOpts);
        result = {
          messageCount: openerResult.messageCount + mainResult.messageCount,
          ids: [...(openerResult.ids || []), ...(mainResult.ids || [])],
          lastId: mainResult.lastId
        };
      }
    } else if (splitRoute) {
      const textOnly = personalizeMessage((message ?? contact.message ?? '').trim() || process.env.DEFAULT_MESSAGE || '', contact);
      const linkOnly = personalizeMessage((link ?? contact.link ?? '').trim(), contact);
      const textResult = await this._sendMessage(sendId, textOnly, '', prefetchedChat, sendOpts);
      await sleep(rand(config.linkDelayMin, config.linkDelayMax));
      const linkResult = await this._sendMessage(sendId, linkOnly, '', prefetchedChat, sendOpts);
      result = {
        messageCount: textResult.messageCount + linkResult.messageCount,
        ids: [...(textResult.ids || []), ...(linkResult.ids || [])],
        lastId: linkResult.lastId
      };
    } else {
      result = await this._sendMessage(sendId, rawMsg, personalizedLink, prefetchedChat, sendOpts);
    }
    this.state.sessionHealthy = true;
    return { chatId: sendId, number, rawMsg, personalizedLink, msgCount, result, combined, openerUsed: !!openerText, splitRoute };"""

if OLD_OPENER_SEND in t:
    t = t.replace(OLD_OPENER_SEND, NEW_OPENER_SEND, 1)

# ackSoft for useOpener too
OLD_ACKSOFT = "const ackSoft = !!(opts.coldContact && useAckColdSoft());"
NEW_ACKSOFT = "const ackSoft = !!((opts.coldContact || opts.manualOpener) && useAckColdSoft());"
if OLD_ACKSOFT in t:
    t = t.replace(OLD_ACKSOFT, NEW_ACKSOFT, 1)

OLD_SENDOPTS = "const sendOpts = { coldContact: isColdContact || useOpener };"
if OLD_SENDOPTS in t:
    t = t.replace(OLD_SENDOPTS, "const sendOpts = { coldContact: isColdContact || useOpener, manualOpener: useOpener };", 1)

# health
if "manualSearchDom" not in t:
    t = t.replace(
        "ackColdSoft: true }",
        "ackColdSoft: true, manualSearchDom: true, manualRouteSplit: true }",
        1,
    )

P.write_text(t, encoding="utf-8")
print("ok", len(t.splitlines()))
