import {
  state, api, esc, timeAgo, fileType, isImageExt, formatBytes, emptyState, openModal, confirmDialog,
  toast, toastError, setAiContext, loadPdfJs, isModerator, cap,
} from '../util.js';
import { topicForm } from './subject.js';
import { openAi } from '../ai.js';
import { openQuizGenerator } from '../quizgen.js';

/** Disegna l'anteprima della prima pagina dei PDF quando la card diventa visibile. */
const pdfObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    pdfObserver.unobserve(entry.target);
    renderPdfThumb(entry.target);
  }
}, { rootMargin: '200px' }) : null;

async function renderPdfThumb(el) {
  try {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ url: `/api/notes/${el.dataset.pdf}/file`, disableAutoFetch: true, disableStream: true }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = 320 / viewport.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    el.querySelector('.ext-icon')?.remove();
    el.prepend(canvas);
    doc.destroy();
  } catch {
    // anteprima non disponibile: resta l'icona
  }
}

export function noteCard(n) {
  const t = fileType(n.ext);
  const thumb = isImageExt(n.ext)
    ? `<img loading="lazy" src="/api/notes/${n.id}/file" alt="">`
    : `<span class="ext-icon">${t.icon}</span>`;
  return `
    <a class="card note-card tilt" data-tilt="6" href="#/appunto/${n.id}">
      <div class="note-thumb" ${n.ext === 'pdf' ? `data-pdf="${n.id}"` : ''}>${thumb}<span class="badge ext-label">${esc(n.ext || 'file')}</span></div>
      <div class="note-body">
        <div class="note-title">${esc(n.title)}</div>
        <div class="note-meta">👤 ${esc(n.author_name || 'utente eliminato')} · ${timeAgo(n.created_at)}</div>
        <div class="note-meta">${t.label} · ${formatBytes(n.size)}</div>
      </div>
    </a>`;
}

