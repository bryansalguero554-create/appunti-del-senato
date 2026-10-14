// Estrazione del contenuto degli appunti per l'assistente AI.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { isTextLike } from './files.js';

export const MAX_TEXT_CHARS = 300_000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const AI_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class ContentTooLargeError extends Error {}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Lettore ZIP minimale (sufficiente per docx/pptx/odt/odp). */
function readZipEntries(buf, filter) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (!filter(name)) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    try {
      out[name] = method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    } catch {
      // voce corrotta: ignorata
    }
  }
  return out;
}

function xmlToText(xml) {
  return decodeEntities(xml
    .replace(/<\/(w:p|a:p|text:p|text:h)>/g, '\n')
    .replace(/<(w:tab|text:tab)\/>/g, '\t')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function officeToText(buf, ext) {
  if (ext === 'docx') {
    const e = readZipEntries(buf, (n) => n === 'word/document.xml');
    return e['word/document.xml'] ? xmlToText(e['word/document.xml']) : '';
  }
  if (ext === 'pptx') {
    const e = readZipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    return Object.keys(e)
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((k, i) => `--- Slide ${i + 1} ---\n${xmlToText(e[k])}`)
      .join('\n\n');
  }
  if (['odt', 'odp', 'ods'].includes(ext)) {
    const e = readZipEntries(buf, (n) => n === 'content.xml');
    return e['content.xml'] ? xmlToText(e['content.xml']) : '';
  }
  return '';
}

/**
 * Restituisce i blocchi di contenuto (formato Messages API) che rappresentano l'appunto,
 * oppure un blocco di testo che spiega perché il formato non è leggibile.
 */
export function noteToBlocks(note) {
  const filePath = path.join(config.uploadDir, path.basename(note.stored_name));
  const header = `Appunto "${note.title}" (file: ${note.original_name}, autore: ${note.author_name || 'sconosciuto'})`;
  if (!fs.existsSync(filePath)) return [{ type: 'text', text: `${header}: file non disponibile.` }];

  if (note.mime === 'application/pdf') {
    if (note.size > MAX_PDF_BYTES) throw new ContentTooLargeError(`Il PDF "${note.title}" è troppo grande per l'assistente AI (max 30 MB).`);
    return [
      { type: 'text', text: `${header}:` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(filePath).toString('base64') }, title: note.title },
    ];
  }
  if (AI_IMAGE_TYPES.has(note.mime)) {
    if (note.size > MAX_IMAGE_BYTES) throw new ContentTooLargeError(`L'immagine "${note.title}" è troppo grande per l'assistente AI (max 5 MB).`);
    return [
      { type: 'text', text: `${header}:` },
      { type: 'image', source: { type: 'base64', media_type: note.mime, data: fs.readFileSync(filePath).toString('base64') } },
    ];
  }

  let text = '';
  if (isTextLike(note.mime)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    text = note.mime === 'text/html' || note.mime === 'application/xhtml+xml' ? htmlToText(raw) : raw;
  } else if (['docx', 'pptx', 'odt', 'odp', 'ods'].includes(note.ext)) {
    text = officeToText(fs.readFileSync(filePath), note.ext);
  } else {
    return [{ type: 'text', text: `${header}: formato .${note.ext || '?'} non leggibile dall'assistente AI.` }];
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new ContentTooLargeError(`L'appunto "${note.title}" è troppo lungo per l'assistente AI (${text.length.toLocaleString('it-IT')} caratteri, max ${MAX_TEXT_CHARS.toLocaleString('it-IT')}).`);
  }
  return [{ type: 'text', text: `${header}:\n<appunto>\n${text || '(vuoto)'}\n</appunto>` }];
}
