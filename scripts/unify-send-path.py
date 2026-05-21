#!/usr/bin/env python3
from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "index.js"
t = INDEX.read_text(encoding="utf-8")

DELIVER = r'''
  /**
   * Chemin d'envoi unique : test dashboard et queue campagne utilisent exactement la même logique.
   */
  async _deliverToNumber(number, contact, { message, link } = {}) {
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
  }

'''

OLD_SENDTEST = """  async sendTest(phone, message, link) {
    if (!this.state.ready) throw new Error('WhatsApp non connecté');
    const number=phone.replace(/\\D/g,'');
    const chatId=await resolveOutboundChatId(this.client, number, this.log.bind(this));
    try { await probeWhatsAppConnection(this.client, this.log.bind(this), { strict: false }); } catch (e) { this.log(`⚠️ ${e.message}`, 'warn'); }
    if (!await safeIsRegisteredUser(this.client, chatId, this.log.bind(this))) throw new Error(`+${number} n'est pas sur WhatsApp`);
    const fakeContact={phone:number,prenom:'Test',nom:'Test'};
    const pMsg = personalizeMessage(message||'Message de test 👋',fakeContact);
    const pLink = personalizeMessage(link||'',fakeContact);
    const need = countOutboundMessages(pMsg, pLink);
    if (need > this._messagesAvailable()) throw new Error(`Quota insuffisant : ${need} message(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`);
    if (!(await this._waitForHourlyCapacity(need))) throw new Error('Envoi annulé');
    const result = await this._sendMessage(chatId, pMsg, pLink);
    this.state.dailySent += result.messageCount;
    this._recordMessagesSent(result.messageCount);
    this._recordFirstSend();
    this._saveQueue();
    this.log(`🧪 Test envoyé à +${number} (${result.messageCount} msg WhatsApp) [${this.state.dailySent}/${this.dailyLimit}]`,'success');
    this.state.sessionHealthy = true;
  }"""

NEW_SENDTEST = """  async sendTest(phone, message, link) {
    if (!this.state.ready) throw new Error('WhatsApp non connecté');
    const number = phone.replace(/\\D/g, '');
    const contact = { phone: number, prenom: 'Test', nom: 'Test' };
    const { result } = await this._deliverToNumber(number, contact, { message, link });
    this.state.dailySent += result.messageCount;
    this._recordMessagesSent(result.messageCount);
    this._saveQueue();
    this.log(`🧪 Test envoyé à +${number} (${result.messageCount} msg WhatsApp) [${this.state.dailySent}/${this.dailyLimit}]`, 'success');
  }"""

OLD_QUEUE_TRY = """        try {
          const number=contact.phone.replace(/\\D/g,'');
          const chatId=await resolveOutboundChatId(this.client, number, this.log.bind(this));
          if (isBlacklisted(number)) {
            contact.status='blacklisted'; this.state.stats.blacklisted++;
            this.log(`🚫 Blacklisté : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(1000,3000)); continue;
          }
          const isRegistered = await safeIsRegisteredUser(this.client, chatId, this.log.bind(this));
          if (!isRegistered) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Non inscrit sur WhatsApp : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(3000,8000)); continue;
          }
          await sleep(rand(800, 2500));
          const rawMsg=personalizeMessage((contact.message||'').trim()||process.env.DEFAULT_MESSAGE||'Bonjour ! 👋',contact);
          const personalizedLink=personalizeMessage((contact.link||'').trim(),contact);
          const msgCount = countOutboundMessages(rawMsg, personalizedLink);
          if (msgCount === 0) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Message vide : +${number}`,'warn');
            this._saveQueue(); continue;
          }
          if (msgCount > this._messagesAvailable()) {
            this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
            contact.status='pending';
            const remaining=this.state.queue.filter(c=>c.status==='pending');
            const relay = relayBot || this._partner;
            this.log(`⏸ Quota : ${msgCount} msg(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`,'warn');
            if (relay && relay.state.ready && remaining.length>0) {
              this.log(`🔁 Relais vers Compte ${relay.id} (${remaining.length} contacts)`,'warn');
              for (const c of remaining) {
                const cleanPhone=c.phone.replace(/\\D/g,'');
                const alreadyInRelay=relay.state.queue.some(x=>x.phone.replace(/\\D/g,'')=== cleanPhone&&['pending','processing','done'].includes(x.status));
                if (!alreadyInRelay) relay.state.queue.push({...c,status:'pending',relayedFrom:this.id,relayedAt:new Date().toISOString()});
                else this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`,'warn');
                c.status='relayed';
              }
              this._saveQueue(true); relay._saveQueue(true);
              if (!relay.state.running) relay.runQueue(this);
            } else if (config.autoResume) this._scheduleAutoResume(relay);
            this._saveQueue(true); break;
          }
          if (!(await this._waitForHourlyCapacity(msgCount))) {
            contact.status = 'pending'; this._saveQueue(true);
            this.log('⏸ Arrêt : limite horaire anti-ban', 'warn'); break;
          }
          this._recordFirstSend();
          const result = await this._sendMessage(chatId, rawMsg, personalizedLink);
          this._consecutiveRejects = 0;
          contact.status='done'; contact.sentAt=new Date().toISOString();
          contact.waMessageId=result.lastId; contact.whatsappMessagesSent=result.messageCount;
          this.state.stats.sent++; this.state.sessionCount++;
          this.state.dailySent += result.messageCount;
          this._recordMessagesSent(result.messageCount);
          const linkNote = result.messageCount >= 2 ? ' (texte + lien = 2 msgs)' : '';
          this.log(`✅ Envoyé à +${number}${contact.prenom?' ('+contact.prenom+')':''}${linkNote} [${this.state.dailySent}/${this.dailyLimit} msgs]`,'success');
          addToSentHistory(number, { sentAt: contact.sentAt, botId: this.id, message: rawMsg, link: personalizedLink, prenom: contact.prenom, nom: contact.nom });
          this._saveQueue();
          await this._delayMsg();
          if (!this.state.running) break;"""

