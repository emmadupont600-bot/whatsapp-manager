/**
 * IA campagne via API compatible OpenAI (Groq en priorité).
 * Groq : GROQ_API_KEY + GROQ_MODEL (défaut llama-3.3-70b-versatile)
 * OpenAI : OPENAI_API_KEY (repli)
 */

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);

function getAiProvider() {
  if (GROQ_API_KEY) {
    return { apiKey: GROQ_API_KEY, baseUrl: GROQ_BASE_URL, model: GROQ_MODEL, name: 'Groq' };
  }
  if (OPENAI_API_KEY) {
    return { apiKey: OPENAI_API_KEY, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, name: 'OpenAI' };
  }
  return null;
}

function isAiEnabled() {
  return !!getAiProvider();
}

async function chatCompletion(systemPrompt, userPrompt, { temperature = 0.85, maxTokens = 500 } = {}) {
  const provider = getAiProvider();
  if (!provider) throw new Error('GROQ_API_KEY ou OPENAI_API_KEY requise — IA désactivée');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.message || res.statusText || `HTTP ${res.status}`;
      throw new Error(`${provider.name} API : ${errMsg}`);
    }

    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Réponse IA vide');
    return text.replace(/^["']|["']$/g, '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function lengthBounds(charCount) {
  const n = Math.max(40, charCount || 0);
  return { min: Math.round(n * 0.85), max: Math.round(n * 1.2), target: n };
}

function tokensForLength(charCount) {
  return Math.min(2500, Math.max(350, Math.ceil(Math.max(40, charCount) * 0.55)));
}

/** Court texte sans lien : question opt-in seule (legacy). */
async function generateConversationalQuestion(pitch, linkHint = '') {
  const system = `Tu es un copywriter WhatsApp français. Tu transformes un texte promotionnel en UNE seule question courte, naturelle et amicale pour demander l'autorisation d'envoyer le lien (double opt-in). 
Règles strictes :
- Français correct, ton chaleureux (tutoiement OK si le texte d'origine tutoie)
- Une seule question, max 2 phrases courtes
- Ne pas inclure le lien dans la question
- Garder le même sujet (groupe, événements, etc.)
Réponds UNIQUEMENT avec la question, sans guillemets ni explication.`;

  const user = linkHint
    ? `Texte de campagne :\n${pitch}\n\n(Lien à envoyer plus tard après accord : ${linkHint})`
    : `Texte de campagne :\n${pitch}`;

  return chatCompletion(system, user, { temperature: 0.7, maxTokens: 280 });
}

/**
 * Préparation campagne : garde le contenu et la longueur, reformule légèrement.
 * Le lien n'est pas inclus ; une question d'opt-in peut terminer le message.
 */
function prenomRulesForAi(prenomMode) {
  const mode = String(prenomMode || 'off').toLowerCase();
  if (mode === 'placeholder' || mode === 'tag') {
    return `- Garde les placeholders {prénom}, {nom}, {phone}, {name} tels quels — ne les remplace PAS par de vrais prénoms
- N'ajoute pas de prénom entre parenthèses si absent du texte source`;
  }
  if (mode === 'paren' || mode === 'parentheses') {
    return `- N'inclus PAS de prénom dans le texte (le système ajoutera « (prénom) » automatiquement après)
- Ne mets pas {prénom} ni de vrais prénoms`;
  }
  return `- N'utilise AUCUN prénom ni nom de personne dans le message (pas de « Bonjour Marie », pas de « (Jean) »)
- Supprime ou ignore les placeholders {prénom}, {nom}, {name} — ne les remplace pas`;
}

async function prepareCampaignMessage(pitch, linkHint = '', { prenomMode = 'off' } = {}) {
  const { min, max, target } = lengthBounds(pitch.length);
  const linkNote = linkHint
    ? `\nUn lien sera envoyé SEULEMENT si la personne répond oui. Tu peux terminer par une courte question d'accord (ex. « tu veux que je t'envoie le lien ? ») SANS mettre l'URL dans le message.`
    : '';

  const system = `Tu es copywriter WhatsApp (français). Tu adaptes le message de campagne fourni par l'utilisateur.

Règles OBLIGATOIRES :
- CONSERVER toutes les informations utiles : offre, avantages, dates, lieu, prix, consignes, ton, détails concrets
- NE PAS résumer en une ou deux phrases courtes : le message final doit rester substantiel
- Longueur cible : entre ${min} et ${max} caractères (original ≈ ${target} caractères)
- Reformuler pour fluidité et naturel, mais ne supprimer aucun fait important
${prenomRulesForAi(prenomMode)}
- Pas d'URL dans le texte${linkNote}
- Réponds UNIQUEMENT avec le message final, sans guillemets ni commentaire`;

  const user = `Message source à adapter :\n\n${pitch}`;
  return chatCompletion(system, user, { temperature: 0.75, maxTokens: tokensForLength(pitch.length) });
}

async function spinMessage(original, { prenomMode = 'off', index = 0, previousSpins = [] } = {}) {
  const { min, max, target } = lengthBounds(original.length);
  const avoid = previousSpins.length
    ? `\n\nFormulations DÉJÀ utilisées — invente autre chose (structure et mots différents) :\n${previousSpins.slice(-8).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  const system = `Tu réécris des messages WhatsApp en français (spin / variante anti-doublon).

Règles OBLIGATOIRES :
- MÊME sens et MÊMES informations : rien d'important ne doit disparaître (dates, chiffres, lieux, bénéfices, CTA)
- Longueur proche de l'original : entre ${min} et ${max} caractères (référence ≈ ${target})
- Formulation clairement DIFFÉRENTE (synonymes, ordre des idées, tournures) — pas une simple copie
- Ton naturel, français correct
${prenomRulesForAi(prenomMode)}
- Pas d'URL ajoutée
- Une seule variante, sans guillemets ni explication${avoid}`;

  const user = `Message de référence — variante #${index + 1} :\n\n${original}`;
  return chatCompletion(system, user, { temperature: 0.93, maxTokens: tokensForLength(original.length) });
}

module.exports = {
  isAiEnabled,
  getAiProvider,
  generateConversationalQuestion,
  prepareCampaignMessage,
  spinMessage,
};
