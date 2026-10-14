import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db, transaction } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireRole, canManage } from '../auth.js';
import { extOf, mimeFor, servingPolicy, contentDisposition } from '../files.js';
import { pushSubject, pushTopic, pushNotes, pushRename, pushTrash } from '../sync.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 },
  defParamCharset: 'utf8',
});

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const id = (v) => Number.parseInt(v, 10);

function removeStoredFiles(storedNames) {
  for (const name of storedNames) {
    fs.rm(path.join(config.uploadDir, path.basename(name)), { force: true }, () => {});
  }
}

const notFound = (res, what = 'Elemento') => res.status(404).json({ error: `${what} non trovato.` });

// ---------- Materie ----------

router.get('/subjects', (req, res) => {
  const subjects = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM topics t WHERE t.subject_id = s.id) AS topic_count,
      (SELECT COUNT(*) FROM notes n JOIN topics t ON t.id = n.topic_id WHERE t.subject_id = s.id) AS note_count,
      (SELECT COUNT(*) FROM quizzes q WHERE q.subject_id = s.id) AS quiz_count,
      (SELECT MAX(n.created_at) FROM notes n JOIN topics t ON t.id = n.topic_id WHERE t.subject_id = s.id) AS last_note_at
    FROM subjects s ORDER BY s.name COLLATE NOCASE
  `).all();
  res.json({ subjects });
});

router.post('/subjects', requireRole('moderator'), (req, res) => {
  const name = str(req.body?.name, 80);
  if (!name) return res.status(400).json({ error: 'Il nome della materia è obbligatorio.' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO subjects (name, description, icon, color, created_by) VALUES (?, ?, ?, ?, ?)',
  ).run(name, str(req.body?.description), str(req.body?.icon, 8) || '📚',
    /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : '#4f46e5', req.user.id);
  pushSubject(Number(lastInsertRowid));
  res.status(201).json({ subject: db.prepare('SELECT * FROM subjects WHERE id = ?').get(lastInsertRowid) });
});

router.get('/subjects/:id', (req, res) => {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id(req.params.id));
  if (!subject) return notFound(res, 'Materia');
  const topics = db.prepare(`
    SELECT t.*, u.name AS author_name,
      (SELECT COUNT(*) FROM notes n WHERE n.topic_id = t.id) AS note_count,
      (SELECT COUNT(DISTINCT n.user_id) FROM notes n WHERE n.topic_id = t.id) AS contributor_count,
      (SELECT COUNT(*) FROM quizzes q WHERE q.topic_id = t.id) AS quiz_count,
      (SELECT GROUP_CONCAT(DISTINCT n.ext) FROM notes n WHERE n.topic_id = t.id) AS formats,
      (SELECT MAX(n.created_at) FROM notes n WHERE n.topic_id = t.id) AS last_note_at
    FROM topics t LEFT JOIN users u ON u.id = t.created_by
    WHERE t.subject_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(subject.id);
  for (const t of topics) {
    t.preview = db.prepare(`SELECT id, title, ext, mime FROM notes WHERE topic_id = ? ORDER BY created_at DESC LIMIT 3`).all(t.id);
  }
  const quizzes = db.prepare(`
    SELECT q.id, q.title, q.topic_id, q.ai_generated, q.created_at, u.name AS author_name,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
    FROM quizzes q LEFT JOIN users u ON u.id = q.user_id
    WHERE q.subject_id = ? ORDER BY q.created_at DESC
  `).all(subject.id);
  res.json({ subject, topics, quizzes });
});

router.patch('/subjects/:id', requireRole('moderator'), (req, res) => {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id(req.params.id));
  if (!subject) return notFound(res, 'Materia');
  const b = req.body || {};
  db.prepare('UPDATE subjects SET name = ?, description = ?, icon = ?, color = ? WHERE id = ?').run(
    str(b.name, 80) || subject.name,
    b.description !== undefined ? str(b.description) : subject.description,
    str(b.icon, 8) || subject.icon,
    /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : subject.color,
    subject.id,
  );
  const renamed = str(b.name, 80);
  if (renamed && renamed !== subject.name) pushRename(subject.drive_id, renamed);
  res.json({ subject: db.prepare('SELECT * FROM subjects WHERE id = ?').get(subject.id) });
});

