import {
  state, api, esc, formatBytes, formatDate, fileType, openModal, confirmDialog, toast, toastError,
  setAiContext, renderMarkdown, sanitize, loadScript, spinner, loadPdfJs, closeModal,
} from '../util.js';
import { openAi } from '../ai.js';
import { openQuizGenerator } from '../quizgen.js';

// SheetJS non è più pubblicato su npm: viene caricato dal suo CDN ufficiale solo quando serve.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const AI_READABLE = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'pptx', 'odt', 'odp', 'ods'];

function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const tableHtml = (rows) => `<table>${rows.slice(0, 5000).map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`;

/** Decodifica una pagina HTML rispettando la codifica dichiarata (es. windows-1252), utf-8 altrimenti. */
function decodeHtml(buffer) {
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 4096));
  const declared = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// ---------- Zoom ----------
// Livello 1 = "Adatta": la pagina intera entra in larghezza. I tasti ingrandiscono o riducono rispetto a quello.
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];

const ZMIN = ZOOM_STEPS[0];
const ZMAX = ZOOM_STEPS.at(-1);

/**
 * Barra dello zoom (tasti − / Pagina intera / +) e zoom con due dita o con il trackpad su "surface".
 * Restituisce set(z) per aggiornare lo zoom dall'esterno.
 */
function addZoomBar(el, apply, surface) {
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

// Script aggiunto alle pagine HTML: le rimpicciolisce finché entrano in larghezza, poi applica lo zoom scelto.
// Gestisce anche lo zoom con due dita dentro la pagina e lo comunica al sito per aggiornare la barra.
const HTML_FIT = `<style>html{touch-action:pan-x pan-y}</style><script>(function(){var z=1,f=1,s=null;function fit(){var d=document.documentElement;if(!d)return;d.style.zoom='';
var w=Math.max(d.scrollWidth,document.body?document.body.scrollWidth:0)||innerWidth;f=Math.min(1,innerWidth/w);d.style.zoom=String(f*z)}
function setZ(v,mx,my){v=Math.min(4,Math.max(0.5,v));if(Math.abs(v-1)<0.04)v=1;var k=v/z,x=scrollX+mx,y=scrollY+my;z=v;fit();scrollTo(x*k-mx,y*k-my);parent.postMessage({appuntiZoomChanged:z},'*')}
function dist(t){return Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY)||1}
addEventListener('touchstart',function(e){if(e.touches.length===2){e.preventDefault();s={d:dist(e.touches),z:z}}},{passive:false});
addEventListener('touchmove',function(e){if(!s||e.touches.length!==2)return;e.preventDefault();var t=e.touches;setZ(s.z*dist(t)/s.d,(t[0].clientX+t[1].clientX)/2,(t[0].clientY+t[1].clientY)/2)},{passive:false});
addEventListener('touchend',function(e){if(e.touches.length<2)s=null});
addEventListener('gesturestart',function(e){e.preventDefault()});
addEventListener('wheel',function(e){if(!e.ctrlKey)return;e.preventDefault();setZ(z*Math.exp(-e.deltaY*0.01),e.clientX,e.clientY)},{passive:false});
addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.appuntiZoom){z=e.data.appuntiZoom;fit()}});
document.addEventListener('DOMContentLoaded',fit);addEventListener('load',function(){fit();setTimeout(fit,600);setTimeout(fit,2000)});
addEventListener('resize',fit)})();<\/script>`;

function withFit(html) {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i]) {
    const m = html.match(re);
    if (m) return html.slice(0, m.index + m[0].length) + HTML_FIT + html.slice(m.index + m[0].length);
  }
  return HTML_FIT + html;
}

