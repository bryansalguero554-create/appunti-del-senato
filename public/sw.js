// Service worker della web app: rende il sito installabile e mostra l'ultima versione
// salvata quando manca la connessione. I dati (/api) non vengono mai messi in cache.
const CACHE = 'appunti-v6';
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/offline.html',
  '/js/app.js', '/js/util.js', '/js/ai.js', '/js/fx.js', '/js/quizgen.js', '/js/install.js',
  '/js/pages/auth.js', '/js/pages/home.js', '/js/pages/subject.js', '/js/pages/topic.js', '/js/pages/note.js',
  '/js/pages/quiz.js', '/js/pages/profile.js', '/js/pages/admin.js', '/js/pages/notfound.js',
  '/vendor/marked.js', '/vendor/purify.js', '/icons/icon-192.png', '/icons/icon-64.png', '/icons/icon-dark-64.png', '/icons/icon-dark-192.png', '/icons/favicon.svg', '/icons/apple-touch-icon.png', '/icons/ai-64.png', '/icons/ai-256.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Prima la rete (così si vede sempre l'ultima versione del sito), poi la copia salvata.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        if (request.mode === 'navigate') return (await caches.match('/')) || caches.match('/offline.html');
        return Response.error();
      }),
  );
});
