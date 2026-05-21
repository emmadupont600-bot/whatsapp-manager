#!/usr/bin/env python3
"""Ne plus marquer envoyé si ACK_ERROR — vérification stricte (évite faux positifs / session fantôme)."""
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "index.js"
t = P.read_text(encoding="utf-8")

t = t.replace(
    "function useAckColdSoft() {\n  return process.env.ACK_COLD_SOFT !== '0';\n}",
    "function useAckColdSoft() {\n  return process.env.ACK_COLD_SOFT === '1';\n}",
    1,
)

OLD_VERIFY = """async function verifyMessageInChat(chat, text, msgId, label, opts = {}) {
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

NEW_VERIFY = """function messageAckIsDelivered(ack) {
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
}"""

if OLD_VERIFY in t:
    t = t.replace(OLD_VERIFY, NEW_VERIFY, 1)
else:
    raise SystemExit("verifyMessageInChat block not found")

# ACK_ERROR: never accept as success (remove ackSoft return)
OLD_ACK_SOFT = """    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) {
      if (opts.ackSoft && verifyChat) {
        try {
          await verifyMessageInChat(verifyChat, text, msgId, label, { softFail: false, logger });
          if (logger) logger(`⚠️ ACK_ERROR mais message visible (${label}) — envoi accepté (comme manuel)`, 'warn');
          return { id: msgId, verified: true, ackSoftOk: true };
        } catch (_) {}
      }
      throw new Error(ackErr.message);
    }"""

NEW_ACK_SOFT = """    if (/rejeté|ACK_ERROR/i.test(ackErr.message)) {
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
    }"""

if OLD_ACK_SOFT in t:
    t = t.replace(OLD_ACK_SOFT, NEW_ACK_SOFT, 1)

# sendTextViaComposerUI: require client + verify
OLD_UI_FN = "async function sendTextViaComposerUI(page, text, logger, label) {"
NEW_UI_FN = "async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {\n  const page = client.pupPage;"
if OLD_UI_FN in t and "async function sendTextViaComposerUI(client, cusChatId" not in t:
    t = t.replace(
        "async function sendTextViaComposerUI(page, text, logger, label) {\n  const selectors = [",
        "async function sendTextViaComposerUI(client, cusChatId, text, logger, label) {\n  const page = client.pupPage;\n  if (!page) return false;\n  const selectors = [",
        1,
    )
    t = t.replace(
        "      await page.keyboard.press('Enter');\n      if (logger) logger(`⌨️ Envoyé via zone de saisie WhatsApp (${label})`, 'info');\n      await sleep(2000);\n      return true;",
        """      await page.keyboard.press('Enter');
      if (logger) logger(`⌨️ Saisie UI (${label}) — vérification livraison...`, 'info');
      await sleep(3500);
      try {
        const chat = await withTimeout(client.getChatById(cusChatId), 12000, 'verify UI send');
        await verifyMessageInChat(chat, text, null, label, { strict: true, maxAgeMs: 35000, logger });
        if (logger) logger(`✔️ Message UI confirmé dans le chat (${label})`, 'info');
        return true;
      } catch (verr) {
        if (logger) logger(`❌ UI composer : pas confirmé dans le chat — ${verr.message}`, 'error');
        return false;
      }""",
        1,
    )

# sendSingleOutbound UI call
t = t.replace(
    "const uiOk = await sendTextViaComposerUI(client.pupPage, text, logger, label);",
    "const uiOk = await sendTextViaComposerUI(client, normalizeOutboundChatId(chatId, pn), text, logger, label);",
    1,
)
t = t.replace(
    "if (uiOk) return { id: 'ui-sent', verified: true, viaUi: true };",
    "if (uiOk) return { id: 'ui-verified', verified: true, viaUi: true };",
    1,
)

# opener UI calls
t = t.replace(
    "const uiHey = await sendTextViaComposerUI(this.client.pupPage, openerText, this.log.bind(this), 'hey');",
    "const uiHey = await sendTextViaComposerUI(this.client, sendId, openerText, this.log.bind(this), 'hey');",
    1,
)
t = t.replace(
    "? { messageCount: 1, ids: ['ui-sent'], lastId: 'ui-sent' }",
    "? { messageCount: 1, ids: ['ui-verified'], lastId: 'ui-verified' }",
    1,
)

# runQueue: fail on ackSoftOk in result ids path - check _deliverToNumber return
# Add deliveryVerified flag on sendAndVerify return - _sendMessage propagates
# Simpler: in runQueue after deliver, check result.lastId !== ack soft - actually we throw now on ACK_ERROR unless ACK_COLD_SOFT=1

# Require minimum ACK_SERVER for success when REQUIRE_ACK_DEVICE=1
if "REQUIRE_ACK_DEVICE" not in t:
    t = t.replace(
        "const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);",
        "const MSG_ACK_TIMEOUT_MS = parseInt(process.env.MSG_ACK_TIMEOUT_MS || '25000', 10);\nconst REQUIRE_ACK_DEVICE = process.env.REQUIRE_ACK_DEVICE === '1';",
        1,
    )
    t = t.replace(
        "      if (ack >= MessageAck.ACK_SERVER) {\n        clearTimeout(timer);\n        client.removeListener('message_ack', onAck);\n        resolve(ack);\n      }",
        "      const minAck = REQUIRE_ACK_DEVICE ? MessageAck.ACK_DEVICE : MessageAck.ACK_SERVER;\n      if (ack >= minAck) {\n        clearTimeout(timer);\n        client.removeListener('message_ack', onAck);\n        resolve(ack);\n      }",
        1,
    )

# health ackColdSoft default
t = t.replace("ackColdSoft: true", "ackColdSoft: false", 1)

P.write_text(t, encoding="utf-8")
print("ok")
