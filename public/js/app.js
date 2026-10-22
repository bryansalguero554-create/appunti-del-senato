import { state, $, $$, api, esc, toast, toastError, closeModal, spinner, setAiContext, cap, clearApiCache } from './util.js';
import { renderAuth } from './pages/auth.js';
import { renderHome } from './pages/home.js';
import { renderSubject } from './pages/subject.js';
import { renderTopic } from './pages/topic.js';
import { renderNote } from './pages/note.js';
import { renderMap } from './pages/map.js';
import { renderQuizList, renderQuizTake, renderQuizEditor } from './pages/quiz.js';
import { renderProfile } from './pages/profile.js';
import { renderAdmin } from './pages/admin.js';
import { initAi } from './ai.js';
import { renderNotFound } from './pages/notfound.js';
import { initFx, pageEnter } from './fx.js';
import { initInstall, maybeShowInstallBanner } from './install.js';

const routes = [
  [/^\/?$/, renderHome, 'home'],
  [/^\/materia\/(\d+)$/, renderSubject, 'home'],
  [/^\/argomento\/(\d+)$/, renderTopic, 'home'],
  [/^\/appunto\/(\d+)$/, renderNote, 'home'],
  [/^\/mappa\/(\d+)$/, renderMap, 'home'],
  [/^\/quiz$/, renderQuizList, 'quiz'],
  [/^\/quiz\/nuovo$/, renderQuizEditor, 'quiz'],
  [/^\/quiz\/(\d+)\/modifica$/, renderQuizEditor, 'quiz'],
  [/^\/quiz\/(\d+)$/, renderQuizTake, 'quiz'],
  [/^\/profilo$/, renderProfile, 'profilo'],
  [/^\/admin$/, renderAdmin, 'admin'],
];

let renderToken = 0;

function currentPath() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  return { path, query: new URLSearchParams(query) };
}

