#!/usr/bin/env python3
from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "index.js"
t = INDEX.read_text(encoding="utf-8")

INSERT = """function useSplitLinkMessages() {
  return process.env.SPLIT_LINK_MESSAGE === '1';
}

/** Par défaut : 1 seul message (texte + lien), comme le test. SPLIT_LINK_MESSAGE=1 pour 2 messages séparés. */
function prepareOutboundContent(rawMsg, link) {
  const text = (rawMsg || '').trim();
  const lnk = (link || '').trim();
  if (useSplitLinkMessages()) return { rawMsg: text, link: lnk, combined: false };
  if (lnk && text) return { rawMsg: `${text}\\n\\n${lnk}`, link: '', combined: true };
  if (lnk && !text) return { rawMsg: lnk, link: '', combined: true };
  return { rawMsg: text, link: '', combined: false };
}

"""

OLD_COUNT = """function countOutboundMessages(rawMsg, link) {
  const text = (rawMsg || '').trim();
  const separateLink = !!(link && link.trim());
  if (separateLink && text) return 2;
  if (separateLink && !text) return 1;
  const parts = splitMessageAndLink(text);
  if (parts) return parts.text ? 2 : 1;
  return text ? 1 : 0;
}"""

NEW_COUNT = """function countOutboundMessages(rawMsg, link) {
  const { rawMsg: body, link: outLink } = prepareOutboundContent(rawMsg, link);
  const text = (body || '').trim();
  const separateLink = useSplitLinkMessages() && !!(outLink && outLink.trim());
  if (separateLink && text) return 2;
  if (separateLink && !text) return 1;
  if (!useSplitLinkMessages()) return text ? 1 : 0;
  const parts = splitMessageAndLink(text);
  if (parts) return parts.text ? 2 : 1;
  return text ? 1 : 0;
}"""

OLD_DELIVER = """  async _deliverToNumber(number, contact, { message, link } = {}) {
    const chatId = await resolveOutboundChatId(this.client, number, this.log.bind(this));
    try {
      await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
    } catch (e) {
      this.log(`⚠️ ${e.message}`, 'warn');
    }
    if (!await safeIsRegisteredUser(this.client, chatId, this.log.bind(this))) {
      throw new Error(`+${number} n'est pas sur WhatsApp`);
    }
    const rawMsg = personalizeMessage(
      (message ?? contact.message ?? '').trim() || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋',
      contact
    );
    const personalizedLink = personalizeMessage((link ?? contact.link ?? '').trim(), contact);
    const msgCount = countOutboundMessages(rawMsg, personalizedLink);
    if (msgCount === 0) throw new Error('Message vide');
    if (msgCount > this._messagesAvailable()) {
      throw new Error(`Quota insuffisant : ${msgCount} message(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`);
    }
    if (!(await this._waitForHourlyCapacity(msgCount))) {
      throw new Error('Envoi annulé : limite horaire');
    }
    this._recordFirstSend();
    const result = await this._sendMessage(chatId, rawMsg, personalizedLink);
    this.state.sessionHealthy = true;
    return { chatId, number, rawMsg, personalizedLink, msgCount, result };
  }"""

NEW_DELIVER = """  async _deliverToNumber(number, contact, { message, link, skipProbe = false } = {}) {
    const chatId = await resolveOutboundChatId(this.client, number, this.log.bind(this));
    if (!skipProbe) {
      try {
        await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
      } catch (e) {
        this.log(`⚠️ ${e.message}`, 'warn');
      }
    }
    if (!await safeIsRegisteredUser(this.client, chatId, this.log.bind(this))) {
      throw new Error(`+${number} n'est pas sur WhatsApp`);
    }
    const rawMsgBase = personalizeMessage(
      (message ?? contact.message ?? '').trim() || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋',
      contact
    );
    const linkBase = personalizeMessage((link ?? contact.link ?? '').trim(), contact);
    const { rawMsg, link: personalizedLink, combined } = prepareOutboundContent(rawMsgBase, linkBase);
    if (combined && linkBase) {
      this.log('📨 Envoi en 1 message (texte + lien combinés)', 'info');
    }
    const msgCount = countOutboundMessages(rawMsg, personalizedLink);
    if (msgCount === 0) throw new Error('Message vide');
    if (msgCount > this._messagesAvailable()) {
      throw new Error(`Quota insuffisant : ${msgCount} message(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`);
    }
    if (!(await this._waitForHourlyCapacity(msgCount))) {
      throw new Error('Envoi annulé : limite horaire');
    }
    this._recordFirstSend();
    const result = await this._sendMessage(chatId, rawMsg, personalizedLink);
    this.state.sessionHealthy = true;
    return { chatId, number, rawMsg, personalizedLink, msgCount, result, combined };
  }"""

