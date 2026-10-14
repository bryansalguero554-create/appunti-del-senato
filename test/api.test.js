import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
const OWNER = { email: 'owner@test.local', password: 'OwnerPass123' };
let server;

class Client {
  cookie = '';
  async req(method, url, body, { form } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
}

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), UPLOAD_DIR: path.join(tmp, 'up'),
      OWNER_EMAIL: OWNER.email, OWNER_PASSWORD: OWNER.password, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', GEMINI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('avviato')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const owner = new Client();
const alice = new Client();
let subjectId; let topicId; let quizId;

test('registrazione, login e protezione email del proprietario', async () => {
  assert.equal((await alice.get('/api/subjects')).status, 401);
  let r = await alice.post('/api/auth/register', { name: 'Alice', email: 'alice@test.local', password: 'short' });
  assert.equal(r.status, 400);
  r = await alice.post('/api/auth/register', { name: 'Alice', email: 'alice@test.local', password: 'password123' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'user');
  r = await new Client().post('/api/auth/register', { name: 'XX', email: OWNER.email, password: 'password123' });
  assert.equal(r.status, 403);
  r = await owner.post('/api/auth/login', { email: OWNER.email, password: 'sbagliata' });
  assert.equal(r.status, 401);
  r = await owner.post('/api/auth/login', OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'owner');
});

test('materie predefinite create al primo avvio', async () => {
  const { data } = await alice.get('/api/subjects');
  const names = data.subjects.map((s) => s.name);
  assert.equal(names.length, 10);
  for (const n of ['Storia', 'Filosofia', 'Scienze umane', 'Fisica', 'Italiano', 'Spagnolo', 'Inglese', 'Matematica', 'Diritto', "Storia dell'arte"]) {
    assert.ok(names.includes(n), n);
  }
});

test('materie e argomenti con permessi', async () => {
  assert.equal((await alice.post('/api/subjects', { name: 'Storia' })).status, 403);
  let r = await owner.post('/api/subjects', { name: 'Latino', icon: '🏺', color: '#aa3311' });
  assert.equal(r.status, 201);
  subjectId = r.data.subject.id;
  r = await alice.post(`/api/subjects/${subjectId}/topics`, { name: 'Modulo 1' });
  assert.equal(r.status, 201);
  topicId = r.data.topic.id;
  r = await alice.get(`/api/subjects/${subjectId}`);
  assert.equal(r.data.topics[0].name, 'Modulo 1');
});

test('caricamento appunti in più formati e politiche di visualizzazione', async () => {
  const form = new FormData();
  form.append('files', new Blob(['<h1>Ciao</h1><script>alert(1)</script>'], { type: 'text/html' }), 'lezione.html');
  form.append('files', new Blob(['# Titolo\nTesto'], { type: 'text/markdown' }), 'riassunto àè.md');
  form.append('files', new Blob([new Uint8Array([1, 2, 3])]), 'archivio.xyz');
  const r = await alice.post(`/api/topics/${topicId}/notes`, undefined, { form });
  assert.equal(r.status, 201);
  assert.equal(r.data.ids.length, 3);
  const [htmlId, mdId, binId] = r.data.ids;

  const html = await alice.get(`/api/notes/${htmlId}/file`);
  assert.match(html.headers.get('content-security-policy'), /sandbox/);
  assert.match(html.headers.get('content-disposition'), /^inline/);
  const md = await alice.get(`/api/notes/${mdId}`);
  assert.equal(md.data.note.original_name, 'riassunto àè.md');
  assert.equal(md.data.note.policy, 'inline');
  const bin = await alice.get(`/api/notes/${binId}/file`);
  assert.match(bin.headers.get('content-disposition'), /^attachment/);

  const topic = await alice.get(`/api/topics/${topicId}`);
  assert.equal(topic.data.notes.length, 3);
  const search = await alice.get('/api/search?q=riassunto');
  assert.equal(search.data.notes.length, 1);
});

test('quiz: soluzioni nascoste e correzione lato server', async () => {
  let r = await alice.post('/api/quizzes', {
    title: 'Verifica', topic_id: topicId,
    questions: [
      { question: '1+1?', options: ['1', '2', '3'], correct_index: 1, explanation: 'Somma' },
      { question: 'Capitale d\'Italia?', options: ['Roma', 'Milano'], correct_index: 0 },
    ],
  });
  assert.equal(r.status, 201);
  quizId = r.data.id;
  r = await owner.get(`/api/quizzes/${quizId}`);
  assert.equal(r.data.questions[0].correct_index, undefined);
  const [q1, q2] = r.data.questions;
  r = await owner.post(`/api/quizzes/${quizId}/submit`, { answers: { [q1.id]: 1, [q2.id]: 1 } });
  assert.equal(r.data.score, 1);
  assert.equal(r.data.total, 2);
  r = await owner.post('/api/quizzes', { title: 'x', subject_id: subjectId, questions: [{ question: 'q', options: ['a'], correct_index: 0 }] });
  assert.equal(r.status, 400);
});

test('area riservata: solo il proprietario, presenza e sessioni', async () => {
  assert.equal((await alice.get('/api/admin/stats')).status, 403);
  await alice.post('/api/presence', { visitorId: 'abc', path: '#/argomento/1', title: 'Modulo 1' });
  let r = await owner.get('/api/admin/online');
  assert.ok(r.data.visitors.some((v) => v.email === 'alice@test.local' && v.path === '#/argomento/1'));
  r = await owner.get('/api/admin/stats');
  assert.equal(r.data.notes, 3);
  assert.equal(r.data.onlineUsers, 1);

  r = await owner.get('/api/admin/sessions');
  const aliceSession = r.data.sessions.find((s) => s.email === 'alice@test.local');
  assert.ok(aliceSession.online);
  r = await owner.req('DELETE', `/api/admin/sessions/${aliceSession.id}`);
  assert.equal(r.status, 200);
  r = await alice.get('/api/auth/me');
  assert.equal(r.data.user, null);
  r = await alice.post('/api/presence', { visitorId: 'abc' });
  assert.equal(r.data.sessionLost, true);
});

test('sospensione utente e permessi sui contenuti altrui', async () => {
  const bob = new Client();
  await bob.post('/api/auth/register', { name: 'Bob', email: 'bob@test.local', password: 'password123' });
  const { data } = await bob.get(`/api/topics/${topicId}`);
  assert.equal((await bob.req('DELETE', `/api/notes/${data.notes[0].id}`)).status, 403);
  const users = (await owner.get('/api/admin/users')).data.users;
  const bobId = users.find((u) => u.email === 'bob@test.local').id;
  await owner.req('PATCH', `/api/admin/users/${bobId}`, { banned: true });
  assert.equal((await bob.get('/api/subjects')).status, 401);
  assert.equal((await bob.post('/api/auth/login', { email: 'bob@test.local', password: 'password123' })).status, 403);
  const ownerId = users.find((u) => u.role === 'owner').id;
  assert.equal((await owner.req('DELETE', `/api/admin/users/${ownerId}`)).status, 400);
});

test('protezione CSRF e AI non configurata', async () => {
  const res = await fetch(`${BASE}/api/subjects`, {
    method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"name":"x"}',
  });
  assert.equal(res.status, 403);
  const r = await owner.post('/api/ai/chat', { messages: [{ role: 'user', content: 'ciao' }] });
  assert.equal(r.status, 503);
});