NEW_QUEUE_TRY = """        try {
          const number=contact.phone.replace(/\\D/g,'');
          if (isBlacklisted(number)) {
            contact.status='blacklisted'; this.state.stats.blacklisted++;
            this.log(`🚫 Blacklisté : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(1000,3000)); continue;
          }
          await sleep(rand(800, 2500));
          const { rawMsg, personalizedLink, result } = await this._deliverToNumber(number, contact);
          this._consecutiveRejects = 0;
          contact.status='done'; contact.sentAt=new Date().toISOString();
          contact.waMessageId=result.lastId; contact.whatsappMessagesSent=result.messageCount;
          this.state.stats.sent++; this.state.sessionCount++;
          this.state.dailySent += result.messageCount;
          this._recordMessagesSent(result.messageCount);
          const linkNote = result.messageCount >= 2 ? ' (texte + lien = 2 msgs)' : '';
          this.log(`✅ Envoyé à +${number}${contact.prenom?' ('+contact.prenom+')':''}${linkNote} [${this.state.dailySent}/${this.dailyLimit} msgs]`,'success');
          addToSentHistory(number, { sentAt: contact.sentAt, botId: this.id, message: rawMsg, link: personalizedLink, prenom: contact.prenom, nom: contact.nom });
          this._saveQueue();
          await this._delayMsg();
          if (!this.state.running) break;"""

# Insert _deliverToNumber before sendTest
marker = "  async sendTest(phone, message, link) {"
if "_deliverToNumber" not in t:
    if marker not in t:
        raise SystemExit("sendTest marker not found")
    t = t.replace(marker, DELIVER + marker, 1)

if OLD_SENDTEST not in t:
    raise SystemExit("sendTest block not found")
if OLD_QUEUE_TRY not in t:
    raise SystemExit("queue try block not found")

t = t.replace(OLD_SENDTEST, NEW_SENDTEST, 1).replace(OLD_QUEUE_TRY, NEW_QUEUE_TRY, 1)

# Add catch handlers for deliver errors in queue catch block
OLD_CATCH_START = """        } catch(err) {
          if (isGhostSessionError(err)) {"""

NEW_CATCH_START = """        } catch(err) {
          const number=contact.phone.replace(/\\D/g,'');
          if (/n'est pas sur WhatsApp/i.test(err.message)) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Non inscrit sur WhatsApp : +${number}`,'warn');
            this._saveQueue(); await sleep(rand(3000,8000)); continue;
          }
          if (/Message vide/i.test(err.message)) {
            contact.status='skipped'; this.state.stats.skipped++;
            this.log(`⏭️ Message vide : +${number}`,'warn');
            this._saveQueue(); continue;
          }
          if (/Quota insuffisant/i.test(err.message)) {
            const msgCount = countOutboundMessages(
              personalizeMessage((contact.message||'').trim()||process.env.DEFAULT_MESSAGE||'Bonjour ! 👋', contact),
              personalizeMessage((contact.link||'').trim(), contact)
            );
            this.state.running=false; this.state.limitReached=true; this.state.limitReachedAt=new Date().toISOString();
            contact.status='pending';
            const remaining=this.state.queue.filter(c=>c.status==='pending');
            const relay = relayBot || this._partner;
            this.log(`⏸ Quota : ${msgCount} msg(s) requis, ${this._messagesAvailable()} restant(s) sur ${this.dailyLimit}`,'warn');
            if (relay && relay.state.ready && remaining.length>0) {
              this.log(`🔁 Relais vers Compte ${relay.id} (${remaining.length} contacts)`,'warn');
              for (const c of remaining) {
                const cleanPhone=c.phone.replace(/\\D/g,'');
                const alreadyInRelay=relay.state.queue.some(x=>x.phone.replace(/\\D/g,'')=== cleanPhone&&['pending','processing','done'].includes(x.status));
                if (!alreadyInRelay) relay.state.queue.push({...c,status:'pending',relayedFrom:this.id,relayedAt:new Date().toISOString()});
                else this.log(`⚠️ Doublon ignoré lors du relais : +${cleanPhone}`,'warn');
                c.status='relayed';
              }
              this._saveQueue(true); relay._saveQueue(true);
              if (!relay.state.running) relay.runQueue(this);
            } else if (config.autoResume) this._scheduleAutoResume(relay);
            this._saveQueue(true); break;
          }
          if (/limite horaire/i.test(err.message)) {
            contact.status = 'pending'; this._saveQueue(true);
            this.log('⏸ Arrêt : limite horaire anti-ban', 'warn'); break;
          }
          if (isGhostSessionError(err)) {"""

if OLD_CATCH_START in t and "n'est pas sur WhatsApp/i.test(err.message)" not in t:
    t = t.replace(OLD_CATCH_START, NEW_CATCH_START, 1)

INDEX.write_text(t, encoding="utf-8")
print("ok")
