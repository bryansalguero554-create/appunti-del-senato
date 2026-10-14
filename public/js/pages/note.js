import {
  state, api, esc, formatBytes, formatDate, fileType, openModal, confirmDialog, toast, toastError,
  setAiContext, renderMarkdown, sanitize, loadScript, spinner, loadPdfJs, saveBlob,
} from '../util.js';
import { openAi } from '../ai.js';
import { addZoomBar } from '../zoom.js';
import { openQuizGenerator } from '../quizgen.js';
import { openMapGenerator } from '../mapgen.js';

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

/** Scarica il file dell'appunto (su iPhone/iPad con il foglio di condivisione, vedi saveBlob). */
async function downloadNote(note, btn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const label = btn.innerHTML;
  btn.innerHTML = '⏳ Preparo il file…';
  try {
    const res = await fetch(`/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}?download=1`);
    if (!res.ok) throw new Error(res.status === 404 ? 'Il file non è più disponibile sul server.' : `Download non riuscito (errore ${res.status}).`);
    await saveBlob(await res.blob(), note.original_name, note.title, note.mime);
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
        <div class="note-meta">
          <div><span>Autore</span><strong>${esc(note.author_name || 'utente eliminato')}</strong></div>
          <div><span>Formato</span><strong>${type.label} · ${formatBytes(note.size)}</strong></div>
          <div><span>Caricato</span><strong>${formatDate(note.created_at)}</strong></div>
          ${note.fromDrive ? '<div><span>Origine</span><strong>☁️ Google Drive</strong></div>' : ''}
        </div>
        <div class="note-actions">
          <button class="btn btn-primary" id="fullscreen">⤢ Schermo intero</button>
          <a class="btn" href="/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}?download=1" data-download>⬇️ Scarica</a>
        </div>
        ${state.site.aiEnabled ? `
        <details class="ai-help">
          <summary><img src="/icons/ai-64.png" alt="" aria-hidden="true"><span>Aiuto con l'IA</span><span class="chev" aria-hidden="true">›</span></summary>
          <div class="ai-help-list">
            <button type="button" id="gen-map"><span class="ico">🗺️</span><span><strong>Crea mappa per l'interrogazione</strong><small>Mappa concettuale modificabile e scaricabile</small></span></button>
            <button type="button" id="ai-explain"><span class="ico">🤖</span><span><strong>Spiegami questo appunto</strong><small>I concetti principali, in modo semplice</small></span></button>
            <button type="button" id="ai-ask"><span class="ico">💬</span><span><strong>Ho un dubbio</strong><small>Chiedi all'assistente</small></span></button>
            <button type="button" id="gen-quiz"><span class="ico">✨</span><span><strong>Genera un quiz</strong><small>Mettiti alla prova su questo appunto</small></span></button>
          </div>
        </details>` : ''}
        <div class="note-maps" id="note-maps" hidden></div>
        ${note.canManage ? `<div class="note-manage">
          <button type="button" class="link-btn" id="edit-note">✏️ Modifica</button>
          <button type="button" class="link-btn danger" id="delete-note">🗑️ Elimina</button>
        </div>` : ''}
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
  // La barra con la ✕ sta fuori dal riquadro dell'appunto (che viene ridisegnato mentre il file si carica),
  // così resta sempre visibile sopra a tutto.
  const fullBar = document.createElement('div');
  fullBar.className = 'full-bar';
  fullBar.innerHTML = `<span class="full-title">${esc(note.title)}</span>
    <button type="button" class="full-close" aria-label="Esci dallo schermo intero">✕</button>`;
  const onKey = (e) => { if (e.key === 'Escape') exitFull(); };
  function exitFull() {
    viewer.classList.remove('is-full');
    document.body.classList.remove('no-scroll', 'is-fullscreen');
    fullBar.remove();
    window.removeEventListener('route-change', exitFull);
    document.removeEventListener('keydown', onKey);
  }
  fullBar.querySelector('.full-close').addEventListener('click', exitFull);
  app.querySelector('#fullscreen').addEventListener('click', () => {
    viewer.classList.add('is-full');
    document.body.classList.add('no-scroll', 'is-fullscreen');
    document.body.append(fullBar);
    window.addEventListener('route-change', exitFull);
    document.addEventListener('keydown', onKey);
  });

  app.querySelector('#ai-explain')?.addEventListener('click', () => openAi('Spiegami in modo semplice e ordinato i concetti principali di questo appunto, poi fammi un breve riassunto finale.'));
  app.querySelector('#ai-ask')?.addEventListener('click', () => openAi());
  app.querySelector('#gen-quiz')?.addEventListener('click', () => openQuizGenerator({ noteId: note.id, noteTitle: note.title }));
  app.querySelector('#gen-map')?.addEventListener('click', () => openMapGenerator({ noteId: note.id, noteTitle: note.title }));

  // la tendina "Aiuto con l'IA" resta aperta o chiusa come l'ha lasciata lo studente
  const help = app.querySelector('.ai-help');
  if (help) {
    try { help.open = localStorage.getItem('ai-help-open') === '1'; } catch { /* modalità privata */ }
    help.addEventListener('toggle', () => { try { localStorage.setItem('ai-help-open', help.open ? '1' : '0'); } catch { /* */ } });
  }

  // mappe già create per questo appunto
  api(`/maps?noteId=${note.id}`).then(({ maps }) => {
    const box = app.querySelector('#note-maps');
    if (!box || !maps.length) return;
    box.innerHTML = `<div class="note-maps-title">🗺️ Le tue mappe</div>${maps.map((m) => `<a href="#/mappa/${m.id}">${esc(m.title)}<span>›</span></a>`).join('')}`;
    box.hidden = false;
  }).catch(() => {});
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