router.delete('/subjects/:id', requireRole('moderator'), (req, res) => {
  const subjectId = id(req.params.id);
  const driveId = db.prepare('SELECT drive_id FROM subjects WHERE id = ?').get(subjectId)?.drive_id;
  const files = db.prepare(`SELECT n.stored_name FROM notes n JOIN topics t ON t.id = n.topic_id WHERE t.subject_id = ?`)
    .all(subjectId).map((r) => r.stored_name);
  const { changes } = db.prepare('DELETE FROM subjects WHERE id = ?').run(subjectId);
  if (!changes) return notFound(res, 'Materia');
  removeStoredFiles(files);
  pushTrash(driveId);
  res.json({ ok: true });
});

// ---------- Argomenti (cartelle) ----------

router.post('/subjects/:id/topics', (req, res) => {
  const subject = db.prepare('SELECT id FROM subjects WHERE id = ?').get(id(req.params.id));
  if (!subject) return notFound(res, 'Materia');
  const name = str(req.body?.name, 100);
  if (!name) return res.status(400).json({ error: 'Il nome dell\'argomento è obbligatorio.' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO topics (subject_id, name, description, created_by) VALUES (?, ?, ?, ?)',
  ).run(subject.id, name, str(req.body?.description), req.user.id);
  pushTopic(Number(lastInsertRowid));
  res.status(201).json({ topic: db.prepare('SELECT * FROM topics WHERE id = ?').get(lastInsertRowid) });
});

router.get('/topics/:id', (req, res) => {
  const topic = db.prepare(`SELECT t.*, u.name AS author_name FROM topics t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?`)
    .get(id(req.params.id));
  if (!topic) return notFound(res, 'Argomento');
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(topic.subject_id);
  const notes = db.prepare(`
    SELECT n.id, n.title, n.description, n.original_name, n.mime, n.ext, n.size, n.created_at, n.user_id, u.name AS author_name
    FROM notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.topic_id = ? ORDER BY n.created_at DESC
  `).all(topic.id);
  const quizzes = db.prepare(`
    SELECT q.id, q.title, q.description, q.ai_generated, q.created_at, q.user_id, u.name AS author_name,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
    FROM quizzes q LEFT JOIN users u ON u.id = q.user_id
    WHERE q.topic_id = ? ORDER BY q.created_at DESC
  `).all(topic.id);
  res.json({ topic, subject, notes, quizzes });
});

router.patch('/topics/:id', (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id(req.params.id));
  if (!topic) return notFound(res, 'Argomento');
  if (!canManage(req.user, topic.created_by)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  db.prepare('UPDATE topics SET name = ?, description = ? WHERE id = ?').run(
    str(req.body?.name, 100) || topic.name,
    req.body?.description !== undefined ? str(req.body.description) : topic.description,
    topic.id,
  );
  const renamed = str(req.body?.name, 100);
  if (renamed && renamed !== topic.name) pushRename(topic.drive_id, renamed);
  res.json({ topic: db.prepare('SELECT * FROM topics WHERE id = ?').get(topic.id) });
});

router.delete('/topics/:id', (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id(req.params.id));
  if (!topic) return notFound(res, 'Argomento');
  if (!canManage(req.user, topic.created_by)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  const files = db.prepare('SELECT stored_name FROM notes WHERE topic_id = ?').all(topic.id).map((r) => r.stored_name);
  db.prepare('DELETE FROM topics WHERE id = ?').run(topic.id);
  removeStoredFiles(files);
  pushTrash(topic.drive_id);
  res.json({ ok: true });
});

// ---------- Appunti ----------

router.post('/topics/:id/notes', (req, res) => {
  upload.array('files', 20)(req, res, (err) => {
    const uploaded = req.files || [];
    const cleanup = () => removeStoredFiles(uploaded.map((f) => f.filename));
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File troppo grande (massimo ${config.maxUploadMb} MB).`
        : 'Caricamento non riuscito.';
      return res.status(400).json({ error: msg });
    }
    const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(id(req.params.id));
    if (!topic) {
      cleanup();
      return notFound(res, 'Argomento');
    }
    if (!uploaded.length) return res.status(400).json({ error: 'Seleziona almeno un file.' });

    const title = str(req.body?.title, 150);
    const description = str(req.body?.description, 1000);
    const insert = db.prepare(`INSERT INTO notes (topic_id, user_id, title, description, stored_name, original_name, mime, ext, size)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = transaction(() => uploaded.map((file) => {
      const original = path.basename(file.originalname).slice(0, 200) || 'file';
      const ext = extOf(original);
      const fallbackTitle = original.replace(/\.[^.]+$/, '') || original;
      const noteTitle = title && uploaded.length === 1 ? title : (title ? `${title} – ${fallbackTitle}` : fallbackTitle);
      return Number(insert.run(topic.id, req.user.id, noteTitle.slice(0, 150), description, file.filename, original,
        mimeFor(ext), ext, file.size).lastInsertRowid);
    }));
    pushNotes(ids);
    res.status(201).json({ ids });
  });
});

function getNote(noteId) {
  return db.prepare(`
    SELECT n.*, u.name AS author_name, t.name AS topic_name, t.subject_id, s.name AS subject_name, s.icon AS subject_icon
    FROM notes n
    JOIN topics t ON t.id = n.topic_id
    JOIN subjects s ON s.id = t.subject_id
    LEFT JOIN users u ON u.id = n.user_id
    WHERE n.id = ?
  `).get(noteId);
}
export { getNote };

router.get('/notes/recent', (req, res) => {
  const notes = db.prepare(`
    SELECT n.id, n.title, n.ext, n.mime, n.created_at, u.name AS author_name, t.id AS topic_id, t.name AS topic_name,
      s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
    FROM notes n JOIN topics t ON t.id = n.topic_id JOIN subjects s ON s.id = t.subject_id
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY n.created_at DESC LIMIT 8
  `).all();
  res.json({ notes });
});

router.get('/notes/mine', (req, res) => {
  const notes = db.prepare(`
    SELECT n.id, n.title, n.ext, n.mime, n.size, n.created_at, t.id AS topic_id, t.name AS topic_name, s.name AS subject_name
    FROM notes n JOIN topics t ON t.id = n.topic_id JOIN subjects s ON s.id = t.subject_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC
  `).all(req.user.id);
  res.json({ notes });
});

router.get('/notes/:id', (req, res) => {
  const note = getNote(id(req.params.id));
  if (!note) return notFound(res, 'Appunto');
  const { stored_name: _s, drive_id: driveId, ...rest } = note;
  res.json({ note: { ...rest, fromDrive: Boolean(driveId), policy: servingPolicy(note.mime), canManage: canManage(req.user, note.user_id) } });
});

// Il nome del file nell'URL è facoltativo: serve solo a mostrare un titolo sensato nel visualizzatore PDF.
router.get('/notes/:id/file{/:name}', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id(req.params.id));
  if (!note) return notFound(res, 'Appunto');
  const filePath = path.join(config.uploadDir, path.basename(note.stored_name));
  if (!fs.existsSync(filePath)) return notFound(res, 'File');

  const policy = servingPolicy(note.mime);
  const download = req.query.download === '1' || policy === 'attachment';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (policy === 'sandbox') {
    // HTML/SVG caricati dagli utenti: eseguiti in un'origine isolata, senza accesso a cookie e API del sito.
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-forms');
  }
  res.setHeader('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', note.original_name));
  res.type(note.mime);
  res.sendFile(filePath);
});

