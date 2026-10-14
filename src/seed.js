// Materie con cui il sito parte. Vengono create una sola volta: se il proprietario
// ne elimina o rinomina una, non ricompare al riavvio.
import { db, getSetting, setSetting, transaction } from './db.js';
import { config } from './config.js';

export const DEFAULT_SUBJECTS = [
  { name: 'Storia', icon: '🏛️', color: '#b45309', description: 'Eventi, epoche e protagonisti dal mondo antico a oggi.' },
  { name: 'Filosofia', icon: '🦉', color: '#7c3aed', description: 'Pensatori, correnti e grandi domande della filosofia.' },
  { name: 'Scienze umane', icon: '🧠', color: '#db2777', description: 'Psicologia, pedagogia, sociologia e antropologia.' },
  { name: 'Fisica', icon: '⚛️', color: '#0284c7', description: 'Leggi della natura, formule ed esperimenti.' },
  { name: 'Italiano', icon: '📖', color: '#16a34a', description: 'Letteratura, autori, analisi del testo e grammatica.' },
  { name: 'Spagnolo', icon: '🇪🇸', color: '#dc2626', description: 'Grammatica, lessico, letteratura e cultura ispanica.' },
  { name: 'Inglese', icon: '🇬🇧', color: '#1d4ed8', description: 'Grammar, vocabulary, literature and culture.' },
  { name: 'Matematica', icon: '📐', color: '#ea580c', description: 'Algebra, geometria, analisi ed esercizi svolti.' },
  { name: 'Diritto', icon: '⚖️', color: '#475569', description: 'Costituzione, istituzioni e principi del diritto.' },
  { name: "Storia dell'arte", icon: '🎨', color: '#c026d3', description: 'Opere, artisti e movimenti dalla preistoria al contemporaneo.' },
];

export function seedDefaultSubjects() {
  if (!config.seedDefaultSubjects || getSetting('default_subjects_seeded') === 'true') return 0;
  const exists = db.prepare('SELECT 1 FROM subjects WHERE name = ? COLLATE NOCASE');
  const insert = db.prepare('INSERT INTO subjects (name, description, icon, color) VALUES (?, ?, ?, ?)');
  const created = transaction(() => {
    let n = 0;
    for (const s of DEFAULT_SUBJECTS) {
      if (exists.get(s.name)) continue;
      insert.run(s.name, s.description, s.icon, s.color);
      n += 1;
    }
    setSetting('default_subjects_seeded', 'true');
    return n;
  });
  if (created) console.log(`📚 Create ${created} materie predefinite.`);
  return created;
}
