import {
  state, api, esc, formatBytes, formatDate, fileType, openModal, confirmDialog, toast, toastError,
  setAiContext, renderMarkdown, sanitize, loadScript, spinner,
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

async function renderViewer(el, note) {
  const url = `/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}`;
  const ext = note.ext;
  const mime = note.mime;
  const noPreview = (msg) => {
    el.innerHTML = `<div class="no-preview"><div class="big">${fileType(ext).icon}</div>
      <p><strong>${esc(note.original_name)}</strong></p>
      <p class="muted">${msg || 'L\'anteprima di questo formato non è disponibile nel browser.'}</p>
      <a class="btn btn-primary" href="${url}?download=1">⬇️ Scarica il file</a></div>`;
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
      frame.srcdoc = decodeHtml(await res.arrayBuffer());
      el.replaceChildren(frame);
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
    el.innerHTML = `<iframe src="${url}#view=FitH" title="${esc(note.title)}"></iframe>`;
    return;
  }
  if (mime.startsWith('image/')) {
    el.innerHTML = `<img src="${url}" alt="${esc(note.title)}">`;
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
      return;
    }
    if (ext === 'docx') {
      await loadScript('/vendor/mammoth.js');
      const buf = await (await fetch(url)).arrayBuffer();
      const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      el.innerHTML = `<div class="doc prose">${sanitize(value) || '<p class="muted">Documento vuoto.</p>'}</div>`;
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
          <a class="btn" href="/api/notes/${note.id}/file/${encodeURIComponent(note.original_name)}?download=1">⬇️ Scarica</a>
          ${state.site.aiEnabled ? `<button class="btn" id="ai-explain">🤖 Spiegami questo appunto</button>
          <button class="btn" id="ai-ask">💬 Ho un dubbio</button>
          <button class="btn" id="gen-quiz">✨ Genera quiz da questo appunto</button>` : ''}
          ${note.canManage ? '<button class="btn" id="edit-note">✏️ Modifica</button><button class="btn btn-danger" id="delete-note">🗑️ Elimina</button>' : ''}
        </div>
      </aside>
    </div>`;

  const viewer = app.querySelector('#viewer');
  renderViewer(viewer, note);

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