router.patch('/notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id(req.params.id));
  if (!note) return notFound(res, 'Appunto');
  if (!canManage(req.user, note.user_id)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  db.prepare('UPDATE notes SET title = ?, description = ? WHERE id = ?').run(
    str(req.body?.title, 150) || note.title,
    req.body?.description !== undefined ? str(req.body.description, 1000) : note.description,
    note.id,
  );
  res.json({ ok: true });
});

router.delete('/notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id(req.params.id));
  if (!note) return notFound(res, 'Appunto');
  if (!canManage(req.user, note.user_id)) return res.status(403).json({ error: 'Permessi insufficienti.' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  removeStoredFiles([note.stored_name]);
  pushTrash(note.drive_id);
  res.json({ ok: true });
});

// ---------- Ricerca ----------

router.get('/search', (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ subjects: [], topics: [], notes: [] });
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  res.json({
    subjects: db.prepare(`SELECT id, name, icon FROM subjects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT 10`).all(like, like),
    topics: db.prepare(`SELECT t.id, t.name, s.name AS subject_name FROM topics t JOIN subjects s ON s.id = t.subject_id
                        WHERE t.name LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' LIMIT 15`).all(like, like),
    notes: db.prepare(`SELECT n.id, n.title, n.ext, t.name AS topic_name, s.name AS subject_name FROM notes n
                       JOIN topics t ON t.id = n.topic_id JOIN subjects s ON s.id = t.subject_id
                       WHERE n.title LIKE ? ESCAPE '\\' OR n.description LIKE ? ESCAPE '\\' OR n.original_name LIKE ? ESCAPE '\\' LIMIT 20`).all(like, like, like),
  });
});

export default router;
