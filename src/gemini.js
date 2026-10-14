// Client minimale per l'API di Google Gemini (chiave gratuita da Google AI Studio).
import { config } from './config.js';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const headers = () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey });

let chosenModel = config.geminiModel || null;

/**
 * Sceglie il modello "Flash" più recente disponibile per la chiave (veloce e con piano gratuito),
 * così il sito continua a funzionare quando Google ritira i modelli più vecchi.
 */
export async function pickModel() {
  if (chosenModel) return chosenModel;
  try {
    const res = await fetch(`${config.geminiApiBase}/v1beta/models?pageSize=1000`, { headers: headers() });
    if (res.ok) {
      const { models = [] } = await res.json();
      const candidates = models
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), v: m.name.match(/^models\/gemini-(\d+(?:\.\d+)?)-flash$/) }))
        .filter((m) => m.v)
        .sort((a, b) => Number(b.v[1]) - Number(a.v[1]));
      if (candidates.length) chosenModel = candidates[0].id;
    }
  } catch {
    // rete assente: si usa il modello predefinito
  }
  chosenModel ??= 'gemini-2.5-flash';
  return chosenModel;
}

/** Converte i blocchi nel formato usato dal sito (testo, PDF, immagini) nelle "parts" di Gemini. */
function toParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((b) => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'document' || b.type === 'image') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    throw new Error(`blocco non supportato: ${b.type}`);
  });
}

function body({ system, messages, generationConfig }) {
  return JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: toParts(m.content) })),
    ...(generationConfig ? { generationConfig } : {}),
  });
}

async function check(res) {
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  throw new GeminiError(data.error?.message || res.statusText, res.status);
}

const textOf = (chunk) => (chunk.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');

/** Risposta in streaming: chiama onText per ogni pezzo di testo. Restituisce il motivo di fine. */
export async function streamChat({ system, messages, onText, signal }) {
  const model = await pickModel();
  const res = await fetch(`${config.geminiApiBase}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: headers(), body: body({ system, messages }), signal,
  });
  await check(res);
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  let blocked = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      let data;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      const text = textOf(data);
      if (text) onText(text);
      finishReason = data.candidates?.[0]?.finishReason || finishReason;
      blocked = data.promptFeedback?.blockReason || blocked;
    }
  }
  return { finishReason: blocked ? 'SAFETY' : finishReason };
}

/** Risposta in JSON che rispetta lo schema indicato. */
export async function generateJson({ messages, schema }) {
  const model = await pickModel();
  const res = await fetch(`${config.geminiApiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: headers(),
    body: body({ messages, generationConfig: { responseMimeType: 'application/json', responseSchema: schema } }),
  });
  await check(res);
  const data = await res.json();
  const finish = data.candidates?.[0]?.finishReason;
  if (data.promptFeedback?.blockReason || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
    throw new GeminiError('bloccato dai filtri di sicurezza', 422);
  }
  if (finish === 'MAX_TOKENS') throw new GeminiError('risposta troppo lunga', 413);
  return JSON.parse(textOf(data));
}
