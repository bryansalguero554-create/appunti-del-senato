// Zoom degli appunti e delle mappe: tasti (− / Pagina intera / +), due dita e trackpad.
// Livello 1 = "Adatta": la pagina intera entra in larghezza. I tasti ingrandiscono o riducono rispetto a quello.
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];

const ZMIN = ZOOM_STEPS[0];
const ZMAX = ZOOM_STEPS.at(-1);

/**
 * Barra dello zoom (tasti − / Pagina intera / +) e zoom con due dita o con il trackpad su "surface".
 * Restituisce set(z) per aggiornare lo zoom dall'esterno.
 */
export function addZoomBar(el, apply, surface) {
  let z = 1;
  const bar = document.createElement('div');
  bar.className = 'zoom-bar';
  bar.innerHTML = `<button type="button" data-z="out" aria-label="Riduci">−</button>
    <button type="button" data-z="fit" class="zoom-level" title="Torna alla pagina intera">Pagina intera</button>
    <button type="button" data-z="in" aria-label="Ingrandisci">+</button>`;
  const label = bar.querySelector('.zoom-level');
  const set = (v, anchor) => {
    v = Math.min(ZMAX, Math.max(ZMIN, v));
    if (Math.abs(v - 1) < 0.04) v = 1; // vicino alla pagina intera: si aggancia
    // il punto sotto le dita resta fermo mentre si ingrandisce
    let keep;
    if (surface && anchor) {
      const r = surface.getBoundingClientRect();
      const ax = anchor.x - r.left;
      const ay = anchor.y - r.top;
      keep = { ax, ay, rx: (surface.scrollLeft + ax) / surface.scrollWidth, ry: (surface.scrollTop + ay) / surface.scrollHeight };
    }
    z = v;
    label.textContent = z === 1 ? 'Pagina intera' : `${Math.round(z * 100)}%`;
    bar.querySelector('[data-z="out"]').disabled = z <= ZOOM_STEPS[0];
    bar.querySelector('[data-z="in"]').disabled = z >= ZOOM_STEPS.at(-1);
    apply(z);
    if (keep) {
      surface.scrollLeft = keep.rx * surface.scrollWidth - keep.ax;
      surface.scrollTop = keep.ry * surface.scrollHeight - keep.ay;
    }
  };
  bar.addEventListener('click', (e) => {
    const k = e.target.closest('[data-z]')?.dataset.z;
    if (k === 'fit') set(1);
    else if (k === 'in') set(ZOOM_STEPS.find((v) => v > z + 1e-3) ?? z);
    else if (k === 'out') set([...ZOOM_STEPS].reverse().find((v) => v < z - 1e-3) ?? z);
  });
  el.prepend(bar);
  if (surface) enablePinch(surface, () => z, set);
  return set;
}

function enablePinch(surface, get, set) {
  let start = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  surface.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault(); // il secondo dito: il gesto diventa uno zoom, non uno scorrimento
    start = { d: dist(e.touches) || 1, z: get() };
  }, { passive: false });
  surface.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 2) return;
    e.preventDefault(); // ingrandisce l'appunto, non tutta la pagina
    set(start.z * (dist(e.touches) / start.d), mid(e.touches));
  }, { passive: false });
  surface.addEventListener('touchend', (e) => { if (e.touches.length < 2) start = null; });
  surface.addEventListener('touchcancel', () => { start = null; });
  surface.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari
  // trackpad del computer (pizzico = rotella con Ctrl)
  surface.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    set(get() * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  }, { passive: false });
}
