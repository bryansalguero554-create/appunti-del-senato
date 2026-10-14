import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireAuth, clientIp,
  loginThrottled, recordFailedLogin, clearFailedLogins,
} from '../auth.js';
import { dropSession } from '../presence.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at });

router.get('/me', (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null,
    site: {
      name: getSetting('site_name'),
      announcement: getSetting('announcement'),
      registrationOpen: getSetting('registration_open') === 'true',
      aiEnabled: config.aiEnabled,
      maxUploadMb: config.maxUploadMb,
    },
  });
});

router.post('/register', async (req, res) => {
  if (getSetting('registration_open') !== 'true') {
    return res.status(403).json({ error: 'Le registrazioni sono momentaneamente chiuse.' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email non valida.' });
  if (name.length < 2) return res.status(400).json({ error: 'Inserisci un nome di almeno 2 caratteri.' });
  if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });
  if (email === config.ownerEmail) {
    return res.status(403).json({ error: 'Questa email è riservata.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Esiste già un account con questa email.' });
  }
  const hash = await hashPassword(password);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
    .run(email, name, hash);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(lastInsertRowid);
  createSession(res, req, Number(lastInsertRowid));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  if (loginThrottled(ip)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Email o password errati.' });
  }
  if (user.banned) return res.status(403).json({ error: 'Questo account è stato sospeso.' });
  clearFailedLogins(ip);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  createSession(res, req, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  if (req.session) dropSession(req.session.id);
  destroySession(req, res);
  res.json({ ok: true });
});

router.post('/password', requireAuth, async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri.' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(current, row.password_hash))) {
    return res.status(400).json({ error: 'La password attuale non è corretta.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
  // chiude tutte le altre sessioni
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
    .run(req.user.id, req.session.id);
  res.json({ ok: true });
});

router.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
    ORDER BY last_seen_at DESC
  `).all(req.user.id);
  res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === req.session.id })) });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?").run(id, req.user.id);
  dropSession(id);
  res.json({ ok: true });
});

export default router;
