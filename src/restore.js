// Ripristino del database dalla copia salvata su Google Drive.
// Non importa db.js: deve girare PRIMA che il database venga aperto.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

export const SYSTEM_FOLDER = 'Appunti del Senato – dati del sito (non toccare)';
export const DB_BACKUP_NAME = 'database.sqlite';
export const dbPath = () => path.join(config.dataDir, 'studio.db');

const q = (s) => s.replace(/['\\]/g, '\\$&');

async function token() {
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.driveRefreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token Google non valido (${res.status})`);
  return (await res.json()).access_token;
}

async function findOne(accessToken, query) {
  const params = new URLSearchParams({ q: query, fields: 'files(id,name,modifiedTime)', pageSize: '10', supportsAllDrives: 'true' });
  const res = await fetch(`${config.googleApiBase}/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`ricerca nel Drive non riuscita (${res.status})`);
  return (await res.json()).files?.[0] || null;
}

/** Se il ripristino fallisce, i backup vengono sospesi per non sovrascrivere la copia buona nel Drive. */
export const restoreState = { failed: false, error: '' };

async function tryRestore() {
  const accessToken = await token();
  const folder = await findOne(accessToken, `name = '${q(SYSTEM_FOLDER)}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (!folder) {
    console.log('☁️  Nessuna copia del database nel Drive: si parte da zero.');
    return;
  }
  const file = await findOne(accessToken, `name = '${DB_BACKUP_NAME}' and '${q(folder.id)}' in parents and trashed = false`);
  if (!file) return;
  const res = await fetch(`${config.googleApiBase}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`download non riuscito (${res.status})`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${dbPath()}.download`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dbPath());
  console.log(`☁️  Database ripristinato dal Drive (copia del ${file.modifiedTime}).`);
}

export async function restoreDatabase() {
  if (fs.existsSync(dbPath())) return;
  if (!config.googleClientId || !config.googleClientSecret || !config.driveRefreshToken) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await tryRestore();
      return;
    } catch (err) {
      restoreState.error = err.message;
      console.error(`⚠️  Ripristino del database dal Drive non riuscito (tentativo ${attempt}/3): ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  restoreState.failed = true;
  console.error('❌ Il sito parte senza i dati del Drive e NON farà backup finché il problema non è risolto.');
}
