// Client minimale per l'API di Google Drive v3 (OAuth del proprietario del sito).
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive';

// I file nativi di Google (Documenti, Presentazioni, Fogli…) vengono esportati in un formato leggibile.
export const EXPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
};

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const driveConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
const refreshToken = () => getSetting('drive_refresh_token') || config.driveRefreshToken;
export const driveConnected = () => driveConfigured() && Boolean(refreshToken());
export const driveRoot = () => getSetting('drive_root_id') || config.driveRootFolder;
export const driveReady = () => driveConnected() && Boolean(driveRoot());

export function redirectUri(req) {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/drive/callback`;
}

export function authUrl(req, state) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${config.googleAuthUrl}?${params}`;
}

let cachedToken = null;

async function tokenRequest(params) {
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      // accesso revocato dall'utente: serve ricollegare il Drive
      setSetting('drive_refresh_token', '');
      cachedToken = null;
      throw new DriveError('L\'accesso a Google Drive è stato revocato: ricollega il Drive dall\'area riservata.', 401);
    }
    throw new DriveError(`Autenticazione Google non riuscita (${data.error || res.status}).`, res.status);
  }
  return data;
}

export async function exchangeCode(req, code) {
  const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });
  if (!data.refresh_token) throw new DriveError('Google non ha restituito un token permanente: riprova il collegamento.', 400);
  setSetting('drive_refresh_token', data.refresh_token);
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  const about = await api('/about', { query: { fields: 'user(emailAddress,displayName)' } });
  setSetting('drive_account', about.user?.emailAddress || '');
}

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const token = refreshToken();
  if (!token) throw new DriveError('Google Drive non è collegato.', 400);
  const data = await tokenRequest({ refresh_token: token, grant_type: 'refresh_token' });
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

export function forgetToken() {
  cachedToken = null;
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${await accessToken()}`, ...headers } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new DriveError(`Google Drive: ${data.error?.message || res.statusText}`, res.status);
  }
  return res;
}

async function api(path, { method = 'GET', query = {}, body } = {}) {
  const qs = new URLSearchParams({ supportsAllDrives: 'true', ...query });
  const res = await request(`${config.googleApiBase}/drive/v3${path}?${qs}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status === 204 ? null : res.json();
}

const FIELDS = 'id,name,mimeType,modifiedTime,size,trashed';

export async function getFile(id) {
  return api(`/files/${encodeURIComponent(id)}`, { query: { fields: FIELDS } });
}

export async function listChildren(folderId) {
  const files = [];
  let pageToken;
  do {
    const data = await api('/files', {
      query: {
        q: `'${folderId.replace(/['\\]/g, '\\$&')}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      },
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

export async function listTopLevelFolders() {
  const data = await api('/files', {
    query: { q: `'root' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`, fields: 'files(id,name)', pageSize: '200', orderBy: 'name' },
  });
  return data.files || [];
}

/** Scarica (o esporta, per i file nativi Google) il contenuto in destPath. */
export async function downloadTo(file, destPath) {
  const exp = EXPORTS[file.mimeType];
  const url = exp
    ? `${config.googleApiBase}/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`
    : `${config.googleApiBase}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const res = await request(url);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
}

export async function createFolder(name, parentId) {
  return api('/files', { method: 'POST', query: { fields: FIELDS }, body: { name, mimeType: FOLDER_MIME, parents: [parentId] } });
}

/** Caricamento "resumable": funziona anche per file grandi. */
export async function uploadFile(parentId, name, mime, filePath) {
  const start = await request(`${config.googleApiBase}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  const location = start.headers.get('location');
  if (!location) throw new DriveError('Google Drive non ha avviato il caricamento.', 502);
  const res = await request(location, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'Content-Length': String(fs.statSync(filePath).size) },
    body: fs.readFileSync(filePath),
  });
  return res.json();
}

export async function rename(id, name) {
  return api(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: FIELDS }, body: { name } });
}

/** Sposta nel cestino del Drive (recuperabile per 30 giorni). */
export async function trash(id) {
  return api(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: 'id' }, body: { trashed: true } });
}

/** Accetta un link di Google Drive o direttamente l'ID della cartella. */
export function parseFolderId(input) {
  const s = String(input || '').trim();
  const fromUrl = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  return /^[a-zA-Z0-9_-]{10,}$/.test(s) ? s : null;
}
