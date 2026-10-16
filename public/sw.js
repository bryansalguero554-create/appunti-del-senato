// Service worker della web app: l'app si apre all'istante con i file salvati sul dispositivo e funziona
// anche senza connessione. I dati (/api) non vengono mai messi in cache.
// VERSION e SHELL vengono inseriti dal server: la versione cambia a ogni aggiornamento del sito.
const VERSION = '__VERSION__';
const SHELL = '__SHELL__';
const CACHE = `appunti-${VERSION}`;

self.addEventListener('install', (event) => {
  // tutti i file della nuova versione vengono scaricati insieme, così non si mischiano mai versioni diverse
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('appunti-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromNetwork(request, cache) {
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // l'app (pagina principale): subito dalla copia salvata
    if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const shell = await cache.match('/');
      if (shell) return shell;
      try {
        return await fromNetwork(request, cache);
      } catch {
        return (await cache.match('/offline.html')) || Response.error();
      }
    }
    // altre pagine (privacy, termini…): dalla rete, con la copia salvata se manca la connessione
    if (request.mode === 'navigate') {
      try {
        return await fromNetwork(request, cache);
      } catch {
        return (await cache.match(request)) || (await cache.match('/offline.html')) || Response.error();
      }
    }
    // script, stili, icone: dalla copia salvata di questa versione, altrimenti dalla rete
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      return await fromNetwork(request, cache);
    } catch {
      return Response.error();
    }
  })());
});
