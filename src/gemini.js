// Client minimale per l'API di Google Gemini (chiave gratuita da Google AI Studio).
import { config } from './config.js';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const headers = () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey });

// Modelli in ordine di preferenza: veloci e con piano gratuito. I modelli più nuovi a volte hanno
// quota gratuita zero, quindi se uno fallisce per quota o perché non esiste si passa al successivo.
const PREFERRED = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash-lite'];
const MAX_ATTEMPTS = 4;
let workingModel = null;
let listed = null; // { at, ids }

async function availableModels() {
  if (listed && Date.now() - listed.at < 3600_000) return listed.ids;
  try {
    const res = await fetch(`${config.geminiApiBase}/v1beta/models?pageSize=1000`, { headers: headers() });
    if (!res.ok) return null;
    const { models = [] } = await res.json();
    const ids = models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
    listed = { at: Date.now(), ids };
    return ids;
  } catch {
    return null; // rete assente: si provano i modelli noti
  }
}

/** Elenco dei modelli da provare, dal migliore al meno preferito. */
export async function candidateModels() {
  const ids = await availableModels();
  const extra = (ids || [])
    .filter((id) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id))
    .sort((x, y) => parseFloat(y.slice(7)) - parseFloat(x.slice(7)));
  const ordered = [config.geminiModel, workingModel, ...PREFERRED.filter((m) => !ids || ids.includes(m)), ...extra];
  return [...new Set(ordered.filter(Boolean))].slice(0, MAX_ATTEMPTS);
}

export const currentModel = () => workingModel;

// Errori per cui ha senso riprovare con un altro modello (quota, modello inesistente o sovraccarico).
const retryable = (err) => [404, 429, 500, 503].includes(err.status)
  || (err.status === 400 && /model|not (found|supported)/i.test(err.message) && !/api key/i.test(err.message));

/** Esegue fn(modello) provando i modelli candidati finché uno funziona. */
async function withModels(fn) {
  let lastErr;
  for (const model of await candidateModels()) {
    try {
      const result = await fn(model);
      if (workingModel !== model) console.log(`🤖 Gemini: uso il modello ${model}`);
      workingModel = model;
      return result;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GeminiError) || !retryable(err)) throw err;
      console.warn(`[Gemini] ${model} non disponibile (${err.status}): ${err.message.slice(0, 160)}`);
      if (workingModel === model) workingModel = null;
    }
  }
  throw lastErr || new GeminiError('Nessun modello Gemini disponibile.', 503);
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
  const res = await withModels(async (model) => {
    const r = await fetch(`${config.geminiApiBase}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: headers(), body: body({ system, messages }), signal,
    });
    await check(r);
    return r;
  });
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
  const res = await withModels(async (model) => {
    const r = await fetch(`${config.geminiApiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: headers(),
      body: body({ messages, generationConfig: { responseMimeType: 'application/json', responseSchema: schema } }),
    });
    await check(r);
    return r;
  });
  const data = await res.json();
  const finish = data.candidates?.[0]?.finishReason;
  if (data.promptFeedback?.blockReason || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
    throw new GeminiError('bloccato dai filtri di sicurezza', 422);
  }
  if (finish === 'MAX_TOKENS') throw new GeminiError('risposta troppo lunga', 413);
  return JSON.parse(textOf(data));
}

/** Prova veloce della chiave (usata dal pulsante "Prova l'AI" dell'area riservata). */
export async function ping() {
  const res = await withModels(async (model) => {
    const r = await fetch(`${config.geminiApiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: headers(), body: body({ messages: [{ role: 'user', content: 'Rispondi solo con: OK' }] }),
    });
    await check(r);
    return r;
  });
  const data = await res.json();
  return { model: workingModel, reply: textOf(data).trim().slice(0, 100) };
}
