// Test dell'assistente AI con Google Gemini, usando un finto server Gemini.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const requests = [];
let failModel = null; // modello che risponde "quota esaurita", per provare il passaggio automatico
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'], body: body ? JSON.parse(body) : null });
    if (req.url.startsWith('/v1beta/models?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ] }));
    }
    if (failModel && req.url.includes(`models/${failModel}:`)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 0', status: 'RESOURCE_EXHAUSTED' } }));
    }
    if (req.url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['La Bastiglia ', 'fu presa nel 1789.']) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\r\n\r\n`);
      }
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
      return res.end();
    }
    if (req.url.includes(':generateContent') && /mappa concettuale/.test(JSON.stringify(JSON.parse(body).contents))) {
      const edit = /Modificala/.test(body);
      // l'AI a volte sbaglia: un id ripetuto e un genitore inesistente vengono sistemati dal server
      const map = { title: 'Rivoluzione francese', nodes: [
        { id: 'r', parent: '', label: 'Rivoluzione francese', detail: '1789-1799' },
        { id: 'c', parent: 'r', label: 'Cause', detail: 'Crisi economica e idee illuministe' },
        { id: 'c1', parent: 'c', label: 'Debito pubblico', detail: '' },
        { id: 'f', parent: 'r', label: 'Fasi', detail: '' },
        { id: 'f', parent: 'r', label: 'Doppione', detail: '' },
        { id: 'x', parent: 'nessuno', label: 'Conseguenze', detail: 'Fine dell\'Ancien Régime' },
        ...(edit ? [{ id: 'd', parent: 'f', label: '14 luglio 1789', detail: 'Presa della Bastiglia' }] : []),
      ] };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(map) }] }, finishReason: 'STOP' }] }));
    }
    if (req.url.includes(':generateContent')) {
      const quiz = { title: 'Quiz Gemini', description: 'ok', questions: [
        { question: 'Anno della presa della Bastiglia?', options: ['1789', '1815', '1492', '1848'], correct_index: 0, explanation: '14 luglio 1789' },
      ] };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(quiz) }] }, finishReason: 'STOP' }] }));
    }
    res.writeHead(404);
    res.end();
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
let server; let base; let cookie = '';

async function call(method, url, body, form) {
  const headers = { cookie };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = 4900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: path.join(tmp, 'd'), UPLOAD_DIR: path.join(tmp, 'u'),
      OWNER_EMAIL: 'o@t.local', OWNER_PASSWORD: 'OwnerPass123', ANTHROPIC_API_KEY: '', GOOGLE_CLIENT_ID: '',
      GEMINI_API_KEY: 'gem-key', GEMINI_API_BASE: `http://127.0.0.1:${mock.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('avviato')) resolve(); }));
  await call('POST', '/api/auth/login', { email: 'o@t.local', password: 'OwnerPass123' });
});