/** PDF disegnato con pdf.js: si vede la pagina intera, si scorre e si può ingrandire (anche su iPhone/iPad). */
async function renderPdf(el, url) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ url }).promise;
  const scroller = document.createElement('div');
  scroller.className = 'pdf-scroll';
  const pagesEl = document.createElement('div');
  pagesEl.className = 'pdf-pages';
  scroller.append(pagesEl);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const pages = Array.from({ length: doc.numPages }, (_, i) => {
    const div = document.createElement('div');
    div.className = 'pdf-page';
    div.style.aspectRatio = `${first.width} / ${first.height}`;
    pagesEl.append(div);
    return { n: i + 1, div, dirty: true, busy: false, again: false, visible: false };
  });
  el.replaceChildren(scroller);

  let zoom = 1;
  const render = async (p) => {
    if (p.busy) { p.again = true; return; }
    p.busy = true;
    try {
      const page = await doc.getPage(p.n);
      const base = page.getViewport({ scale: 1 });
      p.div.style.aspectRatio = `${base.width} / ${base.height}`;
      // risoluzione adatta allo schermo, con un tetto per non esaurire la memoria del telefono
      let scale = (p.div.clientWidth * Math.min(window.devicePixelRatio || 1, 3)) / base.width;
      scale = Math.min(scale, 4096 / base.width, Math.sqrt(12e6 / (base.width * base.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      p.div.replaceChildren(canvas);
      p.dirty = false;
    } catch {
      // pagina non disegnabile: resta bianca
    } finally {
      p.busy = false;
      if (p.again) { p.again = false; render(p); }
    }
  };
  const renderVisible = () => pages.filter((p) => p.visible && p.dirty).forEach(render);
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const p = pages[Number(entry.target.dataset.i)];
      p.visible = entry.isIntersecting;
      if (!p.visible && p.div.firstChild) { p.div.firstChild.width = 0; p.div.replaceChildren(); p.dirty = true; } // libera memoria
    }
    renderVisible();
  }, { root: scroller, rootMargin: '150% 0px' });
  pages.forEach((p, i) => { p.div.dataset.i = i; io.observe(p.div); });

  let timer;
  const layout = () => {
    const fit = scroller.clientWidth - parseFloat(getComputedStyle(scroller).paddingLeft) * 2;
    const ratioY = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    pagesEl.style.width = `${Math.max(100, Math.round(fit * zoom))}px`;
    scroller.scrollTop = ratioY * scroller.scrollHeight;
    pages.forEach((p) => { p.dirty = true; });
    clearTimeout(timer);
    timer = setTimeout(renderVisible, 200); // nel frattempo il browser ingrandisce le pagine già disegnate
  };
  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    if (scroller.clientWidth !== lastWidth) { lastWidth = scroller.clientWidth; layout(); }
  });
  ro.observe(scroller);
  window.addEventListener('route-change', () => { io.disconnect(); ro.disconnect(); doc.destroy(); }, { once: true });
  addZoomBar(el, (z) => { zoom = z; layout(); }, scroller);
}

function renderImage(el, url, title) {
  const box = document.createElement('div');
  box.className = 'img-scroll';
  const img = document.createElement('img');
  img.src = url;
  img.alt = title;
  box.append(img);
  el.replaceChildren(box);
  addZoomBar(el, (z) => {
    box.classList.toggle('zoomed', z !== 1);
    if (z === 1) { img.style.width = ''; return; }
    // larghezza della "pagina intera" (l'immagine tutta visibile) moltiplicata per lo zoom
    const fit = Math.min(box.clientWidth / img.naturalWidth, (box.clientHeight || window.innerHeight * 0.85) / img.naturalHeight, 1);
    img.style.width = `${Math.round(img.naturalWidth * fit * z)}px`;
  }, box);
}

/** Testo, Word, fogli di calcolo: lo zoom ingrandisce il contenuto, che resta nella larghezza dello schermo. */
function addContentZoom(el) {
  const content = el.querySelector('.doc, pre');
  if (content) addZoomBar(el, (z) => { content.style.zoom = z === 1 ? '' : String(z); }, content);
}

// ---------- Download ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const shareFile = (file, note) => navigator.share({ files: [file], title: note.title });

