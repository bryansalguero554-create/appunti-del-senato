// Mappa concettuale per l'interrogazione: disegno, zoom, modifica (a mano o con l'IA) e download come immagine.
import { api, esc, openModal, closeModal, confirmDialog, toast, toastError, setAiContext, saveBlob, state } from '../util.js';
import { addZoomBar } from '../zoom.js';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';
const PALETTE = ['#0a84ff', '#ff375f', '#28b84c', '#ff9500', '#af52de', '#0fa5c9', '#ff6b3d', '#5e5ce6'];
const PAPER = '#fbfbfd';

// stile dei concetti per livello: 0 = centrale, 1 = rami principali, 2+ = dettagli
const LEVELS = [
  { size: 20, weight: 700, max: 250, padX: 20, padY: 14, radius: 18, detail: 13.5 },
  { size: 16, weight: 650, max: 210, padX: 15, padY: 11, radius: 14, detail: 12.5 },
  { size: 14, weight: 550, max: 190, padX: 12, padY: 9, radius: 11, detail: 12 },
];
const level = (depth) => LEVELS[Math.min(depth, 2)];
const H_GAP = [76, 46, 40];
const V_GAP = 14;

const measureCtx = document.createElement('canvas').getContext('2d');

/** Spezza il testo in righe larghe al massimo maxW (le parole troppo lunghe vengono divise). */
function wrap(text, font, maxW) {
  measureCtx.font = font;
  const width = (t) => measureCtx.measureText(t).width;
  const lines = [];
  let line = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (width(word) > maxW && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && width(word.slice(0, cut)) > maxW) cut -= 1;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const test = line ? `${line} ${word}` : word;
    if (!line || width(test) <= maxW) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.map((t) => ({ t, w: width(t) }));
}

