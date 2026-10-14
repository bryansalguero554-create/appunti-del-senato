import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, hasRole } from '../auth.js';
import { noteToBlocks, ContentTooLargeError } from '../extract.js';
import { getNote } from './content.js';
import { normalizeQuestions, saveQuiz } from './quizzes.js';
import { ensureLocalFile } from '../sync.js';
import * as gemini from '../gemini.js';

const router = Router();
router.use(requireAuth);

const useGemini = config.aiProvider === 'gemini';
const client = config.aiProvider === 'anthropic' ? new Anthropic() : null;

// Gemini accetta al massimo ~20 MB per richiesta (file inclusi, codificati in base64).
const GEMINI_MAX_INLINE = 19 * 1024 * 1024;
function checkGeminiSize(blocks) {
  const total = blocks.reduce((n, b) => n + (b.source?.data?.length || b.text?.length || 0), 0);
  if (total > GEMINI_MAX_INLINE) throw new ContentTooLargeError('Gli appunti allegati sono troppo grandi per l\'AI gratuita (massimo circa 14 MB).');
}

// In caso di rifiuto da parte dei filtri di sicurezza, l'API riprova automaticamente
// con il modello di riserva consigliato.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const TUTOR_PROMPT = `Sei il tutor di studio di una piattaforma italiana di appunti condivisi, per studenti delle superiori.
Aiuti a chiarire dubbi sugli argomenti che stanno studiando.
- Rispondi in italiano, in modo chiaro e ordinato. Vai subito al punto: prima la risposta essenziale, poi i dettagli.
- Usa Markdown quando aiuta (titoli brevi, elenchi, **grassetto** per i concetti chiave, tabelle per i confronti).
- Scrivi le formule in LaTeX: $...$ nel testo e $$...$$ per le formule su una riga a parte.
- Se l'utente ha allegato un appunto, basati prima di tutto su quello e indica quando aggiungi informazioni esterne.
- Se negli appunti trovi errori o imprecisioni, segnalali con gentilezza.
- Quando è utile, chiudi con un esempio o una domanda di verifica per controllare la comprensione.`;

const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_index: { type: 'integer' },
          explanation: { type: 'string' },
        },
        required: ['question', 'options', 'correct_index', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'description', 'questions'],
  additionalProperties: false,
};

// Stesso schema nel formato richiesto da Gemini (tipi in maiuscolo, senza additionalProperties).
const GEMINI_QUIZ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          correct_index: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
        },
        required: ['question', 'options', 'correct_index', 'explanation'],
        propertyOrdering: ['question', 'options', 'correct_index', 'explanation'],
      },
    },
  },
  required: ['title', 'description', 'questions'],
  propertyOrdering: ['title', 'description', 'questions'],
};

function ensureAvailable(req, res) {
  if (!config.aiEnabled) {
    res.status(503).json({ error: 'Assistente AI non configurato: il proprietario deve impostare GEMINI_API_KEY.' });
    return false;
  }
  if (!hasRole(req.user, 'owner')) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE user_id = ? AND created_at > datetime('now', '-1 day')`)
      .get(req.user.id);
    if (n >= config.aiDailyLimit) {
      res.status(429).json({ error: `Hai raggiunto il limite giornaliero di ${config.aiDailyLimit} richieste all'AI.` });
      return false;
    }
  }
  return true;
}

const logRequest = (userId, kind) => db.prepare('INSERT INTO ai_requests (user_id, kind) VALUES (?, ?)').run(userId, kind);

function describeContext({ subjectId, topicId }) {
  if (topicId) {
    const topic = db.prepare(`SELECT t.name, t.description, s.name AS subject FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE t.id = ?`).get(topicId);
    if (topic) {
      const titles = db.prepare('SELECT title FROM notes WHERE topic_id = ? ORDER BY created_at DESC LIMIT 40').all(topicId).map((n) => `- ${n.title}`);
      return `Lo studente sta studiando la materia "${topic.subject}", argomento "${topic.name}"${topic.description ? ` (${topic.description})` : ''}.`
        + (titles.length ? `\nAppunti presenti in questo argomento:\n${titles.join('\n')}` : '');
    }
  }
  if (subjectId) {
    const subject = db.prepare('SELECT name FROM subjects WHERE id = ?').get(subjectId);
    if (subject) return `Lo studente sta studiando la materia "${subject.name}".`;
  }
  return '';
}