/** Il file è pronto ma il tocco è "scaduto" durante lo scaricamento: serve un secondo tocco per salvarlo. */
function offerSave(file, note) {
  openModal('File pronto', `<p><strong>${esc(note.original_name)}</strong> è pronto.</p>
    <p class="muted small">Tocca il pulsante e scegli <strong>Salva su File</strong> (o <strong>Salva immagine</strong>).</p>
    <div class="modal-actions"><button class="btn btn-primary" type="button" id="save-file">💾 Salva il file</button></div>`);
  document.getElementById('save-file').addEventListener('click', async () => {
    try {
      await shareFile(file, note);
      closeModal();
    } catch (err) {
      if (err.name !== 'AbortError') toastError(err);
    }
  });
}

/**
 * Scarica il file dell'appunto. Su iPhone/iPad (soprattutto nell'app installata) i link di download non
 * funzionano: il file si scarica dal sito e si apre il foglio di condivisione con "Salva su File".
 * Altrove si avvia un normale download.
 */
async function downloadNote(note, btn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const label = btn.innerHTML;
  btn.innerHTML = '⏳ Preparo il file…';
  try {
    const res = await fetch(`/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}?download=1`);
    if (!res.ok) throw new Error(res.status === 404 ? 'Il file non è più disponibile sul server.' : `Download non riuscito (errore ${res.status}).`);
    const blob = await res.blob();
    const file = new File([blob], note.original_name, { type: blob.type || note.mime || 'application/octet-stream' });
    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await shareFile(file, note);
      } catch (err) {
        if (err.name === 'NotAllowedError') offerSave(file, note);
        else if (err.name !== 'AbortError') throw err;
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = note.original_name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast('Download avviato');
  } catch (err) {
    toastError(err);
  } finally {
    btn.innerHTML = label;
    delete btn.dataset.busy;
  }
}

