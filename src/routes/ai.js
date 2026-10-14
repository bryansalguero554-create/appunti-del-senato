import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, hasRole } from '../auth.js';
import { noteToBlocks, ContentTooLargeError } from '../extract.js';
import { getNote } from './content.js';
import { normalizeQuestions } from './quizzes.js';

const router = Router();
router.use(requireAuth);

const client = config.aiEnabled ? new Anthropic() : null;

// In caso di rifiuto da parte dei filtri di sicurezza, l'API riprova automaticamente
// con il modello di riserva consigliato.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const TUTOR_PROMPT = `Sei il tutor di studio di una piattaforma italiana di appunti condivisi.
Aiuti studenti a chiarire dubbi sugli argomenti che stanno studiando.
- Rispondi in italiano, in modo chiaro e ordinato; usa Markdown (titoli brevi, elenchi, grassetto) quando aiuta.
- Se l'utente ha allegato degli appunti, basati prima di tutto su quelli e indica quando aggiungi informazioni esterne.
- Se negli appunti trovi errori o imprecisioni, segnalali con gentilezza.
- Quando è utile, chiudi con un breve esempio o una domanda di verifica per controllare la comprensione.`;

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

function ensureAvailable(req, res) {
  if (!client) {
    res.status(503).json({ error: 'Assistente AI non configurato: il proprietario deve impostare ANTHROPIC_API_KEY.' });
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
        messages[0] = { role: 'user', content: [...noteToBlocks(note), { type: 'text', text: messages[0].content }] };
      }
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
    if (err instanceof Anthropic.APIUserAbortError) {
      if (!res.writableEnded) res.end();
      return;
    }
    const { status, message } = apiErrorMessage(err);
    if (!(err instanceof ContentTooLargeError)) console.error('[AI chat]', err?.message || err);
    if (!res.headersSent) res.status(status).json({ error: message });
    else res.end(`\n\n_Errore: ${message}_`);
  }
});

/** Collezione degli appunti di un argomento leggibili dall'AI, entro un budget di dimensione. */
function topicMaterial(topicId) {
  const notes = db.prepare(`SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.user_id
                            WHERE n.topic_id = ? ORDER BY n.created_at DESC`).all(topicId);
  const blocks = [];
  let budget = 24 * 1024 * 1024;
  let docs = 0;
  for (const note of notes) {
    if (note.size > budget || docs >= 8) continue;
    try {
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

/** Genera un quiz (da rivedere nell'editor prima del salvataggio). */
router.post('/quiz', async (req, res) => {
  if (!ensureAvailable(req, res)) return;
  const count = Math.min(Math.max(Number(req.body?.count) || 8, 3), 25);
  const difficulty = ['facile', 'media', 'difficile'].includes(req.body?.difficulty) ? req.body.difficulty : 'media';
  const instructions = String(req.body?.instructions || '').slice(0, 1000);
  const noteId = Number(req.body?.noteId) || null;
  let topicId = Number(req.body?.topicId) || null;

  try {
    let material = [];
    if (noteId) {
      const note = getNote(noteId);
      if (!note) return res.status(404).json({ error: 'Appunto non trovato.' });
      topicId = note.topic_id;
      material = noteToBlocks(note);
    }
    const topic = topicId
      ? db.prepare('SELECT t.id, t.name, t.subject_id, s.name AS subject FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE t.id = ?').get(topicId)
      : null;
    if (!topic) return res.status(400).json({ error: 'Seleziona un argomento o un appunto.' });
    if (!noteId) material = topicMaterial(topic.id);

    const request = `Crea un quiz di verifica a scelta multipla in italiano per la materia "${topic.subject}", argomento "${topic.name}".
- Numero di domande: ${count}
- Difficoltà: ${difficulty}
- Ogni domanda deve avere 4 risposte, una sola corretta (correct_index parte da 0), e una breve spiegazione della risposta giusta.
- Varia la posizione della risposta corretta e rendi plausibili le risposte sbagliate.
${material.length ? '- Basa le domande sugli appunti allegati.' : '- Non ci sono appunti leggibili: usa le tue conoscenze sull\'argomento.'}
${instructions ? `Indicazioni aggiuntive dello studente: ${instructions}` : ''}`;

    const response = await client.beta.messages.create({
      model: config.aiModel,
      max_tokens: 16000,
      messages: [{ role: 'user', content: [...material, { type: 'text', text: request }] }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: QUIZ_SCHEMA } },
      ...FALLBACK,
    });
    logRequest(req.user.id, 'quiz');
    if (response.stop_reason === 'refusal') return res.status(422).json({ error: 'L\'AI non ha potuto generare questo quiz.' });
    if (response.stop_reason === 'max_tokens') return res.status(422).json({ error: 'Quiz troppo lungo: riduci il numero di domande.' });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const data = JSON.parse(text);
    res.json({
      quiz: {
        title: String(data.title || `Quiz: ${topic.name}`).slice(0, 150),
        description: String(data.description || '').slice(0, 1000),
        topic_id: topic.id,
        subject_id: topic.subject_id,
        questions: normalizeQuestions(data.questions),
      },
    });
  } catch (err) {
    const { status, message } = err instanceof SyntaxError || /Domanda \d+/.test(err?.message || '')
      ? { status: 502, message: 'L\'AI ha restituito un quiz non valido, riprova.' }
      : apiErrorMessage(err);
    if (!(err instanceof ContentTooLargeError)) console.error('[AI quiz]', err?.message || err);
    res.status(status).json({ error: message });
  }
});

export default router;