function apiErrorMessage(err) {
  if (err instanceof ContentTooLargeError) return { status: 413, message: err.message };
  if (err instanceof gemini.GeminiError) {
    if (err.status === 429) return { status: 429, message: 'Raggiunto il limite gratuito dell\'AI: riprova tra un minuto (o domani, se è finito quello giornaliero).' };
    if (err.status === 401 || err.status === 403) return { status: 502, message: 'Chiave Gemini non valida.' };
    if (err.status === 422) return { status: 422, message: 'L\'AI non può rispondere a questa richiesta.' };
    if (err.status === 413) return { status: 422, message: 'Risposta troppo lunga: riduci il numero di domande.' };
    if (err.status === 400) return { status: 400, message: 'Richiesta non accettata dall\'AI (forse il file allegato non è supportato).' };
    return { status: 502, message: 'Errore temporaneo del servizio AI.' };
  }
  if (err instanceof Anthropic.AuthenticationError) return { status: 502, message: 'Chiave API dell\'AI non valida.' };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'L\'AI è sovraccarica, riprova tra poco.' };
  if (err instanceof Anthropic.BadRequestError) return { status: 400, message: 'Richiesta non accettata dall\'AI (forse il file allegato non è supportato).' };
  if (err instanceof Anthropic.APIError) return { status: 502, message: 'Errore temporaneo del servizio AI.' };
  return { status: 500, message: 'Errore imprevisto dell\'assistente AI.' };
}

/** Chat con il tutor: risposta in streaming (testo semplice, chunked). */
router.post('/chat', async (req, res) => {
  if (!ensureAvailable(req, res)) return;
  const raw = Array.isArray(req.body?.messages) ? req.body.messages.slice(-30) : [];
  const messages = raw
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 10_000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages.at(-1).role !== 'user') {
    return res.status(400).json({ error: 'Scrivi una domanda.' });
  }

  const ctx = req.body?.context || {};
  let system = TUTOR_PROMPT;
  const contextText = describeContext({ subjectId: Number(ctx.subjectId) || null, topicId: Number(ctx.topicId) || null });
  if (contextText) system += `\n\n${contextText}`;

  try {
    // L'appunto allegato viene messo nel primo messaggio dell'utente, così il prefisso resta
    // stabile tra un turno e l'altro e può essere riutilizzato dalla cache.
    const noteId = Number(ctx.noteId) || null;
    if (noteId) {
      const note = getNote(noteId);
      if (note) {
        await ensureLocalFile(note);
        messages[0] = { role: 'user', content: [...noteToBlocks(note), { type: 'text', text: messages[0].content }] };
      }
    }

    if (useGemini) {
      if (noteId) checkGeminiSize(messages[0].content);
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      };
      logRequest(req.user.id, 'chat');
      const { finishReason } = await gemini.streamChat({
        system, messages, signal: controller.signal, onText: (t) => { start(); res.write(t); },
      });
      start();
      if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') res.write('\n\n_L\'assistente non può rispondere a questa richiesta._');
      else if (finishReason === 'MAX_TOKENS') res.write('\n\n_(risposta interrotta perché troppo lunga)_');
      return res.end();
    }

    const stream = client.beta.messages.stream({
      model: config.aiModel,
      max_tokens: 16000,
      system,
      messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      ...FALLBACK,
    });
    logRequest(req.user.id, 'chat');
    // se lo studente chiude la chat o la pagina, interrompe la generazione
    res.on('close', () => { if (!res.writableFinished) stream.abort(); });

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') res.write(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') res.write('\n\n_L\'assistente non può rispondere a questa richiesta._');
    else if (final.stop_reason === 'max_tokens') res.write('\n\n_(risposta interrotta perché troppo lunga)_');
    res.end();
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') {
      if (!res.writableEnded) res.end();
      return;
    }
    const { status, message } = apiErrorMessage(err);
    if (!(err instanceof ContentTooLargeError)) console.error('[AI chat]', err?.message || err);
    if (!res.headersSent) res.status(status).json({ error: message });
    else res.end(`\n\n_Errore: ${message}_`);
  }
});

/** Appunti leggibili dall'AI di un argomento (o di tutta la materia), entro un budget di dimensione. */
async function collectMaterial({ topicId, subjectId }) {
  const notes = topicId
    ? db.prepare(`SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.user_id
                  WHERE n.topic_id = ? ORDER BY n.created_at DESC`).all(topicId)
    : db.prepare(`SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.user_id
                  JOIN topics t ON t.id = n.topic_id WHERE t.subject_id = ? ORDER BY n.created_at DESC`).all(subjectId);
  const blocks = [];
  let budget = (useGemini ? 13 : 24) * 1024 * 1024;
  let docs = 0;
  for (const note of notes) {
    if (note.size > budget || docs >= 8) continue;
    try {
      await ensureLocalFile(note);
      const nb = noteToBlocks(note);
      if (nb.length === 1 && /non leggibile|non disponibile/.test(nb[0].text)) continue;
      blocks.push(...nb);
      budget -= note.size;
      docs += 1;
    } catch {
      // appunto troppo grande: saltato
    }
  }
  return blocks;
}

