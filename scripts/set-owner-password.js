// Uso: npm run set-owner-password -- "NuovaPassword"
// Crea l'account del proprietario (se non esiste) o ne reimposta la password.
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Specifica una password di almeno 8 caratteri: npm run set-owner-password -- "password"');
  process.exit(1);
}
const hash = await hashPassword(password);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(config.ownerEmail);
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'owner', banned = 0 WHERE id = ?").run(hash, existing.id);
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(existing.id);
  console.log(`🔑 Password aggiornata per ${config.ownerEmail}`);
} else {
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')").run(config.ownerEmail, config.ownerName, hash);
  console.log(`👑 Account proprietario creato: ${config.ownerEmail}`);
}
