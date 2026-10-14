import { state, $, esc, renderMarkdown } from './util.js';

const history = [];
let busy = false;
let controller = null;

const SUGGESTIONS = [
  'Riassumimi i concetti chiave di questo argomento',
  'Fammi 3 domande per verificare se ho capito',
  'Spiegami la differenza tra i concetti più confusi',
];

function drawer() { return $('#ai-drawer'); }

export function openAi(prefill) {
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  updateContext();
  if (prefill) {
    $('#ai-input').value = prefill;
    send();
  } else {
    $('#ai-input').focus();
  }
}

function closeAi() {
  drawer().classList.remove('open');
  drawer().setAttribute('aria-hidden', 'true');
}

function updateContext() {
  const ctx = state.aiContext;
  $('#ai-context').textContent = ctx ? `Contesto: ${ctx.label}` : 'Domanda libera';
  $('#ai-attach-label').hidden = !ctx?.noteId;
  if (ctx?.noteTitle) $('#ai-attach-label').lastChild.textContent = ` Usa "${ctx.noteTitle}" come riferimento`;
}

function renderMessages() {
  const box = $('#ai-messages');
  if (!state.site.aiEnabled) {
    box.innerHTML = '<div class="msg assistant">L\'assistente AI non è ancora configurato. Il proprietario del sito deve impostare la chiave <code>ANTHROPIC_API_KEY</code>.</div>';
    return;
  }
  if (!history.length) {
    box.innerHTML = `
      <div class="msg assistant">Ciao! Sono il tuo assistente di studio 🤓 Chiedimi qualsiasi dubbio: se apri un appunto posso leggerlo e spiegartelo.</div>
      <div class="ai-suggestions">${SUGGESTIONS.map((s) => `<button class="btn btn-sm" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    return;
  }
  box.innerHTML = history.map((m) => (m.role === 'user'
    ? `<div class="msg user">${esc(m.content)}</div>`
    : `<div class="msg assistant ${m.error ? 'error' : ''} ${m.pending ? 'typing' : ''}"><div class="prose">${renderMarkdown(m.content)}</div></div>`)).join('');
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const input = $('#ai-input');
  const text = input.value.trim();
  if (!text || busy || !state.site.aiEnabled) return;
  input.value = '';
  history.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '', pending: true };
  history.push(reply);
  busy = true;
  $('#ai-send').disabled = true;
  renderMessages();

  const ctx = state.aiContext || {};
  const useNote = ctx.noteId && $('#ai-attach').checked;
  controller = new AbortController();
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: history.filter((m) => !m.pending && !m.error && !m.excluded).map(({ role, content }) => ({ role, content })),
        context: { subjectId: ctx.subjectId, topicId: ctx.topicId, noteId: useNote ? ctx.noteId : undefined },
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Errore ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let scheduled = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.content += decoder.decode(value, { stream: true });
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; renderMessages(); });
      }
    }
    if (!reply.content.trim()) reply.content = '_(nessuna risposta)_';
  } catch (err) {
    if (err.name === 'AbortError') {
      reply.content += '\n\n_(interrotto)_';
    } else {
      reply.content = err.message;
      reply.error = true;
      // la domanda resta visibile ma non viene reinviata come contesto
      history[history.indexOf(reply) - 1].excluded = true;
    }
  } finally {
    reply.pending = false;
    busy = false;
    controller = null;
    $('#ai-send').disabled = false;
    renderMessages();
  }
}

export function initAi() {
  $('#ai-fab').addEventListener('click', () => (drawer().classList.contains('open') ? closeAi() : openAi()));
  $('#ai-close').addEventListener('click', closeAi);
  $('#ai-clear').addEventListener('click', () => {
    controller?.abort();
    history.length = 0;
    renderMessages();
  });
  $('#ai-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#ai-messages').addEventListener('click', (e) => {
    const s = e.target.closest('[data-suggest]');
    if (s) { $('#ai-input').value = s.dataset.suggest; send(); }
  });
  window.addEventListener('ai-context', updateContext);
  renderMessages();
  updateContext();
}
