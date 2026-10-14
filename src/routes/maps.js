// Mappe concettuali per l'interrogazione: create e modificate con l'AI, personali per ogni studente.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, hasRole } from '../auth.js';

const router = Router();
router.use(requireAuth);

const id = (v) => Number.parseInt(v, 10);
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const MAX_NODES = 90;
const MAX_DEPTH = 5;

/**
 * Valida e normalizza una mappa ({ title, nodes: [{ id, parent, label, detail }] }) generata dall'AI
 * o modificata a mano: un'unica radice, nessun ciclo, profondità e numero di nodi limitati.
 */
export function normalizeMap(raw) {
  const title = str(raw?.title, 150);
  const input = (Array.isArray(raw?.nodes) ? raw.nodes : [])
    .map((n) => ({ id: str(n?.id, 40), parent: str(n?.parent, 40), label: str(n?.label, 90), detail: str(n?.detail, 220) }))
    .filter((n) => n.id && n.label);
  const byId = new Map();
  for (const n of input) if (!byId.has(n.id)) byId.set(n.id, n);
  const nodes = [...byId.values()];
  if (nodes.length < 2) throw new Error('La mappa deve avere almeno due concetti.');

  // radice: il primo nodo senza genitore valido; gli altri senza genitore diventano suoi figli
  const roots = nodes.filter((n) => !n.parent || !byId.has(n.parent) || n.parent === n.id);
  let root = roots[0];
  if (!root) root = nodes[0];
  root.parent = '';
  for (const n of roots.slice(1)) n.parent = root.id;

  // ogni nodo deve risalire alla radice senza cicli e senza superare la profondità massima
  const depthOf = new Map([[root.id, 0]]);
  const depth = (n, seen = new Set()) => {
    if (depthOf.has(n.id)) return depthOf.get(n.id);
    if (seen.has(n.id)) return Infinity;
    seen.add(n.id);
    const d = depth(byId.get(n.parent), seen) + 1;
    depthOf.set(n.id, d);
    return d;
  };
  for (const n of nodes) {
    if (depth(n) === Infinity) { n.parent = root.id; depthOf.set(n.id, 1); }
  }
  // l'ordine conta: genitori prima dei figli, poi l'ordine scelto dall'AI
  const kept = nodes.filter((n) => depthOf.get(n.id) <= MAX_DEPTH)
    .sort((a, b) => depthOf.get(a.id) - depthOf.get(b.id))
    .slice(0, MAX_NODES);
  const keptIds = new Set(kept.map((n) => n.id));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const final = kept.filter((n) => n === root || keptIds.has(n.parent)).sort((a, b) => order.get(a.id) - order.get(b.id));
  // la radice resta sempre per prima
  final.sort((a, b) => (a === root ? -1 : b === root ? 1 : 0));

  // id brevi e stabili
  const newId = new Map(final.map((n, i) => [n.id, `n${i + 1}`]));
  return {
    title: title || root.label,
    nodes: final.map((n) => ({ id: newId.get(n.id), parent: n.parent ? newId.get(n.parent) : '', label: n.label, detail: n.detail })),
  };
}

export function saveMap({ userId, noteId, map }) {
  const { lastInsertRowid } = db.prepare('INSERT INTO concept_maps (user_id, note_id, title, data) VALUES (?, ?, ?, ?)')
    .run(userId, noteId, map.title, JSON.stringify(map));
  return Number(lastInsertRowid);
}

export function updateMap(mapId, map) {
  db.prepare("UPDATE concept_maps SET title = ?, data = ?, updated_at = datetime('now') WHERE id = ?").run(map.title, JSON.stringify(map), mapId);
}

/** La mappa, se l'utente può vederla (la propria; il proprietario del sito le vede tutte). */
export function getMap(mapId, user) {
  const row = db.prepare(`SELECT m.*, n.title AS note_title FROM concept_maps m LEFT JOIN notes n ON n.id = m.note_id WHERE m.id = ?`).get(mapId);
  if (!row || (row.user_id !== user.id && !hasRole(user, 'owner'))) return null;
  return {
    id: row.id, note_id: row.note_id, note_title: row.note_title, title: row.title,
    created_at: row.created_at, updated_at: row.updated_at, nodes: JSON.parse(row.data).nodes,
  };
}

router.get('/', (req, res) => {
  const noteId = id(req.query.noteId);
  const rows = Number.isInteger(noteId)
    ? db.prepare('SELECT id, note_id, title, updated_at FROM concept_maps WHERE user_id = ? AND note_id = ? ORDER BY updated_at DESC').all(req.user.id, noteId)
    : db.prepare(`SELECT m.id, m.note_id, m.title, m.updated_at, n.title AS note_title FROM concept_maps m
                  LEFT JOIN notes n ON n.id = m.note_id WHERE m.user_id = ? ORDER BY m.updated_at DESC LIMIT 200`).all(req.user.id);
  res.json({ maps: rows });
});

router.get('/:id', (req, res) => {
  const map = getMap(id(req.params.id), req.user);
  if (!map) return res.status(404).json({ error: 'Mappa non trovata.' });
  res.json({ map });
});

/** Modifiche fatte a mano (testo dei concetti, nuovi rami, titolo). */
router.put('/:id', (req, res) => {
  const map = getMap(id(req.params.id), req.user);
  if (!map) return res.status(404).json({ error: 'Mappa non trovata.' });
  try {
    const next = normalizeMap({ title: req.body?.title ?? map.title, nodes: req.body?.nodes ?? map.nodes });
    updateMap(map.id, next);
    res.json({ map: { ...map, ...next } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const map = getMap(id(req.params.id), req.user);
  if (!map) return res.status(404).json({ error: 'Mappa non trovata.' });
  db.prepare('DELETE FROM concept_maps WHERE id = ?').run(map.id);
  res.json({ ok: true });
});

export default router;
