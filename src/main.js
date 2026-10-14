import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { getSetting } from './db.js';
import { loadSession, checkOrigin, ensureOwner, clientIp, parseCookies } from './auth.js';
import { ping, leave } from './presence.js';
import authRoutes from './routes/auth.js';
import contentRoutes from './routes/content.js';
import quizRoutes from './routes/quizzes.js';
import aiRoutes from './routes/ai.js';
import adminRoutes from './routes/admin.js';
import { adminDrive, driveCallback } from './routes/drive.js';
import { startAutoSync } from './sync.js';
import { seedDefaultSubjects } from './seed.js';
import { scheduleBackup, startBackups } from './backup.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json({ limit: '1mb' }));

// Ogni modifica andata a buon fine fa partire (con un piccolo ritardo) la copia del database sul Drive.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.path !== '/presence') {
    res.on('finish', () => { if (res.statusCode < 400) scheduleBackup(); });
  }
  next();
});
app.use(checkOrigin);
app.use(loadSession);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Presenza in tempo reale: ogni pagina aperta invia un ping periodico.
app.post('/api/presence', (req, res) => {
  const visitorId = String(req.body?.visitorId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
    || crypto.createHash('sha256').update(clientIp(req) + (req.get('user-agent') || '')).digest('hex').slice(0, 16);
  const key = req.session ? `s:${req.session.id}:${visitorId}` : `v:${visitorId}`;
  if (req.body?.leaving) {
    leave(key);
  } else {
    // dopo l'accesso lo stesso visitatore non va più contato come ospite
    if (req.session) leave(`v:${visitorId}`);
    ping({
      key,
      user: req.user,
      sessionId: req.session?.id,
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      path: req.body?.path,
      title: req.body?.title,
    });
  }
  // se la sessione è stata revocata dal proprietario, il client lo scopre qui
  const hadCookie = Boolean(parseCookies(req.headers.cookie).sid);
  res.json({ ok: true, loggedIn: Boolean(req.user), sessionLost: hadCookie && !req.user });
});

app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin/drive', adminDrive);
app.use('/api/admin', adminRoutes);
app.use('/api/drive', driveCallback);
app.use('/api', contentRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Risorsa non trovata.' }));

// Librerie per le anteprime nel browser, servite direttamente dai pacchetti npm.
const vendor = {
  'marked.js': 'marked/lib/marked.umd.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'mammoth.js': 'mammoth/mammoth.browser.min.js',
  'pdf.mjs': 'pdfjs-dist/build/pdf.min.mjs',
  'pdf.worker.mjs': 'pdfjs-dist/build/pdf.worker.min.mjs',
};
app.use('/vendor/katex', express.static(path.join(config.root, 'node_modules', 'katex', 'dist'), { maxAge: '1d' }));
app.get('/vendor/:file', (req, res, next) => {
  const rel = vendor[req.params.file];
  if (!rel) return next();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(config.root, 'node_modules', rel));
});

// Pagine pubbliche richieste da Google per il collegamento al Drive (privacy e termini di servizio).
const legalPages = { '/privacy': ['privacy.html', 'Informativa sulla privacy'], '/termini': ['termini.html', 'Termini di servizio'] };
app.get(Object.keys(legalPages), (req, res) => {
  const [file, title] = legalPages[req.path];
  const read = (name) => fs.readFileSync(path.join(config.root, 'public', 'legal', name), 'utf8');
  const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const values = {
    TITLE: title,
    SITE_NAME: escape(getSetting('site_name') || 'Appunti del Senato'),
    CONTACT_EMAIL: escape(config.contactEmail),
    UPDATED: '14 ottobre 2026',
  };
  const html = read('layout.html').replace('{{CONTENT}}', read(file)).replace(/\{\{(\w+)\}\}/g, (m, k) => values[k] ?? m);
  res.type('html').send(html);
});
app.use('/legal', (req, res, next) => res.status(404).sendFile(path.join(config.root, 'public', '404.html')));

app.use(express.static(path.join(config.root, 'public'), { index: 'index.html' }));
// L'app usa URL con "#": qualsiasi altro percorso non esiste e mostra la pagina 404 personalizzata.
app.use((req, res) => res.status(404).sendFile(path.join(config.root, 'public', '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Errore interno del server.' });
});

await ensureOwner();
seedDefaultSubjects();
startAutoSync();
startBackups();
scheduleBackup();
app.listen(config.port, () => {
  console.log(`📚 Sito di studio avviato su http://localhost:${config.port}`);
  if (!config.aiEnabled) console.log('ℹ️  Assistente AI disattivato: imposta GEMINI_API_KEY (gratuita) per attivarlo.');
  else console.log(`🤖 Assistente AI attivo con ${config.aiProvider === 'gemini' ? 'Google Gemini' : 'Claude'}.`);
  if (!config.googleClientId) console.log('ℹ️  Sincronizzazione Google Drive disattivata: imposta GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.');
});
