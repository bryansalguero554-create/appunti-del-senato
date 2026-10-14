// Test della sincronizzazione con un finto server Google Drive in memoria.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLDER = 'application/vnd.google-apps.folder';
const files = new Map(); // id → { id, name, mimeType, parents, modifiedTime, content, trashed }
let seq = 0;
const now = () => new Date(Date.now() + seq * 1000).toISOString();
function add(name, mimeType, parent, content = '') {
  const id = `id${++seq}x0000000`;
  files.set(id, { id, name, mimeType, parents: [parent], modifiedTime: now(), content, trashed: false });
  return id;
}
const meta = ({ content, parents, ...f }) => ({ ...f, size: f.mimeType.startsWith('application/vnd.google-apps') ? undefined : String(Buffer.byteLength(content)) });
const SYSTEM_FOLDER = 'Appunti del Senato – dati del sito (non toccare)';

const ROOT = add('Appunti', FOLDER, 'root');
const STORIA = add('Storia', FOLDER, ROOT);
const MOD1 = add('Modulo 1', FOLDER, STORIA);
const TXT = add('lezione.txt', 'text/plain', MOD1, 'La Bastiglia, 1789');
add('Riassunto', 'application/vnd.google-apps.document', MOD1, '%PDF-1.4 export');
add('Matematica', FOLDER, ROOT);

const uploads = new Map();
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q');
      const parent = q.match(/'([^']+)' in parents/)[1];
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1');
      return json(200, { files: [...files.values()].filter((f) => f.parents[0] === parent && !f.trashed && (!name || f.name === name)).map(meta) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const b = JSON.parse(body);
      return json(200, meta(files.get(add(b.name, b.mimeType, b.parents[0]))));
    }
    if (url.pathname === '/upload/drive/v3/files') {
      const sid = `s${++seq}`;
      uploads.set(sid, JSON.parse(body));
      res.writeHead(200, { location: `http://127.0.0.1:${mock.address().port}/upload/session/${sid}` });
      return res.end();
    }
    if (url.pathname.startsWith('/upload/session/')) {
      const m = uploads.get(url.pathname.split('/').pop());
      return json(200, meta(files.get(add(m.name, req.headers['content-type'], m.parents[0], raw))));
    }
    const media = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (media && req.method === 'PATCH') {
      const f = files.get(media[1]);
      if (!f) return json(404, { error: { message: 'not found' } });
      Object.assign(f, { content: raw, modifiedTime: now() });
      return json(200, meta(f));
    }
    const fm = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (fm) {
      const f = files.get(fm[1]);
      if (!f) return json(404, { error: { message: 'not found' } });
      if (req.method === 'PATCH') {
        Object.assign(f, JSON.parse(body), { modifiedTime: now() });
        return json(200, meta(f));
      }
      if (fm[2] || url.searchParams.get('alt') === 'media') { res.writeHead(200); return res.end(f.content); }
      return json(200, meta(f));
    }
    json(404, { error: { message: `unhandled ${req.method} ${url.pathname}` } });
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-test-'));
let server; let cookie = ''; let base; let mockUrl;

function startServer(port, dir) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'd'), UPLOAD_DIR: path.join(dir, 'u'),
      OWNER_EMAIL: 'o@t.local', OWNER_PASSWORD: 'OwnerPass123', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', DRIVE_REFRESH_TOKEN: 'refresh',
      GOOGLE_API_BASE: mockUrl, GOOGLE_TOKEN_URL: `${mockUrl}/token`, DRIVE_SYNC_MINUTES: '60', SEED_DEFAULT_SUBJECTS: 'false',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('avviato')) resolve(); }));
  return { proc, ready };
}

async function call(method, url, body, form) {
  const headers = { cookie };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const waitQueue = () => call('POST', '/api/admin/drive/sync'); // la coda è seriale: il sync parte dopo i push

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const port = 4100 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  const started = startServer(port, path.join(tmp, 'a'));
  server = started.proc;
  await started.ready;
  await call('POST', '/api/auth/login', { email: 'o@t.local', password: 'OwnerPass123' });
});