async function renderViewer(el, note) {
  const url = `/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}`;
  const ext = note.ext;
  const mime = note.mime;
  const noPreview = (msg) => {
    el.innerHTML = `<div class="no-preview"><div class="big">${fileType(ext).icon}</div>
      <p><strong>${esc(note.original_name)}</strong></p>
      <p class="muted">${msg || 'L\'anteprima di questo formato non è disponibile nel browser.'}</p>
      <a class="btn btn-primary" href="${url}?download=1" data-download>⬇️ Scarica il file</a></div>`;
  };

  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    // Le pagine HTML vengono lette e mostrate con srcdoc in un iframe sandbox (origine isolata, niente accesso
    // al sito). Funziona anche su iPhone/iPad, dove l'iframe caricato direttamente può essere bloccato.
    el.innerHTML = spinner();
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return noPreview(res.status === 404
          ? 'Il file non è più disponibile sul server. Se il Drive non era ancora collegato, il riavvio del server gratuito lo ha cancellato: ricaricalo.'
          : `Impossibile aprire la pagina (errore ${res.status}).`);
      }
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals');
      frame.title = note.title;
      frame.srcdoc = withFit(decodeHtml(await res.arrayBuffer()));
      let zoom = 1;
      frame.addEventListener('load', () => frame.contentWindow?.postMessage({ appuntiZoom: zoom }, '*'));
      el.replaceChildren(frame);
      const setZoom = addZoomBar(el, (z) => {
        if (z === zoom) return;
        zoom = z;
        frame.contentWindow?.postMessage({ appuntiZoom: z }, '*');
      });
      // zoom fatto con le dita dentro la pagina: si aggiorna la barra
      const onMessage = (e) => {
        if (e.source !== frame.contentWindow || typeof e.data?.appuntiZoomChanged !== 'number') return;
        zoom = e.data.appuntiZoomChanged;
        setZoom(zoom);
      };
      window.addEventListener('message', onMessage);
      window.addEventListener('route-change', () => window.removeEventListener('message', onMessage), { once: true });
    } catch (err) {
      noPreview(`Impossibile aprire la pagina (${esc(err.message)}).`);
    }
    return;
  }
  if (note.policy === 'sandbox') {
    // SVG / XML caricati dagli utenti: isolati in un iframe sandbox (anche il server applica una CSP sandbox).
    el.innerHTML = `<iframe src="${url}" sandbox="allow-scripts allow-popups allow-forms" title="${esc(note.title)}"></iframe>`;
    return;
  }
  if (mime === 'application/pdf') {
    el.innerHTML = spinner();
    try {
      await renderPdf(el, url);
    } catch {
      // pdf.js non riesce ad aprirlo: si prova con il visualizzatore del browser
      el.innerHTML = `<iframe src="${url}#view=FitH" title="${esc(note.title)}"></iframe>`;
    }
    return;
  }
  if (mime.startsWith('image/')) {
    renderImage(el, url, note.title);
    return;
  }
  if (mime.startsWith('video/')) {
    el.innerHTML = `<video src="${url}" controls preload="metadata"></video>`;
    return;
  }
  if (mime.startsWith('audio/')) {
    el.innerHTML = `<audio src="${url}" controls preload="metadata"></audio>`;
    return;
  }

  el.innerHTML = spinner();
  try {
    if (mime.startsWith('text/') || mime === 'application/json') {
      if (note.size > 5 * 1024 * 1024) return noPreview('File di testo troppo grande per l\'anteprima.');
      const text = await (await fetch(url)).text();
      if (ext === 'md' || ext === 'markdown') el.innerHTML = `<div class="doc prose">${renderMarkdown(text)}</div>`;
      else if (ext === 'csv' || ext === 'tsv') el.innerHTML = `<div class="doc">${tableHtml(parseCsv(text, ext === 'tsv' ? '\t' : (text.split(';').length > text.split(',').length ? ';' : ',')))}</div>`;
      else el.innerHTML = `<pre>${esc(text)}</pre>`;
      addContentZoom(el);
      return;
    }
    if (ext === 'docx') {
      await loadScript('/vendor/mammoth.js');
      const buf = await (await fetch(url)).arrayBuffer();
      const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      el.innerHTML = `<div class="doc prose">${sanitize(value) || '<p class="muted">Documento vuoto.</p>'}</div>`;
      addContentZoom(el);
      return;
    }
    if (['xlsx', 'xls', 'ods'].includes(ext)) {
      await loadScript(SHEETJS_URL);
      const buf = await (await fetch(url)).arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const show = (name) => {
        el.querySelector('.doc').innerHTML = sanitize(window.XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' }));
        el.querySelectorAll('.sheet-tabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.sheet === name));
      };
      el.innerHTML = `${wb.SheetNames.length > 1 ? `<div class="sheet-tabs chips">${wb.SheetNames.map((n) => `<button class="chip" data-sheet="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}<div class="doc"></div>`;
      el.querySelector('.sheet-tabs')?.addEventListener('click', (e) => { const c = e.target.closest('[data-sheet]'); if (c) show(c.dataset.sheet); });
      show(wb.SheetNames[0]);
      addContentZoom(el);
      return;
    }
  } catch (err) {
    return noPreview(`Impossibile mostrare l'anteprima (${esc(err.message)}).`);
  }
  noPreview(AI_READABLE.includes(ext) ? 'Anteprima non disponibile nel browser, ma l\'assistente AI può leggerne il contenuto.' : '');
}

export async function renderNote(app, { params: [id] }) {
  const { note } = await api(`/notes/${id}`);
  setAiContext({
    subjectId: note.subject_id, topicId: note.topic_id, noteId: note.id,
    label: `${note.subject_icon} ${note.subject_name} › ${note.topic_name}`, noteTitle: note.title,
  });
  const type = fileType(note.ext);

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <div class="breadcrumb"><a href="#/">Materie</a> › <a href="#/materia/${note.subject_id}">${esc(note.subject_icon)} ${esc(note.subject_name)}</a> › <a href="#/argomento/${note.topic_id}">📁 ${esc(note.topic_name)}</a> ›</div>
        <h1>${type.icon} ${esc(note.title)}</h1>
        ${note.description ? `<p class="muted">${esc(note.description)}</p>` : ''}
      </div>
    </div>
    <div class="viewer-layout">
      <div class="viewer" id="viewer"></div>
      <aside class="card side-card">
        <div class="meta-row"><span class="muted">Autore</span><strong>${esc(note.author_name || 'utente eliminato')}</strong></div>
        <div class="meta-row"><span class="muted">Formato</span><span>${type.label} (.${esc(note.ext || '?')})</span></div>
        <div class="meta-row"><span class="muted">Dimensione</span><span>${formatBytes(note.size)}</span></div>
        <div class="meta-row"><span class="muted">Caricato</span><span>${formatDate(note.created_at)}</span></div>
        ${note.fromDrive ? '<div class="meta-row"><span class="muted">Origine</span><span>☁️ Google Drive</span></div>' : ''}
        <div class="actions">
          <button class="btn btn-primary" id="fullscreen">⤢ Schermo intero</button>
          <a class="btn" href="/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}" target="_blank" rel="noopener">↗️ Apri in una nuova scheda</a>
          <a class="btn" href="/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}?download=1" data-download>⬇️ Scarica</a>
          ${state.site.aiEnabled ? `<button class="btn" id="ai-explain">🤖 Spiegami questo appunto</button>
          <button class="btn" id="ai-ask">💬 Ho un dubbio</button>
          <button class="btn" id="gen-quiz">✨ Genera quiz da questo appunto</button>` : ''}
          ${note.canManage ? '<button class="btn" id="edit-note">✏️ Modifica</button><button class="btn btn-danger" id="delete-note">🗑️ Elimina</button>' : ''}
        </div>
      </aside>
    </div>`;

  const viewer = app.querySelector('#viewer');
  renderViewer(viewer, note);
  app.querySelector('.viewer-layout').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-download]');
    if (!btn) return;
    e.preventDefault();
    downloadNote(note, btn);
  });

  // "Schermo intero" fatto in CSS: funziona anche su iPhone, dove l'API Fullscreen non esiste per le pagine.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'viewer-close';
  closeBtn.setAttribute('aria-label', 'Esci dallo schermo intero');
  closeBtn.textContent = '✕';
  const exitFull = () => {
    viewer.classList.remove('is-full');
    document.body.classList.remove('no-scroll');
    closeBtn.remove();
    window.removeEventListener('route-change', exitFull);
  };
  closeBtn.addEventListener('click', exitFull);
  app.querySelector('#fullscreen').addEventListener('click', () => {
    viewer.classList.add('is-full');
    document.body.classList.add('no-scroll');
    viewer.append(closeBtn);
    window.addEventListener('route-change', exitFull);
  });

  app.querySelector('#ai-explain')?.addEventListener('click', () => openAi('Spiegami in modo semplice e ordinato i concetti principali di questo appunto, poi fammi un breve riassunto finale.'));
  app.querySelector('#ai-ask')?.addEventListener('click', () => openAi());
  app.querySelector('#gen-quiz')?.addEventListener('click', () => openQuizGenerator({ noteId: note.id, noteTitle: note.title }));
  app.querySelector('#edit-note')?.addEventListener('click', () => {
    openModal('Modifica appunto', `
      <form>
        <div class="field"><label>Titolo</label><input name="title" required maxlength="150" value="${esc(note.title)}"></div>
        <div class="field"><label>Descrizione</label><textarea name="description" rows="3" maxlength="1000">${esc(note.description)}</textarea></div>
        <div class="modal-actions"><button class="btn btn-primary" type="submit">Salva</button></div>
      </form>`, async (fd) => {
      await api(`/notes/${note.id}`, { method: 'PATCH', body: Object.fromEntries(fd) });
      toast('Appunto aggiornato');
      renderNote(app, { params: [id] });
    });
  });
  app.querySelector('#delete-note')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Eliminare definitivamente "${note.title}"?`, { confirmLabel: 'Elimina' }))) return;
    try {
      await api(`/notes/${note.id}`, { method: 'DELETE' });
      toast('Appunto eliminato');
      location.hash = `#/argomento/${note.topic_id}`;
    } catch (err) {
      toastError(err);
    }
  });
}