/**
 * Genera un quiz con l'AI e lo salva subito: i quiz del sito sono creati solo dall'AI.
 * Fonte: un appunto (noteId), un argomento (topicId) o un'intera materia (subjectId).
 */
router.post('/quiz', async (req, res) => {
  if (!ensureAvailable(req, res)) return;
  const count = Math.min(Math.max(Number(req.body?.count) || 10, 3), 25);
  const difficulty = ['facile', 'media', 'difficile'].includes(req.body?.difficulty) ? req.body.difficulty : 'media';
  const instructions = String(req.body?.instructions || '').slice(0, 1000);
  const noteId = Number(req.body?.noteId) || null;
  let topicId = Number(req.body?.topicId) || null;
  let subjectId = Number(req.body?.subjectId) || null;

  try {
    let material = [];
    let noteTitle = null;
    if (noteId) {
      const note = getNote(noteId);
      if (!note) return res.status(404).json({ error: 'Appunto non trovato.' });
      topicId = note.topic_id;
      noteTitle = note.title;
      await ensureLocalFile(note);
      material = noteToBlocks(note);
    }
    const topic = topicId ? db.prepare('SELECT id, name, subject_id FROM topics WHERE id = ?').get(topicId) : null;
    if (topicId && !topic) return res.status(400).json({ error: 'Argomento non valido.' });
    if (topic) subjectId = topic.subject_id;
    const subject = subjectId ? db.prepare('SELECT id, name FROM subjects WHERE id = ?').get(subjectId) : null;
    if (!subject) return res.status(400).json({ error: 'Scegli la materia del quiz.' });
    if (!noteId) material = await collectMaterial({ topicId: topic?.id, subjectId: subject.id });

    const scope = noteTitle
      ? `sull'appunto "${noteTitle}" (materia "${subject.name}", argomento "${topic.name}")`
      : topic ? `per la materia "${subject.name}", argomento "${topic.name}"` : `per la materia "${subject.name}" (tutti gli argomenti)`;
    const request = `Crea un quiz di verifica a scelta multipla in italiano ${scope}.
- Numero di domande: esattamente ${count}
- Difficoltà: ${difficulty}
- Ogni domanda deve avere 4 risposte, una sola corretta (correct_index parte da 0), e una breve spiegazione della risposta giusta.
- Varia la posizione della risposta corretta e rendi plausibili le risposte sbagliate. Non ripetere domande.
- Dai al quiz un titolo breve e specifico (es. "Rivoluzione francese: cause e fasi") e una descrizione di una riga.
${material.length ? '- Basa le domande sugli appunti allegati.' : '- Non ci sono appunti leggibili: usa le tue conoscenze sull\'argomento, a livello di scuola superiore.'}
${instructions ? `Indicazioni aggiuntive dello studente: ${instructions}` : ''}`;

    const content = [...material, { type: 'text', text: request }];
    let data;
    if (useGemini) {
      checkGeminiSize(content);
      logRequest(req.user.id, 'quiz');
      data = await gemini.generateJson({ messages: [{ role: 'user', content }], schema: GEMINI_QUIZ_SCHEMA });
    } else {
      const response = await client.beta.messages.create({
        model: config.aiModel,
        max_tokens: 16000,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: QUIZ_SCHEMA } },
        ...FALLBACK,
      });
      logRequest(req.user.id, 'quiz');
      if (response.stop_reason === 'refusal') return res.status(422).json({ error: 'L\'AI non ha potuto generare questo quiz.' });
      if (response.stop_reason === 'max_tokens') return res.status(422).json({ error: 'Quiz troppo lungo: riduci il numero di domande.' });
      data = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    }

    const quiz = {
      title: String(data.title || `Quiz di ${topic?.name || subject.name}`).slice(0, 150),
      description: String(data.description || '').slice(0, 1000),
      subject_id: subject.id,
      topic_id: topic?.id ?? null,
      questions: normalizeQuestions(data.questions),
    };
    const id = saveQuiz(quiz, req.user.id);
    res.status(201).json({ id, quiz: { ...quiz, id } });
  } catch (err) {
    const { status, message } = err instanceof SyntaxError || /Domanda \d+|almeno una domanda/.test(err?.message || '')
      ? { status: 502, message: 'L\'AI ha restituito un quiz non valido, riprova.' }
      : apiErrorMessage(err);
    if (!(err instanceof ContentTooLargeError)) console.error('[AI quiz]', err?.message || err);
    res.status(status).json({ error: message });
  }
});

export default router;
