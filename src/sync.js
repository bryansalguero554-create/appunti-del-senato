// Sincronizzazione bidirezionale tra il sito e una cartella di Google Drive.
//
//   Cartella principale (scelta dal proprietario)
//   ├── Storia/                 → materia
//   │   ├── Modulo 1/           → argomento
//   │   │   ├── lezione.pdf     → appunto
//   │   │   └── Riassunto (Documento Google, esportato in PDF)
//   │   └── Modulo 2/
//   └── Matematica/
//
// - Drive → sito: ogni pochi minuti (e su richiesta) cartelle e file vengono importati,
//   rinominati o rimossi in base a quello che c'è nel Drive.
// - Sito → Drive: materie e argomenti creati sul sito diventano cartelle, gli appunti caricati
//   vengono copiati nella cartella giusta; rinomine ed eliminazioni (nel cestino) vengono riportate.
// Tutte le operazioni passano da una coda unica, così non si sovrappongono mai.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSetting, setSetting, transaction } from './db.js';
import { config } from './config.js';
import { extOf, mimeFor } from './files.js';
import * as drive from './drive.js';

let queue = Promise.resolve();
// File eliminati sul sito ma non ancora spostati nel cestino del Drive: non vanno reimportati.
const pendingTrash = new Set();

/** Mette in coda un'operazione sul Drive; gli errori vengono registrati senza bloccare la coda. */
export function enqueue(label, fn) {
  const task = queue.then(async () => {
    if (!drive.driveReady()) return undefined;
    try {
      return await fn();
    } catch (err) {
      console.error(`[Drive] ${label}:`, err.message);
      setSetting('drive_last_error', `${new Date().toISOString()} – ${label}: ${err.message}`);
      return undefined;
    }
  });
  queue = task.catch(() => {});
  return task;
}

const uploadPath = (stored) => path.join(config.uploadDir, path.basename(stored));
const removeFile = (stored) => fs.rm(uploadPath(stored), { force: true }, () => {});
const ownerId = () => db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get()?.id ?? null;

function localName(file) {
  const exp = drive.EXPORTS[file.mimeType];
  return exp && extOf(file.name) !== exp.ext ? `${file.name}.${exp.ext}` : file.name;
}

