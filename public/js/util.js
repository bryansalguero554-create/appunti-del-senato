// Funzioni di supporto condivise dal frontend.

export const state = { user: null, site: {}, aiContext: null };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form, signal } = {}) {
  const opts = { method, signal, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && state.user && !path.startsWith('/auth/login')) {
      state.user = null;
      window.dispatchEvent(new Event('session-lost'));
    }
    throw new ApiError(data?.error || `Errore ${res.status}`, res.status);
  }
  return data;
}

export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

export const toastError = (err) => toast(err?.message || String(err), 'error');

export function parseDate(s) {
  if (!s) return null;
  return new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

export function timeAgo(input) {
  const d = input instanceof Date ? input : (typeof input === 'number' ? new Date(input) : parseDate(input));
  if (!d) return '—';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'adesso';
  if (sec < 3600) return `${Math.round(sec / 60)} min fa`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h fa`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)} g fa`;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const formatDate = (s) => parseDate(s)?.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) ?? '—';

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

const TYPES = [
  [['pdf'], '📕', 'PDF'],
  [['doc', 'docx', 'odt', 'rtf', 'pages'], '📘', 'Documento'],
  [['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers'], '📗', 'Foglio'],
  [['ppt', 'pptx', 'odp', 'key'], '📙', 'Presentazione'],
  [['html', 'htm', 'xhtml'], '🌐', 'Pagina web'],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'ico'], '🖼️', 'Immagine'],
  [['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'], '🎧', 'Audio'],
  [['mp4', 'webm', 'mov', 'mkv', 'ogv'], '🎬', 'Video'],
  [['md', 'markdown', 'txt', 'tex', 'log'], '📝', 'Testo'],
  [['zip', 'rar', '7z', 'tar', 'gz'], '🗜️', 'Archivio'],
  [['epub'], '📖', 'E-book'],
  [['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'css', 'sql', 'sh', 'json', 'xml', 'yaml', 'yml'], '💻', 'Codice'],
];

export function fileType(ext) {
  const e = String(ext || '').toLowerCase();
  for (const [exts, icon, label] of TYPES) if (exts.includes(e)) return { icon, label };
  return { icon: '📄', label: 'File' };
}

export const isImageExt = (ext) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(String(ext).toLowerCase());

export function renderMarkdown(md) {
  const html = window.marked ? window.marked.parse(md || '', { breaks: true }) : esc(md).replace(/\n/g, '<br>');
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : esc(md);
}

export const sanitize = (html) => (window.DOMPurify ? window.DOMPurify.sanitize(html) : esc(html));

const loadedScripts = new Map();
export function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        loadedScripts.delete(src);
        reject(new Error('Impossibile caricare il visualizzatore.'));
      };
      document.head.append(s);
    }));
  }
  return loadedScripts.get(src);
}

let pdfjsPromise;
export function loadPdfJs() {
  pdfjsPromise ??= import('/vendor/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    return lib;
  });
  return pdfjsPromise;
}

// ---------- Modale ----------

export function closeModal() {
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
}

/**
 * Apre una finestra modale con un form. onSubmit(formData, form) può restituire una Promise;
 * se lancia un errore il messaggio viene mostrato e la modale resta aperta.
 */
export function openModal(title, html, onSubmit) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const form = $('#modal-body form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
        closeModal();
      } catch (err) {
        toastError(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    form.querySelector('input, textarea, select')?.focus();
  }
  return $('#modal-body');
}

export function confirmDialog(message, { confirmLabel = 'Conferma', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const body = openModal('Conferma', `
      <p>${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn" data-a="no">Annulla</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(confirmLabel)}</button>
      </div>`);
    body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      answered = true;
      closeModal();
      resolve(a === 'yes');
    });
    const observer = new MutationObserver(() => {
      if ($('#modal').hidden) {
        observer.disconnect();
        if (!answered) resolve(false);
      }
    });
    observer.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
  });
}

export function setAiContext(ctx) {
  state.aiContext = ctx;
  window.dispatchEvent(new Event('ai-context'));
}

export const spinner = () => '<div class="spinner" role="status" aria-label="Caricamento"></div>';

export function emptyState(icon, text, extra = '') {
  return `<div class="empty"><div class="big">${icon}</div><p>${text}</p>${extra}</div>`;
}

export const roleBadge = (role) => role === 'owner'
  ? '<span class="badge badge-role-owner">👑 VIP</span>'
  : role === 'moderator' ? '<span class="badge badge-role-moderator">Moderatore</span>' : '';

export const isOwner = () => state.user?.role === 'owner';
export const isModerator = () => ['owner', 'moderator'].includes(state.user?.role);
