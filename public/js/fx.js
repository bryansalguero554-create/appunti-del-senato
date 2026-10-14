// Effetti 3D: inclinazione delle card che segue il puntatore, parallasse delle scene
// e comparsa "a cascata" degli elementi delle griglie. Rispetta "riduci movimento".

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Inclinazione 3D ----------
let tilted = null;

function resetTilt(el) {
  el.classList.remove('tilting');
  el.style.removeProperty('--rx');
  el.style.removeProperty('--ry');
}

document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || reduceMotion.matches) return;
  const el = e.target.closest?.('.tilt');
  if (tilted && tilted !== el) resetTilt(tilted);
  tilted = el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const max = Number(el.dataset.tilt) || 7;
  el.style.setProperty('--ry', `${((x - 0.5) * max * 2).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${((0.5 - y) * max * 2).toFixed(2)}deg`);
  el.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
  el.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
  el.classList.add('tilting');
}, { passive: true });

document.addEventListener('pointerleave', () => { if (tilted) resetTilt(tilted); tilted = null; });

// ---------- Parallasse delle scene 3D (home, 404) ----------
let frame = 0;
window.addEventListener('pointermove', (e) => {
  if (reduceMotion.matches || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const px = (e.clientX / window.innerWidth - 0.5) * 2;
    const py = (e.clientY / window.innerHeight - 0.5) * 2;
    document.querySelectorAll('[data-parallax]').forEach((el) => {
      el.style.setProperty('--px', px.toFixed(3));
      el.style.setProperty('--py', py.toFixed(3));
    });
  });
}, { passive: true });

// ---------- Comparsa a cascata ----------
const STAGGER = '.grid > *, .subjects-grid > *, .stat-grid > *, .list > *';

function stagger(root) {
  const groups = new Map();
  root.querySelectorAll(STAGGER).forEach((el) => {
    if (el.classList.contains('fx-in')) return;
    const parent = el.parentElement;
    const i = groups.get(parent) ?? 0;
    groups.set(parent, i + 1);
    el.style.setProperty('--i', i);
    el.classList.add('fx-in');
  });
}

/** Animazione d'ingresso della pagina, chiamata dal router a ogni cambio di pagina. */
export function pageEnter(el) {
  el.classList.remove('page-enter');
  void el.offsetWidth; // riavvia l'animazione
  el.classList.add('page-enter');
}

export function initFx(root) {
  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length)) stagger(root);
  }).observe(root, { childList: true, subtree: true });
}
