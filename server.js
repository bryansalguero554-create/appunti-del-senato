import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './src/config.js';
import './src/db.js';
import { loadSession, checkOrigin, ensureOwner, clientIp, parseCookies } from './src/auth.js';
import { ping, leave } from './src/presence.js';
import authRoutes from './src/routes/auth.js';
import contentRoutes from './src/routes/content.js';
import quizRoutes from './src/routes/quizzes.js';
import aiRoutes from './src/routes/ai.js';
import adminRoutes from './src/routes/admin.js';

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
app.use(checkOrigin);
app.use(loadSession);

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
app.use('/api/admin', adminRoutes);
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
app.get('/vendor/:file', (req, res, next) => {
  const rel = vendor[req.params.file];
  if (!rel) return next();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(config.root, 'node_modules', rel));
});

app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', extensions: ['html'] }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Errore interno del server.' });
});

await ensureOwner();
app.listen(config.port, () => {
  console.log(`📚 Sito di studio avviato su http://localhost:${config.port}`);
  if (!config.aiEnabled) console.log('ℹ️  Assistente AI disattivato: imposta ANTHROPIC_API_KEY per attivarlo.');
});
