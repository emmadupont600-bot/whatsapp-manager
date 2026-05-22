const POSITIVE_KEYWORDS = [
  'oui', 'ouais', 'yes', 'yeah', 'ok', 'daccord', "d'accord", 'volontiers', 'bien sur', 'bien sûr',
  'pourquoi pas', 'chaud', 'go', 'vas y', 'vas-y', 'envoie', 'envoi', 'send', 'partage', 'lien',
  'interesse', 'intéressé', 'je veux', 'super', 'parfait', 'grave', 'allez', 'ca marche', 'ça marche',
];
const NEGATIVE_KEYWORDS = ['non', 'no', 'nop', 'pas interesse', 'pas intéressé', 'stop', 'spam', 'laisse'];
const THUMBS_REACTIONS = ['👍', '❤️', '💯', '🙏'];

function normalizeText(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isNegativeReply(text) {
  const n = normalizeText(text);
  if (!n) return false;
  if (NEGATIVE_KEYWORDS.some(kw => n === kw || n.startsWith(kw + ' ') || n.includes(' ' + kw))) return true;
  if (/^non\b/.test(n) && !/pourquoi pas/.test(n)) return true;
  return false;
}

function isPositiveReply(text) {
  if (!text || typeof text !== 'string') return false;
  const raw = text.trim();
  if (!raw) return false;
  if (/^(👍|👌|🙏|✅|💯|❤️)+$/u.test(raw)) return true;
  const n = normalizeText(raw);
  if (isNegativeReply(raw)) return false;
  if (POSITIVE_KEYWORDS.some(kw => n === kw || n.includes(kw))) return true;
  if (/^(yes|oui|ok|chaud|go)\W*$/i.test(raw)) return true;
  if (/envoie|partage|lien/i.test(n) && !/pas\s+envoie/i.test(n)) return true;
  return false;
}

function isPositiveReaction(reaction) {
  const emoji = reaction?.emoji || reaction?.reaction || '';
  return THUMBS_REACTIONS.includes(emoji);
}

module.exports = { isPositiveReply, isNegativeReply, isPositiveReaction };