OLD_SENDMSG_LINK = """    if (link && link.trim()) {
      const text = (rawMsg || '').trim();
      if (text) {
        await this._typing(chat);
        await doSend(text, 'texte', chat);
        const delay = rand(config.linkDelayMin, config.linkDelayMax);
        this.log(`⏱ Délai anti-ban avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
        await sleep(delay);
      }
      await this._typing(chat);
      await doSend(link.trim(), 'lien', null);
      assertDistinctMessageIds(ids);
      return { messageCount: text ? 2 : 1, ids, lastId: ids[ids.length - 1] };
    }
    const parts = splitMessageAndLink(rawMsg);"""

NEW_SENDMSG_LINK = """    if (useSplitLinkMessages() && link && link.trim()) {
      const text = (rawMsg || '').trim();
      if (text) {
        await this._typing(chat);
        await doSend(text, 'texte', chat);
        const delay = rand(config.linkDelayMin, config.linkDelayMax);
        this.log(`⏱ Délai anti-ban avant lien : ${(delay/1000).toFixed(1)}s`, 'info');
        await sleep(delay);
      }
      await this._typing(chat);
      await doSend(link.trim(), 'lien', null);
      assertDistinctMessageIds(ids);
      return { messageCount: text ? 2 : 1, ids, lastId: ids[ids.length - 1] };
    }
    const parts = useSplitLinkMessages() ? splitMessageAndLink(rawMsg) : null;"""

OLD_QUEUE_START = """    this.log(`🚀 Démarrage : ${pendingCount} contact(s) · quota ${this.state.dailySent}/${this.dailyLimit} msgs WA`,'success');

    try {
      while (this.state.queue.some(c => c.status === 'pending')) {"""

NEW_QUEUE_START = """    this.log(`🚀 Démarrage : ${pendingCount} contact(s) · quota ${this.state.dailySent}/${this.dailyLimit} msgs WA`,'success');
    if (!useSplitLinkMessages()) {
      this.log('📨 Mode campagne : 1 message WhatsApp par contact (texte + lien combinés)', 'info');
    }
    try {
      await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false });
      this.state.sessionHealthy = true;
    } catch (e) {
      this.log(`⚠️ Probe session : ${e.message}`, 'warn');
    }

    try {
      while (this.state.queue.some(c => c.status === 'pending')) {"""

OLD_QUEUE_DELIVER = """          const { rawMsg, personalizedLink, result } = await this._deliverToNumber(number, contact);"""

NEW_QUEUE_DELIVER = """          const { rawMsg, personalizedLink, result } = await this._deliverToNumber(number, contact, { skipProbe: true });"""

if "function prepareOutboundContent" not in t:
    t = t.replace("function splitMessageAndLink(msg) {", INSERT + "function splitMessageAndLink(msg) {", 1)

for old, new, name in [
    (OLD_COUNT, NEW_COUNT, "count"),
    (OLD_DELIVER, NEW_DELIVER, "deliver"),
    (OLD_SENDMSG_LINK, NEW_SENDMSG_LINK, "sendmsg"),
    (OLD_QUEUE_START, NEW_QUEUE_START, "queueStart"),
    (OLD_QUEUE_DELIVER, NEW_QUEUE_DELIVER, "queueDeliver"),
]:
    if old not in t:
        raise SystemExit(f"missing {name}")
    t = t.replace(old, new, 1)

INDEX.write_text(t, encoding="utf-8")
print("ok")