async function router() {
  const token = ++renderToken;
  const { path, query } = currentPath();
  const app = $('#app');
  closeModal();
  $('#nav').classList.remove('open');
  window.dispatchEvent(new Event('route-change'));

  if (!state.user) {
    showChrome(false);
    renderAuth(app, path === '/registrati' ? 'register' : 'login', onAuthenticated);
    sendPresence();
    return;
  }
  if (path === '/accedi' || path === '/registrati') {
    location.hash = '#/';
    return;
  }
  showChrome(true);
  app.className = 'container';
  setAiContext(null);
  const match = routes.find(([re]) => re.test(path));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === match?.[2]));
  window.scrollTo(0, 0);
  if (!match) {
    renderNotFound(app);
    pageEnter(app);
    sendPresence();
    return;
  }
  app.innerHTML = spinner();
  try {
    const params = path.match(match[0]).slice(1);
    await match[1](app, { params, query, isStale: () => token !== renderToken });
  } catch (err) {
    if (token !== renderToken) return;
    if (err.status === 401) return;
    if (err.status === 404) renderNotFound(app);
    else app.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(err.message)}</p><a class="btn" href="#/">Torna alla home</a></div>`;
  }
  if (token === renderToken) pageEnter(app);
  sendPresence();
  setTimeout(maybeShowInstallBanner, 2500);
}

function showChrome(visible) {
  $('#topbar').hidden = !visible;
  $('#ai-fab').hidden = !visible || !state.site.aiEnabled;
  $('#nav-admin').hidden = state.user?.role !== 'owner';
  $('#site-name').textContent = state.site.name || 'Appunti';
  document.title = state.site.name || 'Appunti';
  const ann = $('#announcement');
  ann.hidden = !visible || !state.site.announcement;
  ann.textContent = state.site.announcement || '';
}

async function loadMe() {
  const data = await api('/auth/me');
  state.user = data.user;
  state.site = data.site;
}

function onAuthenticated(user) {
  state.user = user;
  loadMe().finally(() => {
    if (location.hash === '' || location.hash === '#/' || /accedi|registrati/.test(location.hash)) {
      location.hash = '#/';
      router();
    } else router();
  });
}

// ---------- Presenza in tempo reale ----------
const visitorId = (() => {
  try {
    let id = sessionStorage.getItem('visitorId');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
      sessionStorage.setItem('visitorId', id);
    }
    return id;
  } catch {
    return String(Math.random()).slice(2);
  }
})();

async function sendPresence() {
  if (document.visibilityState === 'hidden') return;
  try {
    const res = await api('/presence', {
      method: 'POST',
      body: { visitorId, path: location.hash || '#/', title: document.querySelector('#app h1')?.textContent || document.title },
    });
    if (res.sessionLost && state.user) {
      state.user = null;
      toast('La tua sessione è stata chiusa.', 'error');
      router();
    }
  } catch {
    // rete assente: si riprova al prossimo giro
  }
}
setInterval(sendPresence, 20_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendPresence();
});
window.addEventListener('pagehide', () => {
  navigator.sendBeacon?.('/api/presence', new Blob([JSON.stringify({ visitorId, leaving: true })], { type: 'application/json' }));
});

// ---------- Ricerca ----------
let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#search-results');
  if (q.length < 2) {
    box.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const r = await api(`/search?q=${encodeURIComponent(q)}`);
      const parts = [];
      if (r.subjects.length) parts.push('<div class="group">Materie</div>', ...r.subjects.map((s) => `<a href="#/materia/${s.id}">${esc(s.icon)} ${esc(cap(s.name))}</a>`));
      if (r.topics.length) parts.push('<div class="group">Argomenti</div>', ...r.topics.map((t) => `<a href="#/argomento/${t.id}">📁 ${esc(t.name)} <span class="muted small">· ${esc(t.subject_name)}</span></a>`));
      if (r.notes.length) parts.push('<div class="group">Appunti</div>', ...r.notes.map((n) => `<a href="#/appunto/${n.id}">📄 ${esc(n.title)} <span class="muted small">· ${esc(n.subject_name)} › ${esc(n.topic_name)}</span></a>`));
      box.innerHTML = parts.join('') || '<div class="muted small" style="padding:10px">Nessun risultato</div>';
      box.hidden = false;
    } catch (err) {
      toastError(err);
    }
  }, 250);
});
$('#search-form').addEventListener('submit', (e) => e.preventDefault());
document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-form')) $('#search-results').hidden = true;
  if (e.target.closest('#search-results a')) {
    $('#search-results').hidden = true;
    $('#search-input').value = '';
  }
});

// ---------- Varie ----------
$('#menu-toggle').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch { /* già disconnesso */ }
  clearApiCache();
  state.user = null;
  location.hash = '#/accedi';
  router();
});
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('session-lost', () => {
  clearApiCache();
  toast('Sessione scaduta: accedi di nuovo.', 'error');
  router();
});
window.addEventListener('hashchange', router);

// Schermata di caricamento (in index.html): resta visibile finché l'app è pronta e, se il server
// risponde in ritardo (per esempio perché si stava riaccendendo), spiega cosa succede.
function showWaking(level) {
  const msg = $('#splash-msg');
  if (!msg) return;
  msg.textContent = !navigator.onLine
    ? 'Sei offline: l\'app riparte da sola appena torna la connessione.'
    : level === 2 ? 'Il server non risponde. Controlla la connessione e riprova.'
      : level === 1 ? 'Il server si sta riaccendendo: può volerci fino a un minuto, solo questa volta.'
        : 'Un attimo…';
  if (level === 2 && !$('#splash .splash-retry')) {
    $('#splash-bar')?.remove();
    msg.insertAdjacentHTML('afterend', '<button class="splash-retry" type="button" onclick="location.reload()">Riprova</button>');
  }
}

const SPLASH_MS = 2000;

function hideSplash() {
  const splash = $('#splash');
  if (!splash || splash.classList.contains('hide')) return;
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 500);
}

async function loadMeWithRetry() {
  const started = Date.now();
  const timers = [setTimeout(() => showWaking(0), 2600), setTimeout(() => showWaking(1), 6000)];
  try {
    for (;;) {
      try {
        await loadMe();
        return;
      } catch (err) {
        // risposta del server (es. non autorizzato): si prosegue come utente non collegato
        if (err.status && err.status < 500) { state.user = null; return; }
        // server che si sta riaccendendo o rete assente: si riprova per un paio di minuti
        if (Date.now() - started > 120_000) {
          timers.forEach(clearTimeout);
          showWaking(2);
          await new Promise(() => {}); // si aspetta il tocco su "Riprova"
        }
        await new Promise((r) => {
          const t = setTimeout(r, 2500);
          window.addEventListener('online', () => { clearTimeout(t); r(); }, { once: true });
        });
      }
    }
  } finally {
    timers.forEach(clearTimeout);
  }
}

(async function boot() {
  await loadMeWithRetry();
  initAi();
  initFx($('#app'));
  initInstall();
  // la schermata di caricamento resta circa 2 secondi dall'apertura; se la prima pagina non è ancora
  // pronta (server che si riaccende e niente di salvato sul dispositivo) resta finché lo è
  const minShow = new Promise((r) => { setTimeout(r, Math.max(0, SPLASH_MS - performance.now())); });
  await Promise.all([minShow, Promise.race([router(), new Promise((r) => { setTimeout(r, 90_000); })]).catch(() => {})]);
  hideSplash();
}());

export { router };