after(() => {
  server?.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('importa materie, argomenti e file dal Drive', async () => {
  const r = await call('POST', '/api/admin/drive/root', { folder: `https://drive.google.com/drive/folders/${ROOT}?usp=sharing` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stats.subjects, 2);
  assert.equal(r.data.stats.topics, 1);
  assert.equal(r.data.stats.notes, 2);
  const { data } = await call('GET', '/api/subjects');
  assert.deepEqual(data.subjects.map((s) => s.name), ['Matematica', 'Storia']);
  const storia = await call('GET', `/api/subjects/${data.subjects[1].id}`);
  const topic = await call('GET', `/api/topics/${storia.data.topics[0].id}`);
  const names = topic.data.notes.map((n) => n.original_name).sort();
  assert.deepEqual(names, ['Riassunto.pdf', 'lezione.txt']);
});

test('modifiche sul sito vengono riportate nel Drive', async () => {
  const { data } = await call('GET', '/api/subjects');
  const storiaId = data.subjects.find((s) => s.name === 'Storia').id;
  const t = await call('POST', `/api/subjects/${storiaId}/topics`, { name: 'Modulo 2' });
  const form = new FormData();
  form.append('files', new Blob(['appunti di Napoleone']), 'napoleone.md');
  await call('POST', `/api/topics/${t.data.topic.id}/notes`, undefined, form);
  await waitQueue();
  const mod2 = [...files.values()].find((f) => f.name === 'Modulo 2');
  assert.ok(mod2, 'cartella creata nel Drive');
  assert.equal(mod2.parents[0], STORIA);
  const up = [...files.values()].find((f) => f.name === 'napoleone.md');
  assert.equal(up.parents[0], mod2.id);
  assert.equal(up.content.toString(), 'appunti di Napoleone');
  // il sync successivo non deve duplicare l'appunto appena caricato
  const topic = await call('GET', `/api/topics/${t.data.topic.id}`);
  assert.equal(topic.data.notes.length, 1);
});

test('rinomine ed eliminazioni nel Drive arrivano sul sito', async () => {
  files.get(MOD1).name = 'Modulo 1 – Rivoluzione';
  files.get(TXT).trashed = true;
  const r = await waitQueue();
  assert.equal(r.data.stats.removed, 1);
  const { data } = await call('GET', '/api/search?q=Rivoluzione');
  assert.equal(data.topics[0].name, 'Modulo 1 – Rivoluzione');
  const s = await call('GET', '/api/search?q=lezione');
  assert.equal(s.data.notes.length, 0);
});

test('eliminare sul sito sposta nel cestino del Drive', async () => {
  const s = await call('GET', '/api/search?q=napoleone');
  await call('DELETE', `/api/notes/${s.data.notes[0].id}`);
  await waitQueue();
  assert.equal([...files.values()].find((f) => f.name === 'napoleone.md').trashed, true);
});

test('database salvato nel Drive e ripristinato su un server nuovo e vuoto', async () => {
  const b = await call('POST', '/api/admin/drive/backup');
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const sys = [...files.values()].find((f) => f.name === SYSTEM_FOLDER && !f.trashed);
  assert.equal(sys.parents[0], 'root');
  const dbFile = [...files.values()].find((f) => f.name === 'database.sqlite' && f.parents[0] === sys.id);
  assert.equal(dbFile.content.subarray(0, 15).toString(), 'SQLite format 3');

  // un secondo server con disco vuoto (come Render gratuito dopo un riavvio)
  const port = 4700 + Math.floor(Math.random() * 200);
  const fresh = startServer(port, path.join(tmp, 'b'));
  await fresh.ready;
  try {
    const other = `http://127.0.0.1:${port}`;
    const me = await (await fetch(`${other}/api/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.user?.email, 'o@t.local', 'la sessione è sopravvissuta al riavvio');
    const subjects = await (await fetch(`${other}/api/subjects`, { headers: { cookie } })).json();
    assert.deepEqual(subjects.subjects.map((x) => x.name), ['Matematica', 'Storia']);
    const found = await (await fetch(`${other}/api/search?q=Riassunto`, { headers: { cookie } })).json();
    const res = await fetch(`${other}/api/notes/${found.notes[0].id}/file`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '%PDF-1.4 export', 'file riscaricato dal Drive al primo accesso');
  } finally {
    fresh.proc.kill();
  }
});

test('protezione: cartella principale svuotata non cancella le materie', async () => {
  for (const f of files.values()) if (f.parents[0] === ROOT) f.trashed = true;
  const r = await waitQueue();
  assert.equal(r.data.stats.removed, 0);
  assert.equal(r.data.stats.warnings.length, 1);
  const { data } = await call('GET', '/api/subjects');
  assert.equal(data.subjects.length, 2);
});

test('cartelle del Drive in minuscolo o con altri nomi ricevono icona e descrizione delle materie', async () => {
  add('arte', FOLDER, ROOT);
  add('filosofia', FOLDER, ROOT);
  const r = await waitQueue();
  assert.equal(r.status, 200);
  const { data } = await call('GET', '/api/subjects');
  const arte = data.subjects.find((x) => x.name === 'arte');
  assert.equal(arte.icon, '🎨');
  assert.equal(arte.description, 'Opere, artisti e movimenti artistici.');
  const filo = data.subjects.find((x) => x.name === 'filosofia');
  assert.equal(filo.icon, '🦉');
  assert.equal(filo.description, 'Pensatori, correnti e grandi domande.');
});