after(() => {
  server?.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('la chat usa Gemini (modello Flash gratuito) e l\'appunto allegato', async () => {
  const me = await (await call('GET', '/api/auth/me')).json();
  assert.equal(me.site.aiEnabled, true);
  const subjects = await (await call('GET', '/api/subjects')).json();
  const topic = await (await call('POST', `/api/subjects/${subjects.subjects[0].id}/topics`, { name: 'Modulo 1' })).json();
  const form = new FormData();
  form.append('files', new Blob(['%PDF-1.4 finto'], { type: 'application/pdf' }), 'lezione.pdf');
  const up = await (await call('POST', `/api/topics/${topic.topic.id}/notes`, undefined, form)).json();

  const res = await call('POST', '/api/ai/chat', {
    messages: [{ role: 'user', content: 'Quando fu presa la Bastiglia?' }],
    context: { topicId: topic.topic.id, noteId: up.ids[0] },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'La Bastiglia fu presa nel 1789.');

  const sent = requests.find((r) => r.url.includes(':streamGenerateContent'));
  assert.match(sent.url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse/);
  assert.equal(sent.key, 'gem-key');
  assert.match(sent.body.systemInstruction.parts[0].text, /Modulo 1/);
  const parts = sent.body.contents[0].parts;
  assert.equal(sent.body.contents[0].role, 'user');
  assert.ok(parts.some((p) => p.inlineData?.mimeType === 'application/pdf'), 'PDF allegato');
  assert.equal(parts.at(-1).text, 'Quando fu presa la Bastiglia?');
});

test('i quiz vengono generati con Gemini e salvati subito', async () => {
  const subjects = await (await call('GET', '/api/subjects')).json();
  const detail = await (await call('GET', `/api/subjects/${subjects.subjects[0].id}`)).json();
  const res = await call('POST', '/api/ai/quiz', { topicId: detail.topics[0].id, count: 3, difficulty: 'facile' });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const saved = await (await call('GET', `/api/quizzes/${data.id}`)).json();
  assert.equal(saved.quiz.title, 'Quiz Gemini');
  assert.equal(saved.quiz.ai_generated, 1);
  assert.equal(saved.quiz.topic_id, detail.topics[0].id);
  assert.equal(saved.questions.length, 1);
  assert.equal(saved.questions[0].correct_index, undefined, 'soluzioni nascoste a chi svolge il quiz');
  const sent = requests.find((r) => r.url.includes(':generateContent') && !r.url.includes('stream'));
  assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(sent.body.generationConfig.responseSchema.type, 'OBJECT');
  assert.match(sent.body.contents[0].parts.at(-1).text, /esattamente 3/);
});

test('quiz su tutta la materia, senza scegliere un argomento', async () => {
  const subjects = await (await call('GET', '/api/subjects')).json();
  const res = await call('POST', '/api/ai/quiz', { subjectId: subjects.subjects[1].id, count: 5 });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const saved = await (await call('GET', `/api/quizzes/${id}`)).json();
  assert.equal(saved.quiz.subject_id, subjects.subjects[1].id);
  assert.equal(saved.quiz.topic_id, null);
  const prompt = requests.filter((r) => r.url.includes(':generateContent') && !r.url.includes('stream')).at(-1).body.contents[0].parts.at(-1).text;
  assert.match(prompt, /tutti gli argomenti/);
});

test('se un modello ha la quota esaurita si passa da solo a un altro', async () => {
  failModel = 'gemini-2.5-flash';
  try {
    const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Ciao' }] });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'La Bastiglia fu presa nel 1789.');
    const last = requests.filter((r) => r.url.includes(':streamGenerateContent')).at(-1);
    assert.match(last.url, /gemini-3\.5-flash:/);
    const test = await (await call('POST', '/api/ai/test')).json();
    assert.equal(test.ok, true);
    assert.equal(test.model, 'gemini-3.5-flash');
  } finally {
    failModel = null;
  }
});

test('mappe concettuali: create e modificate con l\'AI, modificabili a mano e personali', async () => {
  const subjects = await (await call('GET', '/api/subjects')).json();
  const topic = await (await call('POST', `/api/subjects/${subjects.subjects[0].id}/topics`, { name: 'Mappe' })).json();
  const form = new FormData();
  form.append('files', new Blob(['La Rivoluzione francese iniziò nel 1789.'], { type: 'text/plain' }), 'rivoluzione.txt');
  const up = await (await call('POST', `/api/topics/${topic.topic.id}/notes`, undefined, form)).json();
  const noteId = up.ids[0];

  let res = await call('POST', '/api/ai/map', { noteId, instructions: 'solo le date' });
  let data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const prompt = requests.filter((r) => r.url.includes(':generateContent') && !r.url.includes('stream')).at(-1).body;
  assert.match(prompt.contents[0].parts.at(-1).text, /mappa concettuale per preparare un'interrogazione/);
  assert.match(prompt.contents[0].parts.at(-1).text, /solo le date/);
  assert.ok(prompt.contents[0].parts.some((p) => /1789/.test(p.text || '')), 'appunto allegato');
  assert.equal(prompt.generationConfig.responseSchema.properties.nodes.type, 'ARRAY');

  const mapId = data.id;
  let map = (await (await call('GET', `/api/maps/${mapId}`)).json()).map;
  assert.equal(map.title, 'Rivoluzione francese');
  assert.equal(map.note_id, noteId);
  assert.equal(map.nodes.length, 5, 'id doppio scartato');
  assert.equal(map.nodes[0].parent, '', 'una sola radice, per prima');
  assert.equal(map.nodes.filter((n) => !n.parent).length, 1);
  assert.equal(map.nodes.find((n) => n.label === 'Conseguenze').parent, map.nodes[0].id, 'genitore inesistente → radice');

  res = await call('POST', `/api/ai/map/${mapId}/edit`, { instruction: 'aggiungi la presa della Bastiglia' });
  data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.ok(data.map.nodes.some((n) => n.label === '14 luglio 1789'));
  const editPrompt = requests.filter((r) => r.url.includes(':generateContent') && !r.url.includes('stream')).at(-1).body.contents[0].parts.at(-1).text;
  assert.match(editPrompt, /aggiungi la presa della Bastiglia/);
  assert.match(editPrompt, /"label":"Cause"/, 'mappa attuale inviata all\'AI');

  // modifica a mano: un ciclo viene spezzato e ricollegato alla radice
  const nodes = data.map.nodes.map((n) => (n.label === 'Cause' ? { ...n, label: 'Cause principali' } : n));
  const deb = nodes.find((n) => n.label === 'Debito pubblico');
  const cause = nodes.find((n) => n.label === 'Cause principali');
  cause.parent = deb.id;
  res = await call('PUT', `/api/maps/${mapId}`, { title: 'La Rivoluzione', nodes });
  data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.map.title, 'La Rivoluzione');
  const fixed = data.map.nodes.find((n) => n.label === 'Cause principali');
  assert.equal(fixed.parent, data.map.nodes[0].id);

  const list = await (await call('GET', `/api/maps?noteId=${noteId}`)).json();
  assert.deepEqual(list.maps.map((m) => m.id), [mapId]);

  // un altro studente non vede la mappa
  const saved = cookie;
  cookie = '';
  await call('POST', '/api/auth/register', { name: 'Bea', email: 'bea@t.local', password: 'BeaPass1234' });
  assert.equal((await call('GET', `/api/maps/${mapId}`)).status, 404);
  assert.equal((await call('DELETE', `/api/maps/${mapId}`)).status, 404);
  cookie = saved;

  assert.equal((await call('DELETE', `/api/maps/${mapId}`)).status, 200);
  assert.equal((await call('GET', `/api/maps/${mapId}`)).status, 404);
});