export async function renderTopic(app, { params: [id] }) {
  const { topic, subject, notes, quizzes } = await api(`/topics/${id}`);
  setAiContext({ subjectId: subject.id, topicId: topic.id, label: `${subject.icon} ${subject.name} › ${topic.name}` });
  const canEdit = isModerator() || topic.created_by === state.user.id;
  const filters = { author: 'all', type: 'all' };

  const authors = [...new Map(notes.map((n) => [n.user_id, n.author_name || 'utente eliminato'])).entries()];
  const types = [...new Set(notes.map((n) => fileType(n.ext).label))];

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <div class="breadcrumb"><a href="#/">Materie</a> › <a href="#/materia/${subject.id}">${esc(subject.icon)} ${esc(cap(subject.name))}</a> ›</div>
        <h1>📁 ${esc(topic.name)}</h1>
        ${topic.description ? `<p class="muted">${esc(topic.description)}</p>` : ''}
        <p class="muted small">Creato da ${esc(topic.author_name || '—')} · ${notes.length} appunti</p>
      </div>
      <div class="row">
        ${canEdit ? '<button class="btn" id="edit-topic">Modifica</button><button class="btn btn-danger" id="delete-topic">Elimina</button>' : ''}
        ${state.site.aiEnabled ? '<button class="btn" id="ask-ai">🤖 Chiedi all\'AI</button>' : ''}
        <button class="btn btn-primary" id="show-upload">⬆️ Carica appunti</button>
      </div>
    </div>

    <div class="card" id="upload-panel" hidden style="margin-bottom:24px">
      <h2>Carica i tuoi appunti</h2>
      <p class="muted small">Puoi caricare qualsiasi formato: PDF, Word, PowerPoint, Excel, HTML, immagini, audio, video, testo… (max ${state.site.maxUploadMb} MB per file, fino a 20 file insieme).</p>
      <form id="upload-form">
        <div class="dropzone" id="dropzone" tabindex="0">
          <div class="drop-icon">📤</div>
          <strong>Trascina qui i file</strong> oppure clicca per sceglierli
          <input type="file" id="file-input" name="files" multiple hidden>
        </div>
        <ul class="file-list" id="file-list"></ul>
        <div class="field-row" style="margin-top:14px">
          <div class="field"><label>Titolo</label><input name="title" maxlength="150" placeholder="Facoltativo: di default il nome del file"></div>
          <div class="field"><label>Descrizione</label><input name="description" maxlength="1000" placeholder="Facoltativa"></div>
        </div>
        <div class="progress" id="upload-progress" hidden><div></div></div>
        <div class="row" style="margin-top:12px"><span class="spacer"></span>
          <button type="button" class="btn" id="cancel-upload">Annulla</button>
          <button type="submit" class="btn btn-primary" id="upload-btn">Carica</button></div>
      </form>
    </div>

    ${notes.length ? `
    <div class="stack" style="margin-bottom:16px">
      ${authors.length > 1 ? `<div class="chips" id="author-chips"><span class="muted small" style="align-self:center">Autori:</span>
        <button class="chip active" data-author="all">Tutti</button>
        ${authors.map(([uid, name]) => `<button class="chip" data-author="${uid}">${esc(name)}</button>`).join('')}</div>` : ''}
      ${types.length > 1 ? `<div class="chips" id="type-chips"><span class="muted small" style="align-self:center">Formato:</span>
        <button class="chip active" data-type="all">Tutti</button>
        ${types.map((t) => `<button class="chip" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="grid grid-sm" id="notes-grid"></div>`
    : emptyState('📭', 'Questa cartella è vuota. Sii il primo a caricare i tuoi appunti!')}

    <div class="section">
      <div class="section-head">
        <h2>Quiz di verifica</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" id="gen-quiz">✨ Genera quiz con AI</button>
      </div>
      ${quizzes.length ? `<div class="list">${quizzes.map((q) => `
        <a class="list-item" href="#/quiz/${q.id}">
          <span style="font-size:1.4rem">✅</span>
          <div class="grow"><div class="title">${esc(q.title)}</div>
            <div class="muted small">${q.question_count} domande · di ${esc(q.author_name || '—')} · ${timeAgo(q.created_at)}</div></div>
          ${q.ai_generated ? '<span class="badge badge-ai">AI</span>' : ''}
        </a>`).join('')}</div>` : '<p class="muted">Nessun quiz per questo argomento: fattene preparare uno dall\'AI sui tuoi appunti.</p>'}
    </div>`;

  const grid = app.querySelector('#notes-grid');
  function drawNotes() {
    if (!grid) return;
    const list = notes.filter((n) => (filters.author === 'all' || String(n.user_id) === filters.author)
      && (filters.type === 'all' || fileType(n.ext).label === filters.type));
    grid.innerHTML = list.map(noteCard).join('') || '<p class="muted">Nessun appunto con questi filtri.</p>';
    grid.querySelectorAll('[data-pdf]').forEach((el) => (pdfObserver ? pdfObserver.observe(el) : renderPdfThumb(el)));
  }
  drawNotes();

  for (const [sel, key] of [['#author-chips', 'author'], ['#type-chips', 'type']]) {
    app.querySelector(sel)?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filters[key] = chip.dataset[key];
      app.querySelectorAll(`${sel} .chip`).forEach((c) => c.classList.toggle('active', c === chip));
      drawNotes();
    });
  }

  // ----- Upload -----
  const panel = app.querySelector('#upload-panel');
  const input = app.querySelector('#file-input');
  const dropzone = app.querySelector('#dropzone');
  const fileList = app.querySelector('#file-list');
  let files = [];
  const maxBytes = state.site.maxUploadMb * 1024 * 1024;

  function setFiles(newFiles) {
    files = [...files, ...newFiles].slice(0, 20);
    fileList.innerHTML = files.map((f, i) => `<li><span>${fileType(f.name.split('.').pop()).icon} ${esc(f.name)}
      ${f.size > maxBytes ? '<strong style="color:var(--danger)"> (troppo grande)</strong>' : ''}</span>
      <span>${formatBytes(f.size)} <button type="button" class="icon-btn" data-remove="${i}" aria-label="Rimuovi">✕</button></span></li>`).join('');
  }
  app.querySelector('#show-upload').addEventListener('click', () => {
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  app.querySelector('#cancel-upload').addEventListener('click', () => {
    panel.hidden = true;
    files = [];
    setFiles([]);
  });
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { setFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => setFiles([...e.dataTransfer.files]));
  fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    files.splice(Number(btn.dataset.remove), 1);
    const keep = files;
    files = [];
    setFiles(keep);
  });

  app.querySelector('#upload-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!files.length) return toast('Seleziona almeno un file.', 'error');
    if (files.some((f) => f.size > maxBytes)) return toast(`Rimuovi i file più grandi di ${state.site.maxUploadMb} MB.`, 'error');
    const fd = new FormData(e.target);
    fd.delete('files');
    files.forEach((f) => fd.append('files', f, f.name));
    const btn = app.querySelector('#upload-btn');
    const bar = app.querySelector('#upload-progress');
    btn.disabled = true;
    bar.hidden = false;
    // XMLHttpRequest per mostrare l'avanzamento del caricamento
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/topics/${topic.id}/notes`);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onload = () => {
      btn.disabled = false;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* risposta non JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        toast(files.length > 1 ? `${files.length} appunti caricati!` : 'Appunto caricato!');
        renderTopic(app, { params: [id] });
      } else {
        bar.hidden = true;
        toastError(new Error(data.error || 'Caricamento non riuscito.'));
      }
    };
    xhr.onerror = () => {
      btn.disabled = false;
      bar.hidden = true;
      toastError(new Error('Errore di rete durante il caricamento.'));
    };
    xhr.send(fd);
  });

  app.querySelector('#ask-ai')?.addEventListener('click', () => openAi());
  app.querySelector('#gen-quiz').addEventListener('click', () => openQuizGenerator({ subjectId: subject.id, topicId: topic.id }));
  app.querySelector('#edit-topic')?.addEventListener('click', () => {
    openModal('Modifica argomento', topicForm(topic), async (fd) => {
      await api(`/topics/${topic.id}`, { method: 'PATCH', body: Object.fromEntries(fd) });
      toast('Argomento aggiornato');
      renderTopic(app, { params: [id] });
    });
  });
  app.querySelector('#delete-topic')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Eliminare la cartella "${topic.name}" con tutti gli appunti e i quiz?`, { confirmLabel: 'Elimina' }))) return;
    try {
      await api(`/topics/${topic.id}`, { method: 'DELETE' });
      toast('Argomento eliminato');
      location.hash = `#/materia/${subject.id}`;
    } catch (err) {
      toastError(err);
    }
  });
}
