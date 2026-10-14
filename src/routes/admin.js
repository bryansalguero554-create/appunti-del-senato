import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { requireRole, hashPassword } from '../auth.js';
import { online, dropSession, dropUser } from '../presence.js';

// Area privata del proprietario del sito.
const router = Router();
router.use(requireRole('owner'));

const id = (v) => Number.parseInt(v, 10);
const count = (sql, ...params) => db.prepare(sql).get(...params).n;

router.get('/stats', (req, res) => {
  const visitors = online();
  res.json({
    users: count('SELECT COUNT(*) AS n FROM users'),
    subjects: count('SELECT COUNT(*) AS n FROM subjects'),
    topics: count('SELECT COUNT(*) AS n FROM topics'),
    notes: count('SELECT COUNT(*) AS n FROM notes'),
    quizzes: count('SELECT COUNT(*) AS n FROM quizzes'),
    attempts: count('SELECT COUNT(*) AS n FROM quiz_attempts'),
    storageBytes: count('SELECT COALESCE(SUM(size), 0) AS n FROM notes'),
    activeSessions: count("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > datetime('now')"),
    aiToday: count("SELECT COUNT(*) AS n FROM ai_requests WHERE created_at > datetime('now', '-1 day')"),
    onlineUsers: new Set(visitors.filter((v) => v.userId).map((v) => v.userId)).size,
    onlineGuests: visitors.filter((v) => !v.userId).length,
    aiEnabled: config.aiEnabled,
    uploadsPerDay: db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS n FROM notes
                               WHERE created_at > datetime('now', '-14 days') GROUP BY day ORDER BY day`).all(),
    signupsPerDay: db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS n FROM users
                               WHERE created_at > datetime('now', '-14 days') GROUP BY day ORDER BY day`).all(),
    topContributors: db.prepare(`SELECT u.name, COUNT(n.id) AS n FROM notes n JOIN users u ON u.id = n.user_id
                                 GROUP BY u.id ORDER BY n DESC LIMIT 5`).all(),
  });
});

router.get('/online', (req, res) => {
  res.json({ visitors: online().map(({ key, ...v }) => v), now: Date.now() });
});

router.get('/sessions', (req, res) => {
  const onlineSessions = new Map(online().filter((v) => v.sessionId).map((v) => [v.sessionId, v]));
  const sessions = db.prepare(`
    SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at,
           u.id AS user_id, u.name, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > datetime('now')
    ORDER BY s.last_seen_at DESC
  `).all().map((s) => {
    const live = onlineSessions.get(s.id);
    return { ...s, online: Boolean(live), page: live?.path ?? null, current: s.id === req.session.id };
  });
  res.json({ sessions });
});

router.delete('/sessions/:id', (req, res) => {
  const sessionId = id(req.params.id);
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(sessionId);
  dropSession(sessionId);
  res.json({ ok: true });
});

router.post('/sessions/revoke-all', (req, res) => {
  // termina tutte le sessioni tranne quella del proprietario in uso
  const { changes } = db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND id != ?")
    .run(req.session.id);
  for (const v of online()) if (v.sessionId && v.sessionId !== req.session.id) dropSession(v.sessionId);
  res.json({ ok: true, revoked: changes });
});

router.get('/users', (req, res) => {
  const onlineIds = new Set(online().map((v) => v.userId).filter(Boolean));
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.banned, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS note_count,
      (SELECT COUNT(*) FROM quizzes q WHERE q.user_id = u.id) AS quiz_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > datetime('now')) AS session_count
    FROM users u ORDER BY u.created_at DESC
  `).all().map((u) => ({ ...u, online: onlineIds.has(u.id) }));
  res.json({ users });
});

function loadTarget(req, res) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id(req.params.id));
  if (!user) {
    res.status(404).json({ error: 'Utente non trovato.' });
    return null;
  }
  if (user.role === 'owner') {
    res.status(400).json({ error: 'Non puoi modificare l\'account del proprietario da qui.' });
    return null;
  }
  return user;
}

function revokeUserSessions(userId) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(userId);
  dropUser(userId);
}

router.patch('/users/:id', (req, res) => {
  const user = loadTarget(req, res);
  if (!user) return;
  const role = ['user', 'moderator'].includes(req.body?.role) ? req.body.role : user.role;
  const banned = req.body?.banned === undefined ? user.banned : (req.body.banned ? 1 : 0);
  db.prepare('UPDATE users SET role = ?, banned = ? WHERE id = ?').run(role, banned, user.id);
  if (banned) revokeUserSessions(user.id);
  res.json({ ok: true });
});

router.post('/users/:id/logout', (req, res) => {
  const user = loadTarget(req, res);
  if (!user) return;
  revokeUserSessions(user.id);
  res.json({ ok: true });
});

router.post('/users/:id/password', async (req, res) => {
  const user = loadTarget(req, res);
  if (!user) return;
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  revokeUserSessions(user.id);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const user = loadTarget(req, res);
  if (!user) return;
  const files = db.prepare('SELECT stored_name FROM notes WHERE user_id = ?').all(user.id).map((r) => r.stored_name);
  if (req.query.withContent === '1') db.prepare('DELETE FROM notes WHERE user_id = ?').run(user.id);
  dropUser(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  if (req.query.withContent === '1') {
    for (const f of files) fs.rm(path.join(config.uploadDir, path.basename(f)), { force: true }, () => {});
  }
  res.json({ ok: true });
});

router.get('/notes', (req, res) => {
  const notes = db.prepare(`
    SELECT n.id, n.title, n.ext, n.size, n.created_at, u.name AS author_name, u.email AS author_email,
      t.id AS topic_id, t.name AS topic_name, s.name AS subject_name
    FROM notes n JOIN topics t ON t.id = n.topic_id JOIN subjects s ON s.id = t.subject_id
    LEFT JOIN users u ON u.id = n.user_id ORDER BY n.created_at DESC LIMIT 500
  `).all();
  res.json({ notes });
});

router.get('/settings', (req, res) => {
  res.json({
    site_name: getSetting('site_name'),
    announcement: getSetting('announcement'),
    registration_open: getSetting('registration_open') === 'true',
  });
});

router.put('/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.site_name === 'string' && b.site_name.trim()) setSetting('site_name', b.site_name.trim().slice(0, 60));
  if (typeof b.announcement === 'string') setSetting('announcement', b.announcement.trim().slice(0, 500));
  if (typeof b.registration_open === 'boolean') setSetting('registration_open', b.registration_open);
  res.json({ ok: true });
});

export default router;
