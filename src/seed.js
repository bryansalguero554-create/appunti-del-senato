// Materie con cui il sito parte. Vengono create una sola volta: se il proprietario
// ne elimina o rinomina una, non ricompare al riavvio.
import { db, getSetting, setSetting, transaction } from './db.js';
import { config } from './config.js';

export const DEFAULT_SUBJECTS = [
  { name: 'Storia', icon: '🏛️', color: '#b45309', description: 'Eventi, epoche e protagonisti dall\'antichità a oggi.' },
  { name: 'Filosofia', icon: '🦉', color: '#7c3aed', description: 'Pensatori, correnti e grandi domande.' },
  { name: 'Scienze umane', icon: '🧠', color: '#db2777', description: 'Psicologia, pedagogia, sociologia e antropologia.' },
  { name: 'Fisica', icon: '⚛️', color: '#0284c7', description: 'Leggi della natura, formule ed esperimenti.' },
  { name: 'Italiano', icon: '📖', color: '#16a34a', description: 'Letteratura, autori, testi e grammatica.' },
  { name: 'Spagnolo', icon: '🇪🇸', color: '#dc2626', description: 'Grammatica, lessico e cultura ispanica.' },
  { name: 'Inglese', icon: '🇬🇧', color: '#1d4ed8', description: 'Grammar, vocabulary, literature and culture.' },
  { name: 'Matematica', icon: '📐', color: '#ea580c', description: 'Algebra, geometria, analisi ed esercizi.' },
  { name: 'Diritto', icon: '⚖️', color: '#475569', description: 'Costituzione, istituzioni e principi del diritto.' },
  { name: "Storia dell'arte", icon: '🎨', color: '#c026d3', description: 'Opere, artisti e movimenti artistici.' },
];

// Descrizioni delle prime versioni, più lunghe (venivano tagliate nelle card): vengono aggiornate
// solo se il proprietario non le ha cambiate.
const OLD_DESCRIPTIONS = {
  Storia: 'Eventi, epoche e protagonisti dal mondo antico a oggi.',
  Filosofia: 'Pensatori, correnti e grandi domande della filosofia.',
  Italiano: 'Letteratura, autori, analisi del testo e grammatica.',
  Spagnolo: 'Grammatica, lessico, letteratura e cultura ispanica.',
  Matematica: 'Algebra, geometria, analisi ed esercizi svolti.',
  "Storia dell'arte": 'Opere, artisti e movimenti dalla preistoria al contemporaneo.',
};

/** Confronto tollerante dei nomi: maiuscole, accenti, apostrofi "curvi" di iPhone/Drive e spazi. */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Nomi alternativi con cui una materia predefinita può comparire (es. una cartella del Drive chiamata "Arte").
const ALIASES = { arte: "Storia dell'arte", "storia arte": "Storia dell'arte", "scienze umane e sociali": 'Scienze umane' };

export function defaultFor(name) {
  const n = normalizeName(name);
  const target = ALIASES[n] ? normalizeName(ALIASES[n]) : n;
  return DEFAULT_SUBJECTS.find((s) => normalizeName(s.name) === target) || null;
}

/**
 * Completa icona, colore e descrizione delle materie che corrispondono a una predefinita
 * (anche se create da una cartella del Drive o scritte in modo leggermente diverso),
 * senza toccare quello che il proprietario ha personalizzato.
 */
export function applySubjectDefaults() {
  const rows = db.prepare('SELECT id, name, description, icon, color FROM subjects').all();
  const update = db.prepare('UPDATE subjects SET description = ?, icon = ?, color = ? WHERE id = ?');
  for (const row of rows) {
    const def = defaultFor(row.name);
    if (!def) continue;
    const oldDesc = OLD_DESCRIPTIONS[def.name];
    const description = !row.description || row.description === oldDesc ? def.description : row.description;
    const icon = !row.icon || row.icon === '📚' ? def.icon : row.icon;
    const color = !row.color || row.color === '#4f46e5' ? def.color : row.color;
    if (description !== row.description || icon !== row.icon || color !== row.color) update.run(description, icon, color, row.id);
  }
}

export function seedDefaultSubjects() {
  if (!config.seedDefaultSubjects) return 0;
  if (getSetting('default_subjects_seeded') !== 'true') {
    const existing = new Set(db.prepare('SELECT name FROM subjects').all().map((r) => normalizeName(defaultFor(r.name)?.name || r.name)));
    const insert = db.prepare('INSERT INTO subjects (name, description, icon, color) VALUES (?, ?, ?, ?)');
    const created = transaction(() => {
      let n = 0;
      for (const s of DEFAULT_SUBJECTS) {
        if (existing.has(normalizeName(s.name))) continue;
        insert.run(s.name, s.description, s.icon, s.color);
        n += 1;
      }
      setSetting('default_subjects_seeded', 'true');
      return n;
    });
    if (created) console.log(`📚 Create ${created} materie predefinite.`);
  }
  applySubjectDefaults();
  return 0;
}
