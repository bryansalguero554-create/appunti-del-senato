// Punto di avvio. Se il sito usa Google Drive come cloud principale e il database locale
// non esiste (es. server gratuito appena riavviato), lo ripristina dal Drive prima di partire.
import { restoreDatabase } from './src/restore.js';

await restoreDatabase();
await import('./src/main.js');
