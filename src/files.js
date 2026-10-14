import path from 'node:path';

const MIME = {
  pdf: 'application/pdf',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', rtf: 'application/rtf', tex: 'text/plain', log: 'text/plain',
  js: 'text/plain', ts: 'text/plain', py: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain',
  h: 'text/plain', cs: 'text/plain', css: 'text/plain', sql: 'text/plain', sh: 'text/plain', yaml: 'text/plain', yml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  zip: 'application/zip',
};

// Formati che il browser può visualizzare direttamente senza rischi per il sito.
const INLINE_SAFE = new Set([
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'application/json',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/x-icon',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-matroska',
]);

// Formati attivi (possono contenere script): mostrati in un contesto isolato tramite CSP sandbox.
const SANDBOXED = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml']);

export function extOf(filename) {
  return path.extname(filename || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

export function mimeFor(ext) {
  return MIME[ext] || 'application/octet-stream';
}

export function servingPolicy(mime) {
  if (SANDBOXED.has(mime)) return 'sandbox';
  if (INLINE_SAFE.has(mime)) return 'inline';
  return 'attachment';
}

export function isTextLike(mime) {
  return mime.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(mime);
}

export function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
