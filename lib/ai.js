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

async function spinMessage(original, { prenom = '', index = 0, previousSpins = [] } = {}) {
  const avoid = previousSpins.length
    ? `\nNe répète AUCUNE de ces formulations déjà utilisées :\n${previousSpins.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  const nameNote = prenom ? `\nGarde {prénom} si présent (prénom : ${prenom}).` : '';

  const system = `Tu réécris des messages WhatsApp en français (spin text). MÊME sens, formulation différente, au moins un mot changé, ton amical, placeholders {prénom}/{nom} inchangés, pas d'URL. Une seule variante.${nameNote}${avoid}`;

  const user = `Message de référence (variation #${index + 1}) :\n${original}`;
  return chatCompletion(system, user, { temperature: 0.92, maxTokens: 400 });
}

module.exports = {
  isAiEnabled,
  getAiProvider,
  generateConversationalQuestion,
  spinMessage,
};
