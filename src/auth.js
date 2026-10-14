import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { config } from './config.js';

export const COOKIE_NAME = 'sid';
const ROLE_RANK = { user: 0, moderator: 1, owner: 2 };

export const hashPassword = (password) => bcrypt.hash(password, 12);
export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  db.prepare(`INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, clientIp(req), String(req.get('user-agent') || '').slice(0, 300),
      expires.toISOString().replace('T', ' ').slice(0, 19));
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    expires,
    path: '/',
  });
}

export function destroySession(req, res) {
  if (req.session) {
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(req.session.id);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Legge il cookie di sessione e popola req.user / req.session se valido. */
export function loadSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) {
    const row = db.prepare(`
      SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.name, u.role, u.banned, u.created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
    `).get(sha256(token));
    if (row && !row.banned) {
      req.session = { id: row.session_id };
      req.user = { id: row.id, email: row.email, name: row.name, role: row.role, created_at: row.created_at };
      // aggiorna "ultima attività" al massimo una volta al minuto
      if (Date.now() - Date.parse(row.last_seen_at + 'Z') > 60_000) {
        db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), ip = ? WHERE id = ?")
          .run(clientIp(req), row.session_id);
      }
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Devi effettuare l\'accesso.' });
  next();
}

export function hasRole(user, role) {
  return Boolean(user) && ROLE_RANK[user.role] >= ROLE_RANK[role];
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Devi effettuare l\'accesso.' });
    if (!hasRole(req.user, role)) return res.status(403).json({ error: 'Permessi insufficienti.' });
    next();
  };
}

/** Il proprietario o i moderatori possono gestire qualsiasi contenuto; gli utenti solo il proprio. */
export function canManage(user, ownerId) {
  return hasRole(user, 'moderator') || (user && ownerId === user.id);
}

/**
 * Protezione CSRF: per le richieste che modificano dati l'header Origin (se presente)
 * deve coincidere con l'host del sito. Insieme al cookie SameSite=Lax è sufficiente.
 */
export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Origine della richiesta non valida.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origine della richiesta non valida.' });
    }
  }
  next();
}

// Limite tentativi di accesso: 10 tentativi falliti per IP ogni 15 minuti.
const failedLogins = new Map();
export function loginThrottled(ip) {
  const entry = failedLogins.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60_000) {
    failedLogins.delete(ip);
    return false;
  }
  return entry.count >= 10;
}
export function recordFailedLogin(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > 15 * 60_000) failedLogins.set(ip, { count: 1, first: Date.now() });
  else entry.count += 1;
}
export function clearFailedLogins(ip) {
  failedLogins.delete(ip);
}

/** Crea (o promuove) l'account del proprietario all'avvio. */
export async function ensureOwner() {
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(config.ownerEmail);
  if (existing) {
    if (existing.role !== 'owner') db.prepare("UPDATE users SET role = 'owner', banned = 0 WHERE id = ?").run(existing.id);
    return;
  }
  if (!config.ownerPassword) {
    console.warn(`\n⚠️  Account proprietario (${config.ownerEmail}) non ancora creato: imposta OWNER_PASSWORD nel file .env`
      + ' oppure esegui "npm run set-owner-password -- <password>".\n');
    return;
  }
  const hash = await hashPassword(config.ownerPassword);
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')")
    .run(config.ownerEmail, config.ownerName, hash);
  console.log(`👑 Account proprietario creato: ${config.ownerEmail}`);
}