/** Calcola posizione e dimensioni di ogni concetto (mappa mentale: centro, rami a destra e a sinistra). */
function layout(map, showDetails) {
  const byId = new Map(map.nodes.map((n) => [n.id, { ...n, children: [] }]));
  let root = null;
  for (const n of byId.values()) {
    if (n.parent && byId.has(n.parent)) byId.get(n.parent).children.push(n);
    else if (!root) root = n;
  }
  const setup = (n, depth, color) => {
    const L = level(depth);
    n.depth = depth;
    n.color = color;
    n.labelFont = `${L.weight} ${L.size}px ${FONT}`;
    n.detailFont = `400 ${L.detail}px ${FONT}`;
    n.lines = wrap(n.label, n.labelFont, L.max);
    n.dlines = showDetails && n.detail ? wrap(n.detail, n.detailFont, L.max) : [];
    n.lh = L.size * 1.25;
    n.dlh = L.detail * 1.35;
    const textW = Math.max(...n.lines.map((l) => l.w), ...n.dlines.map((l) => l.w), 20);
    n.w = Math.ceil(textW + L.padX * 2);
    n.h = Math.ceil(n.lines.length * n.lh + (n.dlines.length ? 6 + n.dlines.length * n.dlh : 0) + L.padY * 2);
    n.children.forEach((c, i) => setup(c, depth + 1, depth === 0 ? PALETTE[i % PALETTE.length] : color));
  };
  setup(root, 0, '#5e5ce6');

  const gap = (n) => (n.depth === 0 ? V_GAP + 12 : V_GAP);
  const sh = (n) => {
    if (n.sh) return n.sh;
    const kids = n.children.reduce((s, c) => s + sh(c), 0) + Math.max(0, n.children.length - 1) * gap(n);
    n.sh = Math.max(n.h, kids);
    return n.sh;
  };
  const place = (n, side, edge, cy) => {
    n.side = side;
    n.x = side === 'right' ? edge : edge - n.w;
    n.y = cy;
    const total = n.children.reduce((s, c) => s + sh(c), 0) + Math.max(0, n.children.length - 1) * gap(n);
    let y = cy - total / 2;
    const hg = H_GAP[Math.min(n.depth + 1, 2)];
    for (const c of n.children) {
      place(c, side, side === 'right' ? n.x + n.w + hg : n.x - hg, y + sh(c) / 2);
      y += sh(c) + gap(n);
    }
  };

  // i rami principali si dividono tra destra e sinistra in base all'altezza, mantenendo l'ordine
  const branches = root.children;
  const totalH = branches.reduce((s, c) => s + sh(c), 0);
  const right = [];
  const left = [];
  let acc = 0;
  for (const b of branches) {
    if (acc < totalH / 2 || !right.length) { right.push(b); acc += sh(b); } else left.push(b);
  }
  root.x = -root.w / 2;
  root.y = 0;
  root.side = 'center';
  for (const [group, side] of [[right, 'right'], [left, 'left']]) {
    const total = group.reduce((s, c) => s + sh(c), 0) + Math.max(0, group.length - 1) * gap(root);
    let y = -total / 2;
    for (const b of group) {
      place(b, side, side === 'right' ? root.x + root.w + H_GAP[0] : root.x - H_GAP[0], y + sh(b) / 2);
      y += sh(b) + gap(root);
    }
  }

  const all = [...byId.values()].filter((n) => n.x !== undefined);
  const M = 36;
  const minX = Math.min(...all.map((n) => n.x)) - M;
  const maxX = Math.max(...all.map((n) => n.x + n.w)) + M;
  const minY = Math.min(...all.map((n) => n.y - n.h / 2)) - M;
  const maxY = Math.max(...all.map((n) => n.y + n.h / 2)) + M;
  for (const n of all) { n.x -= minX; n.y -= minY; }
  return { nodes: all, root, width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * (1 - amount));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** SVG completo della mappa (usato sia a schermo sia per l'immagine da scaricare). */
function toSvg(lay, { header = '' } = {}) {
  const top = header ? 64 : 0;
  const W = lay.width;
  const H = lay.height + top;
  const edges = [];
  const boxes = [];
  for (const n of lay.nodes) {
    for (const c of n.children) {
      if (c.x === undefined) continue;
      const fromRight = c.side === 'right';
      const x1 = fromRight ? n.x + n.w : n.x;
      const x2 = fromRight ? c.x : c.x + c.w;
      const xm = (x1 + x2) / 2;
      edges.push(`<path d="M${x1} ${n.y + top} C${xm} ${n.y + top} ${xm} ${c.y + top} ${x2} ${c.y + top}" stroke="${c.color}" stroke-width="${c.depth === 1 ? 3 : 2}" stroke-opacity=".7" fill="none" stroke-linecap="round"/>`);
    }
    const L = level(n.depth);
    const fill = n.depth === 0 ? 'url(#mg-root)' : n.depth === 1 ? n.color : tint(n.color, 0.12);
    const stroke = n.depth >= 2 ? `stroke="${n.color}" stroke-opacity=".55" stroke-width="1.5"` : '';
    const textColor = n.depth <= 1 ? '#ffffff' : '#1d1d1f';
    const detailColor = n.depth <= 1 ? 'rgba(255,255,255,.88)' : '#515154';
    let y = L.padY;
    const tspans = n.lines.map((l) => {
      y += n.lh;
      return `<text x="${n.w / 2}" y="${(y - n.lh * 0.27).toFixed(1)}" text-anchor="middle" font-size="${L.size}" font-weight="${L.weight}" fill="${textColor}">${xml(l.t)}</text>`;
    });
    if (n.dlines.length) y += 6;
    const dspans = n.dlines.map((l) => {
      y += n.dlh;
      return `<text x="${n.w / 2}" y="${(y - n.dlh * 0.3).toFixed(1)}" text-anchor="middle" font-size="${L.detail}" fill="${detailColor}">${xml(l.t)}</text>`;
    });
    boxes.push(`<g class="mnode" data-id="${xml(n.id)}" transform="translate(${n.x.toFixed(1)} ${(n.y - n.h / 2 + top).toFixed(1)})">
      <rect width="${n.w}" height="${n.h}" rx="${L.radius}" fill="${fill}" ${stroke} filter="url(#mg-shadow)"/>${tspans.join('')}${dspans.join('')}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>
  <defs>
    <linearGradient id="mg-root" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5e5ce6"/><stop offset="1" stop-color="#bf5af2"/></linearGradient>
    <filter id="mg-shadow" x="-20%" y="-30%" width="140%" height="170%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity=".12"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  ${header ? `<text x="36" y="44" font-size="24" font-weight="700" fill="#1d1d1f">${xml(header)}</text>` : ''}
  <g>${edges.join('')}</g>
  <g>${boxes.join('')}</g>
</svg>`;
}

/** Immagine PNG della mappa, nitida ma entro i limiti di memoria di iPhone/iPad. */
async function toPng(svg, w, h) {
  const scale = Math.min(3, Math.sqrt(16e6 / (w * h)), 8192 / Math.max(w, h));
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode().catch(() => { throw new Error('Impossibile creare l\'immagine della mappa.'); });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Immagine troppo grande.'))), 'image/png'));
}

const fileName = (title) => `${(title || 'mappa').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'mappa'}.png`;

const SUGGESTIONS = ['Aggiungi date ed esempi', 'Semplifica: solo le parole chiave', 'Aggiungi cause e conseguenze', 'Collegala ad altre materie'];

export async function renderMap(app, { params: [id] }) {
  let { map } = await api(`/maps/${id}`);
  setAiContext({ noteId: map.note_id || null, label: `🗺️ ${map.title}`, noteTitle: map.note_title || '' });
  let showDetails = true;
  try { showDetails = localStorage.getItem('map-details') !== '0'; } catch { /* modalità privata */ }
  let undo = null; // versione precedente, dopo una modifica fatta dall'IA

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <div class="breadcrumb">${map.note_id ? `<a href="#/appunto/${map.note_id}">‹ ${esc(map.note_title || 'Torna all\'appunto')}</a>` : '<a href="#/profilo">‹ Le mie mappe</a>'}</div>
        <h1 id="map-title">🗺️ ${esc(map.title)}</h1>
      </div>
    </div>
    <div class="map-layout">
      <div class="card map-card" id="map-card">
        <div class="map-scroll" id="map-scroll"></div>
        <div class="map-busy" id="map-busy" hidden><div class="qg-orb"></div><p>L'IA sta modificando la mappa…</p></div>
      </div>
      <aside class="map-side">
        <div class="card map-tools">
          <button class="btn btn-primary" id="map-download">⬇️ Scarica immagine</button>
          <label class="switch-row"><input type="checkbox" id="map-details" ${showDetails ? 'checked' : ''}><span>Mostra i dettagli</span></label>
          <p class="muted small">Tocca un concetto per modificarlo, aggiungere un ramo o eliminarlo.</p>
          <div class="note-manage">
            <button type="button" class="link-btn" id="map-rename">✏️ Rinomina</button>
            <button type="button" class="link-btn danger" id="map-delete">🗑️ Elimina</button>
          </div>
        </div>
        ${state.site.aiEnabled ? `<form class="card map-ai" id="map-ai">
          <div class="map-ai-head"><img src="/icons/ai-64.png" alt="" aria-hidden="true"><strong>Modifica con l'IA</strong></div>
          <textarea name="instruction" rows="2" maxlength="1000" placeholder="Es. aggiungi le date principali, togli il ramo sulle conseguenze…" required></textarea>
          <div class="map-ai-chips">${SUGGESTIONS.map((s) => `<button type="button" class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          <div class="map-ai-actions">
            <button type="button" class="btn" id="map-undo" hidden>↶ Annulla modifica</button>
            <button type="submit" class="btn btn-primary">✨ Modifica</button>
          </div>
        </form>` : ''}
      </aside>
    </div>`;

  const scroller = app.querySelector('#map-scroll');
  let lay;
  let zoom = 1;
  const applySize = () => {
    const svg = scroller.querySelector('svg');
    if (!svg || !lay) return;
    const avail = scroller.clientWidth - 16;
    const fit = Math.min(1, avail / lay.width);
    svg.style.width = `${Math.round(lay.width * fit * zoom)}px`;
    svg.style.height = 'auto';
  };
  const draw = () => {
    lay = layout(map, showDetails);
    scroller.innerHTML = toSvg(lay);
    applySize();
  };
  draw();
  addZoomBar(app.querySelector('#map-card'), (z) => { zoom = z; applySize(); }, scroller);
  const ro = new ResizeObserver(applySize);
  ro.observe(scroller);
  window.addEventListener('route-change', () => ro.disconnect(), { once: true });

  const save = async (next) => {
    const res = await api(`/maps/${map.id}`, { method: 'PUT', body: { title: next.title, nodes: next.nodes } });
    map = res.map;
    app.querySelector('#map-title').textContent = `🗺️ ${map.title}`;
    draw();
  };

  // ---- modifica a mano: tocco su un concetto ----
  scroller.addEventListener('click', (e) => {
    const g = e.target.closest('.mnode');
    if (!g) return;
    const node = map.nodes.find((n) => n.id === g.dataset.id);
    if (!node) return;
    const isRoot = !node.parent;
    const body = openModal(isRoot ? 'Concetto centrale' : 'Modifica concetto', `
      <form id="node-form">
        <div class="field"><label>Concetto</label><input name="label" maxlength="90" required value="${esc(node.label)}"></div>
        <div class="field"><label>Dettaglio <span class="muted">(facoltativo)</span></label>
          <textarea name="detail" rows="2" maxlength="220" placeholder="Date, nomi, definizioni da dire all'interrogazione">${esc(node.detail || '')}</textarea></div>
        <div class="modal-actions node-actions">
          ${isRoot ? '' : '<button type="button" class="btn btn-danger" id="node-del">🗑️ Elimina</button>'}
          <button type="button" class="btn" id="node-add">➕ Sotto-concetto</button>
          <button type="submit" class="btn btn-primary">Salva</button>
        </div>
      </form>`);
    const form = body.querySelector('#node-form');
    const values = () => ({ label: form.label.value.trim(), detail: form.detail.value.trim() });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await save({ title: map.title, nodes: map.nodes.map((n) => (n.id === node.id ? { ...n, ...values() } : n)) });
        closeModal();
      } catch (err) { toastError(err); }
    });
    body.querySelector('#node-add').addEventListener('click', async () => {
      const childId = `new${Date.now()}`;
      try {
        const nodes = map.nodes.map((n) => (n.id === node.id ? { ...n, ...values() } : n));
        await save({ title: map.title, nodes: [...nodes, { id: childId, parent: node.id, label: 'Nuovo concetto', detail: '' }] });
        closeModal();
        toast('Concetto aggiunto: toccalo per scriverlo');
      } catch (err) { toastError(err); }
    });
    body.querySelector('#node-del')?.addEventListener('click', async () => {
      // elimina il concetto e tutto il suo ramo
      const drop = new Set([node.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of map.nodes) if (!drop.has(n.id) && drop.has(n.parent)) { drop.add(n.id); grew = true; }
      }
      if (map.nodes.length - drop.size < 2) return toast('La mappa deve avere almeno due concetti.', 'error');
      try {
        await save({ title: map.title, nodes: map.nodes.filter((n) => !drop.has(n.id)) });
        closeModal();
      } catch (err) { toastError(err); }
    });
  });

  app.querySelector('#map-details').addEventListener('change', (e) => {
    showDetails = e.target.checked;
    try { localStorage.setItem('map-details', showDetails ? '1' : '0'); } catch { /* */ }
    draw();
  });

  app.querySelector('#map-download').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '⏳ Preparo l\'immagine…';
    try {
      const full = layout(map, showDetails);
      const svg = toSvg(full, { header: map.title });
      const blob = await toPng(svg, full.width, full.height + 64);
      await saveBlob(blob, fileName(map.title), map.title, 'image/png');
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  app.querySelector('#map-rename').addEventListener('click', () => {
    openModal('Rinomina la mappa', `<form><div class="field"><label>Titolo</label><input name="title" maxlength="150" required value="${esc(map.title)}"></div>
      <div class="modal-actions"><button class="btn btn-primary" type="submit">Salva</button></div></form>`, async (fd) => {
      await save({ title: String(fd.get('title')).trim(), nodes: map.nodes });
    });
  });

  app.querySelector('#map-delete').addEventListener('click', async () => {
    if (!(await confirmDialog(`Eliminare la mappa "${map.title}"?`, { confirmLabel: 'Elimina' }))) return;
    try {
      await api(`/maps/${map.id}`, { method: 'DELETE' });
      toast('Mappa eliminata');
      location.hash = map.note_id ? `#/appunto/${map.note_id}` : '#/profilo';
    } catch (err) { toastError(err); }
  });

  // ---- modifica con l'IA ----
  const aiForm = app.querySelector('#map-ai');
  if (aiForm) {
    const busy = app.querySelector('#map-busy');
    const undoBtn = app.querySelector('#map-undo');
    aiForm.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-suggest]');
      if (chip) { aiForm.instruction.value = chip.dataset.suggest; aiForm.instruction.focus(); }
    });
    aiForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const instruction = aiForm.instruction.value.trim();
      if (!instruction) return;
      const submit = aiForm.querySelector('[type="submit"]');
      submit.disabled = true;
      busy.hidden = false;
      try {
        const before = { title: map.title, nodes: map.nodes };
        const res = await api(`/ai/map/${map.id}/edit`, { method: 'POST', body: { instruction } });
        map = res.map;
        undo = before;
        undoBtn.hidden = false;
        aiForm.instruction.value = '';
        app.querySelector('#map-title').textContent = `🗺️ ${map.title}`;
        draw();
        toast('Mappa aggiornata ✨');
      } catch (err) {
        toastError(err);
      } finally {
        submit.disabled = false;
        busy.hidden = true;
      }
    });
    undoBtn.addEventListener('click', async () => {
      if (!undo) return;
      try {
        await save(undo);
        undo = null;
        undoBtn.hidden = true;
        toast('Modifica annullata');
      } catch (err) { toastError(err); }
    });
  }
}
