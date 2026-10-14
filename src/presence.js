// Tiene traccia, in memoria, di chi sta visitando il sito in questo momento.
// Il client invia un "ping" ogni ~20 secondi con la pagina corrente.

const ONLINE_WINDOW_MS = 60_000;
const visitors = new Map();

export function ping({ key, user, sessionId, ip, userAgent, path, title }) {
  const now = Date.now();
  const prev = visitors.get(key);
  visitors.set(key, {
    key,
    userId: user?.id ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    role: user?.role ?? null,
    sessionId: sessionId ?? null,
    ip,
    userAgent,
    path: String(path || '/').slice(0, 200),
    title: String(title || '').slice(0, 200),
    since: prev?.since ?? now,
    pageSince: prev && prev.path === path ? prev.pageSince : now,
    lastSeen: now,
  });
}

export function leave(key) {
  visitors.delete(key);
}

export function online() {
  const now = Date.now();
  const list = [];
  for (const [key, v] of visitors) {
    if (now - v.lastSeen > ONLINE_WINDOW_MS) visitors.delete(key);
    else list.push(v);
  }
  return list.sort((a, b) => b.lastSeen - a.lastSeen);
}

export function dropSession(sessionId) {
  for (const [key, v] of visitors) if (v.sessionId === sessionId) visitors.delete(key);
}

export function dropUser(userId) {
  for (const [key, v] of visitors) if (v.userId === userId) visitors.delete(key);
}
