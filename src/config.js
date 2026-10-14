import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carica .env se presente (Node >= 21.7), senza dipendenze esterne.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // nessun file .env: si usano solo le variabili d'ambiente
}

const env = process.env;

export const config = {
  root,
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || 'uploads'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB) || 50,
  sessionDays: Number(env.SESSION_DAYS) || 30,
  secureCookies: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  ownerEmail: (env.OWNER_EMAIL || 'bryansalguero26@icloud.com').trim().toLowerCase(),
  ownerPassword: env.OWNER_PASSWORD || '',
  ownerName: env.OWNER_NAME || 'Proprietario',
  aiModel: env.AI_MODEL || 'claude-opus-5-5',
  geminiApiKey: env.GEMINI_API_KEY || '',
  geminiModel: env.GEMINI_MODEL || '',
  geminiApiBase: (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
  // Gemini (chiave gratuita) ha la precedenza; altrimenti Claude se è presente la sua chiave
  aiProvider: env.GEMINI_API_KEY ? 'gemini' : (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ? 'anthropic' : null,
  get aiEnabled() { return Boolean(this.aiProvider); },
  aiDailyLimit: Number(env.AI_DAILY_LIMIT) || 100,
  seedDefaultSubjects: env.SEED_DEFAULT_SUBJECTS !== 'false',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  driveRefreshToken: env.DRIVE_REFRESH_TOKEN || '',
  driveRootFolder: env.DRIVE_ROOT_FOLDER || '',
  driveSyncMinutes: Number(env.DRIVE_SYNC_MINUTES) || 5,
  driveMaxFileMb: Number(env.DRIVE_MAX_FILE_MB) || 100,
  // sovrascrivibili solo per i test
  googleApiBase: (env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''),
  googleTokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  googleAuthUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
};
