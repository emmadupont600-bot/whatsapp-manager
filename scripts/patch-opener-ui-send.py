#!/usr/bin/env python3
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

# 1) Always use Hey unless explicitly disabled (history no longer skips opener by default)
OLD_OPENER_FN = """function shouldUseManualOpener(phoneDigits, isColdContact) {
  if (process.env.COLD_OPENER_MESSAGE === '0') return false;
  if (process.env.OPENER_ALWAYS === '1') return true;
  if (isColdContact) return true;
  if (!phoneHadSuccessfulSend(phoneDigits)) return true;
  return false;
}"""

NEW_OPENER_FN = """function shouldUseManualOpener(phoneDigits, isColdContact) {
  if (process.env.COLD_OPENER_MESSAGE === '0') return false;
  if (process.env.OPENER_SKIP_IF_SENT === '1' && phoneHadSuccessfulSend(phoneDigits)) return false;
  return true;
}"""

if OLD_OPENER_FN in t:
    t = t.replace(OLD_OPENER_FN, NEW_OPENER_FN, 1)

# 2) Replace openChatViaSearchUI entirely with stronger version
start = t.find("async function openChatViaSearchUI(client, phoneDigits, logger) {")
end = t.find("\nasync function prepareOutboundChat(client, phoneDigits, logger) {")
if start < 0 or end < 0:
    raise SystemExit("openChatViaSearchUI block not found")

NEW_UI = r'''async function openChatViaStore(client, phoneDigits, logger) {
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

async function sendTextViaComposerUI(page, text, logger, label) {
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
      if (logger) logger(`⌨️ Envoyé via zone de saisie WhatsApp (${label})`, 'info');
      await sleep(2000);
      return true;
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
'''

t = t[:start] + NEW_UI + t[end:]

# 3) _sendMessage: optional UI send for opener label
if "async function sendSingleOutbound" not in t:
    inject = r'''
async function sendSingleOutbound(client, chatId, text, label, logger, prefetchedChat, opts = {}) {
  const pn = chatId.split('@')[0].replace(/\D/g, '');
  const useUi = process.env.UI_SEND_OPENER !== '0' && (opts.viaUi || label === 'hey-ui' || label === 'opener-ui');
  if (useUi && client.pupPage && (label.includes('hey') || label.includes('opener') || opts.viaUi)) {
    await openChatViaStore(client, pn, logger);
    const uiOk = await sendTextViaComposerUI(client.pupPage, text, logger, label);
    if (uiOk) return { id: 'ui-sent', verified: true, viaUi: true };
    if (logger) logger(`⚠️ Envoi UI échoué (${label}) — repli API`, 'warn');
  }
  return sendAndVerify(client, chatId, text, label, logger, prefetchedChat, pn, opts);
}
'''
    t = t.replace("async function sendAndVerify(client, chatId, text, label, logger", inject + "\nasync function sendAndVerify(client, chatId, text, label, logger", 1)

# Replace doSend in _sendMessage to use sendSingleOutbound
OLD_DO = """    const ackSoft = !!((opts.coldContact || opts.manualOpener) && useAckColdSoft());
    const doSend = async (text, label, useTypingChat) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const result = await sendAndVerify(this.client, chatId, text, label, this.log.bind(this), useTypingChat, pn, { ackSoft });
      ids.push(result.id);
      return result.id;
    };"""

NEW_DO = """    const ackSoft = !!((opts.coldContact || opts.manualOpener) && useAckColdSoft());
    const doSend = async (text, label, useTypingChat, extra = {}) => {
      const pn = chatId.split('@')[0].replace(/\\D/g, '');
      const sendLabel = extra.viaUi ? 'hey-ui' : label;
      const result = await sendSingleOutbound(
        this.client, chatId, text, sendLabel, this.log.bind(this), useTypingChat,
        { ackSoft, viaUi: extra.viaUi, manualOpener: opts.manualOpener }
      );
      ids.push(result.id);
      return result.id;
    };"""

if OLD_DO in t:
    t = t.replace(OLD_DO, NEW_DO, 1)

# Opener send via UI
OLD_OPENER_CALL = "      const openerResult = await this._sendMessage(sendId, openerText, '', prefetchedChat, sendOpts);"
NEW_OPENER_CALL = """      let openerResult;
      if (process.env.UI_SEND_OPENER !== '0') {
        await openChatViaStore(this.client, number, this.log.bind(this));
        const uiHey = await sendTextViaComposerUI(this.client.pupPage, openerText, this.log.bind(this), 'hey');
        openerResult = uiHey
          ? { messageCount: 1, ids: ['ui-sent'], lastId: 'ui-sent' }
          : await this._sendMessage(sendId, openerText, '', prefetchedChat, { ...sendOpts, manualOpener: true });
      } else {
        openerResult = await this._sendMessage(sendId, openerText, '', prefetchedChat, sendOpts);
      }"""

if OLD_OPENER_CALL in t:
    t = t.replace(OLD_OPENER_CALL, NEW_OPENER_CALL, 1)

# Fix logging in _deliverToNumber
t = t.replace(
    """    if (combined && linkBase) {
      this.log('📨 Envoi en 1 message (texte + lien combinés)', 'info');
    }
    const useOpener = shouldUseManualOpener(number, isColdContact);""",
    """    const useOpener = shouldUseManualOpener(number, isColdContact);""",
    1,
)
t = t.replace(
    """    } else if (combined) {
      this.log('📨 Envoi direct (déjà contacté avec succès avant)', 'info');
    }""",
    """    }""",
    1,
)

if "splitRoute" in t and "this.log(`📨 Parcours manuel" not in t:
    t = t.replace(
        "    if (useOpener && openerText) {\n      this.log(`👋 Étape 1 (comme manuel) : \"${openerText}\" puis campagne`, 'info');",
        "    if (splitRoute && openerText) {\n      this.log('📨 Parcours manuel : Hey → texte → lien (3 messages)', 'info');\n    } else if (splitRoute) {\n      this.log('📨 Parcours : texte puis lien (2 messages)', 'info');\n    }\n    if (useOpener && openerText) {\n      this.log(`👋 Étape 1 (comme manuel) : \"${openerText}\" puis campagne`, 'info');",
        1,
    )

P.write_text(t, encoding="utf-8")
print("lines", len(t.splitlines()))