async function importFile(file, topicId, stats, existing) {
  if (file.mimeType.startsWith('application/vnd.google-apps.') && !drive.EXPORTS[file.mimeType]) {
    stats.skipped += 1; // moduli, siti, scorciatoie…: non scaricabili
    return;
  }
  if (Number(file.size) > config.driveMaxFileMb * 1024 * 1024) {
    stats.skipped += 1;
    return;
  }
  const original = localName(file);
  const ext = extOf(original);
  const stored = crypto.randomBytes(16).toString('hex');
  const size = await drive.downloadTo(file, uploadPath(stored));
  const title = original.replace(/\.[^.]+$/, '') || original;
  if (existing) {
    db.prepare(`UPDATE notes SET title = ?, stored_name = ?, original_name = ?, mime = ?, ext = ?, size = ?, drive_modified = ?, topic_id = ?
                WHERE id = ?`).run(title, stored, original, mimeFor(ext), ext, size, file.modifiedTime, topicId, existing.id);
    removeFile(existing.stored_name);
    stats.updated += 1;
  } else {
    db.prepare(`INSERT INTO notes (topic_id, user_id, title, stored_name, original_name, mime, ext, size, drive_id, drive_modified)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(topicId, ownerId(), title, stored, original, mimeFor(ext), ext, size, file.id, file.modifiedTime);
    stats.notes += 1;
  }
}

/** Trova l'elemento locale collegato a una cartella del Drive, o ne collega/crea uno. */
function linkFolder(table, folder, parent) {
  const parentCol = table === 'topics' ? 'subject_id' : null;
  let row = db.prepare(`SELECT * FROM ${table} WHERE drive_id = ?`).get(folder.id);
  if (!row) {
    // una materia/argomento creato sul sito con lo stesso nome viene collegato invece di duplicarlo
    row = db.prepare(`SELECT * FROM ${table} WHERE drive_id IS NULL AND name = ? ${parentCol ? `AND ${parentCol} = ?` : ''}`)
      .get(...[folder.name, ...(parentCol ? [parent] : [])]);
    if (row) db.prepare(`UPDATE ${table} SET drive_id = ? WHERE id = ?`).run(folder.id, row.id);
  }
  if (!row) {
    const { lastInsertRowid } = parentCol
      ? db.prepare('INSERT INTO topics (subject_id, name, created_by, drive_id) VALUES (?, ?, ?, ?)').run(parent, folder.name, ownerId(), folder.id)
      : db.prepare('INSERT INTO subjects (name, created_by, drive_id) VALUES (?, ?, ?)').run(folder.name, ownerId(), folder.id);
    return { row: db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(lastInsertRowid), created: true };
  }
  if (row.name !== folder.name) db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(folder.name, row.id);
  return { row, created: false };
}

function deleteMissing(table, where, params, seen, stats, key) {
  const rows = db.prepare(`SELECT id, drive_id FROM ${table} WHERE drive_id IS NOT NULL AND ${where}`).all(...params);
  for (const r of rows) {
    if (seen.has(r.drive_id)) continue;
    const files = table === 'notes'
      ? db.prepare('SELECT stored_name FROM notes WHERE id = ?').all(r.id)
      : table === 'topics'
        ? db.prepare('SELECT stored_name FROM notes WHERE topic_id = ?').all(r.id)
        : db.prepare('SELECT n.stored_name FROM notes n JOIN topics t ON t.id = n.topic_id WHERE t.subject_id = ?').all(r.id);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id);
    files.forEach((f) => removeFile(f.stored_name));
    stats[key] += 1;
  }
}

async function pullFromDrive(stats) {
  const root = drive.driveRoot();
  const subjectFolders = (await drive.listChildren(root)).filter((f) => f.mimeType === drive.FOLDER_MIME);
  const linkedSubjects = db.prepare('SELECT COUNT(*) AS n FROM subjects WHERE drive_id IS NOT NULL').get().n;
  // Protezione: se la cartella principale risulta vuota ma prima non lo era, non si cancella nulla.
  const allowDelete = subjectFolders.length > 0 || linkedSubjects === 0;
  if (!allowDelete) stats.warnings.push('La cartella del Drive risulta vuota: nessuna materia è stata rimossa dal sito per sicurezza.');

  const seenSubjects = new Set();
  for (const sf of subjectFolders) {
    seenSubjects.add(sf.id);
    const { row: subject, created } = linkFolder('subjects', sf, null);
    if (created) stats.subjects += 1;

    const children = await drive.listChildren(sf.id);
    const seenTopics = new Set();
    for (const tf of children.filter((f) => f.mimeType === drive.FOLDER_MIME)) {
      seenTopics.add(tf.id);
      const { row: topic, created: newTopic } = linkFolder('topics', tf, subject.id);
      if (newTopic) stats.topics += 1;

      const files = (await drive.listChildren(tf.id)).filter((f) => f.mimeType !== drive.FOLDER_MIME);
      const seenNotes = new Set();
      for (const file of files) {
        seenNotes.add(file.id);
        if (pendingTrash.has(file.id)) continue;
        const existing = db.prepare('SELECT id, stored_name, drive_modified, topic_id FROM notes WHERE drive_id = ?').get(file.id);
        if (existing && existing.drive_modified === file.modifiedTime) {
          // file spostato in un'altra cartella del Drive
          if (existing.topic_id !== topic.id) db.prepare('UPDATE notes SET topic_id = ? WHERE id = ?').run(topic.id, existing.id);
          continue;
        }
        await importFile(file, topic.id, stats, existing);
      }
      deleteMissing('notes', 'topic_id = ?', [topic.id], seenNotes, stats, 'removed');
    }
    deleteMissing('topics', 'subject_id = ?', [subject.id], seenTopics, stats, 'removed');
  }
  if (allowDelete) deleteMissing('subjects', '1 = 1', [], seenSubjects, stats, 'removed');
}

async function pushToDrive(stats) {
  const root = drive.driveRoot();
  for (const s of db.prepare('SELECT id, name FROM subjects WHERE drive_id IS NULL').all()) {
    const folder = await drive.createFolder(s.name, root);
    db.prepare('UPDATE subjects SET drive_id = ? WHERE id = ?').run(folder.id, s.id);
    stats.pushed += 1;
  }
  const topics = db.prepare(`SELECT t.id, t.name, s.drive_id AS parent FROM topics t JOIN subjects s ON s.id = t.subject_id
                             WHERE t.drive_id IS NULL AND s.drive_id IS NOT NULL`).all();
  for (const t of topics) {
    const folder = await drive.createFolder(t.name, t.parent);
    db.prepare('UPDATE topics SET drive_id = ? WHERE id = ?').run(folder.id, t.id);
    stats.pushed += 1;
  }
  for (const n of db.prepare('SELECT n.id FROM notes n JOIN topics t ON t.id = n.topic_id WHERE n.drive_id IS NULL AND t.drive_id IS NOT NULL').all()) {
    if (await uploadNote(n.id)) stats.pushed += 1;
  }
}

async function uploadNote(noteId) {
  const note = db.prepare(`SELECT n.*, t.drive_id AS folder FROM notes n JOIN topics t ON t.id = n.topic_id WHERE n.id = ?`).get(noteId);
  if (!note || note.drive_id || !note.folder || !fs.existsSync(uploadPath(note.stored_name))) return false;
  const file = await drive.uploadFile(note.folder, note.original_name, note.mime, uploadPath(note.stored_name));
  db.prepare('UPDATE notes SET drive_id = ?, drive_modified = ? WHERE id = ?').run(file.id, file.modifiedTime, note.id);
  return true;
}

let syncing = false;
export const isSyncing = () => syncing;

/** Sincronizzazione completa (Drive → sito, poi sito → Drive). */
export function syncNow() {
  return enqueue('sincronizzazione', async () => {
    syncing = true;
    const stats = { subjects: 0, topics: 0, notes: 0, updated: 0, removed: 0, pushed: 0, skipped: 0, warnings: [] };
    const startedAt = Date.now();
    try {
      await pullFromDrive(stats);
      await pushToDrive(stats);
      setSetting('drive_last_sync', new Date().toISOString());
      setSetting('drive_last_result', JSON.stringify({ ...stats, ms: Date.now() - startedAt }));
      setSetting('drive_last_error', '');
      return stats;
    } finally {
      syncing = false;
    }
  });
}

// ---------- Modifiche fatte sul sito, riportate sul Drive ----------

export function pushSubject(subjectId) {
  enqueue('nuova materia', async () => {
    const s = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
    if (!s || s.drive_id) return;
    const folder = await drive.createFolder(s.name, drive.driveRoot());
    db.prepare('UPDATE subjects SET drive_id = ? WHERE id = ?').run(folder.id, s.id);
  });
}

export function pushTopic(topicId) {
  enqueue('nuovo argomento', async () => {
    const t = db.prepare('SELECT t.*, s.drive_id AS parent FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE t.id = ?').get(topicId);
    if (!t || t.drive_id || !t.parent) return;
    const folder = await drive.createFolder(t.name, t.parent);
    db.prepare('UPDATE topics SET drive_id = ? WHERE id = ?').run(folder.id, t.id);
  });
}

export function pushNotes(noteIds) {
  for (const id of noteIds) enqueue('caricamento appunto', () => uploadNote(id));
}

export function pushRename(driveId, name) {
  if (driveId) enqueue('rinomina', () => drive.rename(driveId, name));
}

export function pushTrash(driveId) {
  if (!driveId || !drive.driveReady()) return;
  pendingTrash.add(driveId);
  enqueue('eliminazione', () => drive.trash(driveId)).finally(() => pendingTrash.delete(driveId));
}

/** Scollega il Drive: gli elementi restano sul sito ma perdono il collegamento. */
export function unlinkAll() {
  transaction(() => {
    for (const table of ['subjects', 'topics', 'notes']) db.exec(`UPDATE ${table} SET drive_id = NULL`);
    db.exec('UPDATE notes SET drive_modified = NULL');
  });
}

export function startAutoSync() {
  const run = () => {
    if (drive.driveReady() && !syncing) syncNow();
  };
  setTimeout(run, 5_000);
  setInterval(run, config.driveSyncMinutes * 60_000).unref();
}

export function driveStatus() {
  let lastResult = null;
  try {
    lastResult = JSON.parse(getSetting('drive_last_result') || 'null');
  } catch { /* valore non valido */ }
  return {
    configured: drive.driveConfigured(),
    connected: drive.driveConnected(),
    account: getSetting('drive_account') || '',
    rootId: drive.driveRoot() || '',
    rootName: getSetting('drive_root_name') || '',
    lastSync: getSetting('drive_last_sync') || null,
    lastResult,
    lastError: getSetting('drive_last_error') || '',
    syncing,
    intervalMinutes: config.driveSyncMinutes,
  };
}
