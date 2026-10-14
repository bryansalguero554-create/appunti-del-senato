import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole, canManage } from '../auth.js';

const router = Router();
router.use(requireAuth);

const id = (v) => Number.parseInt(v, 10);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Valida e normalizza le domande inviate dal client (o generate dall'AI). */
export function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Il quiz deve avere almeno una domanda.');
  if (raw.length > 100) throw new Error('Massimo 100 domande per quiz.');
  return raw.map((q, i) => {
    const question = str(q?.question, 1000);
    const options = (Array.isArray(q?.options) ? q.options : []).map((o) => str(o, 400)).filter(Boolean);
    const correct = Number(q?.correct_index);
    if (!question) throw new Error(`Domanda ${i + 1}: testo mancante.`);
    if (options.length < 2 || options.length > 6) throw new Error(`Domanda ${i + 1}: servono da 2 a 6 risposte.`);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      throw new Error(`Domanda ${i + 1}: indica la risposta corretta.`);
    }
    return { question, options, correct_index: correct, explanation: str(q?.explanation, 1500) };
  });
}

function saveQuestions(quizId, questions) {
  db.prepare('DELETE FROM quiz_questions WHERE quiz_id = ?').run(quizId);
  const insert = db.prepare(`INSERT INTO quiz_questions (quiz_id, position, question, options, correct_index, explanation)
                             VALUES (?, ?, ?, ?, ?, ?)`);
  questions.forEach((q, i) => insert.run(quizId, i, q.question, JSON.stringify(q.options), q.correct_index, q.explanation));
}

/** Salva un nuovo quiz (usato dalla generazione con l'AI). */
export function saveQuiz(quiz, userId) {
  return transaction(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO quizzes (subject_id, topic_id, user_id, title, description, ai_generated)
                                            VALUES (?, ?, ?, ?, ?, 1)`)
      .run(quiz.subject_id, quiz.topic_id, userId, quiz.title, quiz.description);
    saveQuestions(Number(lastInsertRowid), quiz.questions);
    return Number(lastInsertRowid);
  });
}

router.get('/', (req, res) => {
  const quizzes = db.prepare(`
    SELECT q.id, q.title, q.description, q.ai_generated, q.created_at, q.subject_id, q.topic_id,
      s.name AS subject_name, s.icon AS subject_icon, t.name AS topic_name, u.name AS author_name,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
      (SELECT MAX(CAST(a.score AS REAL) / a.total) FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.user_id = ?) AS best
    FROM quizzes q JOIN subjects s ON s.id = q.subject_id
    LEFT JOIN topics t ON t.id = q.topic_id LEFT JOIN users u ON u.id = q.user_id
    ORDER BY q.created_at DESC
  `).all(req.user.id);
  res.json({ quizzes });
});

router.get('/attempts/mine', (req, res) => {
  const attempts = db.prepare(`
    SELECT a.id, a.quiz_id, a.score, a.total, a.created_at, q.title
    FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
    WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ attempts });
});

router.get('/:id', (req, res) => {
  const quiz = db.prepare(`
    SELECT q.*, s.name AS subject_name, t.name AS topic_name, u.name AS author_name
    FROM quizzes q JOIN subjects s ON s.id = q.subject_id
    LEFT JOIN topics t ON t.id = q.topic_id LEFT JOIN users u ON u.id = q.user_id WHERE q.id = ?
  `).get(id(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz non trovato.' });
  const manage = canManage(req.user, quiz.user_id);
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position').all(quiz.id)
    .map((q) => ({
      id: q.id,
      question: q.question,
      options: JSON.parse(q.options),
      // le soluzioni vengono inviate solo a chi può modificare il quiz (per l'editor)
      ...(manage && req.query.edit === '1' ? { correct_index: q.correct_index, explanation: q.explanation } : {}),
    }));
  const leaderboard = db.prepare(`
    SELECT u.name, MAX(a.score) AS score, a.total FROM quiz_attempts a JOIN users u ON u.id = a.user_id
    WHERE a.quiz_id = ? GROUP BY a.user_id ORDER BY score DESC LIMIT 10
  `).all(quiz.id);
  res.json({ quiz: { ...quiz, canManage: manage }, questions, leaderboard });
});

// I quiz si creano con l'AI (/api/ai/quiz); la creazione manuale resta solo per proprietario e moderatori.
router.post('/', requireRole('moderator'), (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 150);
  if (!title) return res.status(400).json({ error: 'Il titolo è obbligatorio.' });
  let subjectId = id(b.subject_id);
  const topicId = b.topic_id ? id(b.topic_id) : null;
  if (topicId) {
    const topic = db.prepare('SELECT subject_id FROM topics WHERE id = ?').get(topicId);
    if (!topic) return res.status(400).json({ error: 'Argomento non valido.' });
    subjectId = topic.subject_id;
  }
  if (!db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(subjectId)) {
    return res.status(400).json({ error: 'Seleziona una materia.' });
  }
  let questions;
  try {
    questions = normalizeQuestions(b.questions);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const quizId = transaction(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO quizzes (subject_id, topic_id, user_id, title, description, ai_generated)
                                            VALUES (?, ?, ?, ?, ?, ?)`)
      .run(subjectId, topicId, req.user.id, title, str(b.description, 1000), b.ai_generated ? 1 : 0);
    saveQuestions(Number(lastInsertRowid), questions);
    return Number(lastInsertRowid);
  });
  res.status(201).json({ id: quizId });
});

router.put('/:id', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz non trovato.' });
  if (!canManage(req.user, quiz.user_id)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  let questions;
  try {
    questions = normalizeQuestions(req.body?.questions);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  transaction(() => {
    db.prepare('UPDATE quizzes SET title = ?, description = ? WHERE id = ?')
      .run(str(req.body?.title, 150) || quiz.title, str(req.body?.description, 1000), quiz.id);
    saveQuestions(quiz.id, questions);
    db.prepare('DELETE FROM quiz_attempts WHERE quiz_id = ?').run(quiz.id);
  });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz non trovato.' });
  if (!canManage(req.user, quiz.user_id)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
  res.json({ ok: true });
});

/** Correzione lato server: il client non riceve mai le soluzioni prima di consegnare. */
router.post('/:id/submit', (req, res) => {
  const quiz = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(id(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz non trovato.' });
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position').all(quiz.id);
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  let score = 0;
  const results = questions.map((q) => {
    const given = Number.isInteger(answers[q.id]) ? answers[q.id] : null;
    const correct = given === q.correct_index;
    if (correct) score += 1;
    return { id: q.id, given, correct_index: q.correct_index, correct, explanation: q.explanation };
  });
  db.prepare('INSERT INTO quiz_attempts (quiz_id, user_id, score, total, answers) VALUES (?, ?, ?, ?, ?)')
    .run(quiz.id, req.user.id, score, questions.length, JSON.stringify(answers));
  res.json({ score, total: questions.length, results });
});

export default router;
