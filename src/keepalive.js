// Tiene sveglio il sito sul piano gratuito di Render, che lo spegne dopo 15 minuti senza visite
// (la riapertura richiede quasi un minuto). Ogni 10 minuti il server visita il proprio indirizzo
// pubblico: la richiesta passa da Render e conta come una visita. Render imposta da solo
// RENDER_EXTERNAL_URL; in locale non fa nulla.
import { config } from './config.js';

const INTERVAL = 10 * 60 * 1000;

export function startKeepAlive() {
  const base = (process.env.RENDER_EXTERNAL_URL || config.publicUrl || '').replace(/\/+$/, '');
  if (!base || /localhost|127\.0\.0\.1/.test(base)) return;
  const ping = () => fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => {});
  setInterval(ping, INTERVAL).unref();
  console.log(`⏰ Il sito resta sveglio: visita automatica di ${base} ogni 10 minuti.`);
}
