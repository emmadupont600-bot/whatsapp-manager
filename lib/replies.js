/**
 * Double opt-in : oui → lien, non → rien, autre → rien (pas de lien).
 */

const POSITIVE_PHRASES = [
  'oui', 'ouais', 'yes', 'yeah', 'yep', 'ok', 'okay', 'daccord', "d'accord", 'dac',
  'volontiers', 'bien sur', 'bien sûr', 'pourquoi pas', 'why not', 'chaud', 'grave',
  'go', 'vas y', 'vas-y', 'allez', 'envoie', 'envoi', 'envoyez', 'send', 'partage',
  'je veux', 'avec plaisir', 'ca marche', 'ça marche', 'parfait', 'super', 'top',
  'interesse', 'intéressé', 'interessée', 'intéressée', 'of course', 'sure', 'absolument',
];

const NEGATIVE_PHRASES = [
  'non merci', 'pas interesse', 'pas intéressé', 'pas envie', 'pas pour moi',
  'je passe', 'laisse tomber', 'laisse moi', 'stop', 'spam', 'desabonne', 'désabonne',
  'ne me contacte', 'merci non', 'nah', 'nope', 'nop', 'no thanks', 'non merci',
];

const THUMBS_REACTIONS = ['👍', '❤️', '💯', '🙏'];

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNegativeReply(text) {
  return classifyOptInReply(text) === 'negative';
}

function isPositiveReply(text) {
  return classifyOptInReply(text) === 'positive';
}

/**
 * @returns {'positive'|'negative'|'neutral'}
 */
function classifyOptInReply(text) {
  if (!text || typeof text !== 'string') return 'neutral';
  const raw = text.trim();
  if (!raw) return 'neutral';
  if (/^(👍|👌|🙏|✅|💯|❤️|🔥|😊|🙂)+$/u.test(raw)) return 'positive';

  const n = normalizeText(raw);

  for (const phrase of NEGATIVE_PHRASES) {
    if (n === phrase || n.startsWith(phrase + ' ') || n.endsWith(' ' + phrase) || n.includes(' ' + phrase + ' ')) {
      return 'negative';
    }
  }
  if (/^non\b/.test(n) && !/pourquoi pas/.test(n)) return 'negative';
  if (/\b(non|nop|nope|nah)\b/.test(n) && !/pourquoi pas/.test(n)) return 'negative';
  if (/pas\s+(interesse|intéressé|envie|besoin)/.test(n)) return 'negative';

  for (const phrase of POSITIVE_PHRASES) {
    if (n === phrase || n.startsWith(phrase + ' ') || n.endsWith(' ' + phrase) || n.includes(' ' + phrase + ' ')) {
      return 'positive';
    }
  }
  if (/^(yes|oui|ok|chaud|go|top|super|grave|volontiers)\W*$/i.test(raw)) return 'positive';
  if (/(envoie|envoi|partage).*(lien|link)/i.test(n)) return 'positive';
  if (/(lien|link)/i.test(n) && /(envoie|envoi|oui|yes|ok)/i.test(n)) return 'positive';
  if (/envoie|envoi|partage/i.test(n) && !/pas\s+(envoie|envoi)/i.test(n)) return 'positive';

  return 'neutral';
}

function isPositiveReaction(reaction) {
  const emoji = reaction?.emoji || reaction?.reaction || '';
  return THUMBS_REACTIONS.includes(emoji);
}

module.exports = {
  isPositiveReply,
  isNegativeReply,
  isPositiveReaction,
  classifyOptInReply,
};
