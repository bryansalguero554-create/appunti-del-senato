// Copia di sicurezza del database su Google Drive.
// Su un server gratuito il disco si azzera a ogni riavvio: il database viene salvato
// nel Drive pochi secondi dopo ogni modifica e ripristinato all'avvio (vedi restore.js).
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import * as drive from './drive.js';
import { SYSTEM_FOLDER, DB_BACKUP_NAME, restoreState } from './restore.js';

const DEBOUNCE_MS = 10_000;
let timer = null;
let running = null;
let pending = false;

export const backupEnabled = () => drive.driveConnected() && !restoreState.failed;

async function systemFolderId() {
  const cached = getSetting('drive_system_folder');
  if (cached) {
    try {
      const f = await drive.getFile(cached);
      if (!f.trashed) return cached;
    } catch { /* cartella eliminata: si ricrea */ }
  }
  const found = await drive.findByName(SYSTEM_FOLDER, 'root', drive.FOLDER_MIME);
  const id = found?.id || (await drive.createFolder(SYSTEM_FOLDER, 'root')).id;
  setSetting('drive_system_folder', id);
  return id;
}

async function runBackup() {
  const folderId = await systemFolderId();
  const snapshot = path.join(config.dataDir, `backup-${Date.now()}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`); // copia coerente anche mentre il sito è in uso
    const existing = getSetting('drive_backup_file');
    let fileId = null;
    if (existing) {
      try {
        await drive.updateFileContent(existing, 'application/x-sqlite3', snapshot);
        fileId = existing;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    if (!fileId) {
      const found = await drive.findByName(DB_BACKUP_NAME, folderId);
      if (found) await drive.updateFileContent(found.id, 'application/x-sqlite3', snapshot);
      fileId = found?.id || (await drive.uploadFile(folderId, DB_BACKUP_NAME, 'application/x-sqlite3', snapshot)).id;
    }
    // salvato dopo lo snapshot: alla prossima copia il valore sarà già incluso
    if (getSetting('drive_backup_file') !== fileId) setSetting('drive_backup_file', fileId);
    setSetting('drive_last_backup', new Date().toISOString());
  } finally {
    fs.rm(snapshot, { force: true }, () => {});
  }
}

/** Esegue subito un backup (o attende quello in corso e poi ne fa un altro). */
export async function backupNow() {
  if (!backupEnabled()) return false;
  clearTimeout(timer);
  timer = null;
  if (running) {
    pending = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        pending = false;
        await runBackup();
      } while (pending);
      return true;
    } catch (err) {
      console.error('[Backup Drive]', err.message);
      setSetting('drive_last_error', `${new Date().toISOString()} – backup del database: ${err.message}`);
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Pianifica un backup a breve: più modifiche ravvicinate producono una sola copia. */
export function scheduleBackup() {
  if (!backupEnabled()) return;
  if (running) {
    pending = true;
    return;
  }
  if (!timer) timer = setTimeout(backupNow, DEBOUNCE_MS);
}

export function startBackups() {
  setInterval(() => { if (backupEnabled()) scheduleBackup(); }, 15 * 60_000).unref();
  const shutdown = async (signal) => {
    if (timer || running) {
      console.log(`☁️  ${signal}: salvo il database nel Drive prima di chiudere…`);
      await backupNow();
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
