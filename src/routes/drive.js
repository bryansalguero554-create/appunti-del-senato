import crypto from 'node:crypto';
import { Router } from 'express';
import { getSetting, setSetting } from '../db.js';
import { backupNow } from '../backup.js';
import { requireRole } from '../auth.js';
import * as drive from '../drive.js';
import { syncNow, driveStatus, unlinkAll } from '../sync.js';

// Collegamento a Google Drive, gestito solo dal proprietario.
export const adminDrive = Router();
export const driveCallback = Router();

const pendingStates = new Map(); // state OAuth → { sessionId, expires }

adminDrive.use(requireRole('owner'));

adminDrive.get('/', (req, res) => res.json(driveStatus()));

// Il proprietario lo copia in DRIVE_REFRESH_TOKEN sul server, così il collegamento sopravvive ai riavvii.
adminDrive.get('/token', (req, res) => res.json({ token: getSetting('drive_refresh_token') || '' }));

adminDrive.post('/backup', async (req, res) => {
  const ok = await backupNow();
  if (!ok) return res.status(502).json({ error: driveStatus().lastError || 'Backup non riuscito.' });
  res.json({ ok: true, status: driveStatus() });
});

adminDrive.get('/connect', (req, res) => {
  if (!drive.driveConfigured()) {
    return res.status(400).json({ error: 'Imposta prima GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET sul server (vedi la guida nel README).' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { sessionId: req.session.id, expires: Date.now() + 10 * 60_000 });
  res.json({ url: drive.authUrl(req, state), redirectUri: drive.redirectUri(req) });
});

adminDrive.get('/folders', async (req, res) => {
  try {
    res.json({ folders: await drive.listTopLevelFolders() });
  } catch (err) {
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

adminDrive.post('/root', async (req, res) => {
  const id = drive.parseFolderId(req.body?.folder);
  if (!id) return res.status(400).json({ error: 'Incolla il link della cartella di Google Drive (o il suo ID).' });
  try {
    const folder = await drive.getFile(id);
    if (folder.mimeType !== drive.FOLDER_MIME) return res.status(400).json({ error: 'Il link non è una cartella.' });
    if (folder.id !== drive.driveRoot()) unlinkAll(); // cambiando cartella si riparte da zero
    setSetting('drive_root_id', folder.id);
    setSetting('drive_root_name', folder.name);
    const stats = await syncNow();
    res.json({ ok: true, folder: { id: folder.id, name: folder.name }, stats });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 404 ? 'Cartella non trovata o non accessibile.' : err.message });
  }
});

adminDrive.post('/sync', async (req, res) => {
  if (!drive.driveReady()) return res.status(400).json({ error: 'Collega Google Drive e scegli la cartella principale.' });
  const stats = await syncNow();
  const status = driveStatus();
  if (!stats) return res.status(502).json({ error: status.lastError || 'Sincronizzazione non riuscita.', status });
  res.json({ stats, status });
});

adminDrive.post('/disconnect', (req, res) => {
  setSetting('drive_refresh_token', '');
  setSetting('drive_account', '');
  setSetting('drive_root_id', '');
  setSetting('drive_root_name', '');
  drive.forgetToken();
  unlinkAll();
  res.json({ ok: true });
});

// Google rimanda qui il proprietario dopo aver concesso l'accesso.
driveCallback.get('/callback', async (req, res) => {
  const pending = pendingStates.get(String(req.query.state || ''));
  pendingStates.delete(String(req.query.state || ''));
  const back = (msg) => res.redirect(`/#/admin?tab=drive&esito=${encodeURIComponent(msg)}`);
  if (!pending || pending.expires < Date.now() || !req.session || pending.sessionId !== req.session.id) {
    return back('Collegamento scaduto o non valido, riprova.');
  }
  if (req.query.error) return back('Accesso a Google Drive negato.');
  try {
    await drive.exchangeCode(req, String(req.query.code || ''));
    backupNow();
    back('ok');
  } catch (err) {
    back(err.message);
  }
});
