// Chat con l'assistente di studio (Gemini o Claude, a seconda della configurazione del server).
import { state, $, esc, renderMarkdown, hasMath, ensureKatex, toast } from './util.js';

const STORE_KEY = 'ai-chat-v1';
let history = loadHistory();
let busy = false;
let controller = null;

function loadHistory() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((m) => !m.pending) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-40)));
  } catch { /* spazio esaurito o modalità privata */ }
}

/** Suggerimenti adatti alla pagina che lo studente sta guardando. */
function suggestions() {
  const ctx = state.aiContext;
  if (ctx?.noteId) {
    return [
      ['📝', 'Riassumi questo appunto in punti chiave'],
      ['💡', 'Spiegami i concetti più difficili di questo appunto con parole semplici'],
      ['🧠', 'Fammi 5 domande per verificare se ho capito questo appunto'],
      ['🗺️', 'Crea una mappa concettuale di questo appunto'],
    ];
  }
  if (ctx?.topicId) {
    return [
      ['📌', 'Quali sono i concetti fondamentali di questo argomento?'],
      ['⏱️', 'Fammi un ripasso veloce di questo argomento in 10 righe'],
      ['❓', 'Quali domande potrebbero chiedermi all\'interrogazione su questo argomento?'],
    ];
  }
  if (ctx?.subjectId) {
    return [
      ['🧭', 'Da dove mi conviene iniziare a studiare questa materia?'],
      ['📚', 'Dammi un metodo di studio efficace per questa materia'],
    ];
  }
  return [
    ['💬', 'Spiegami un concetto che non ho capito'],
    ['📐', 'Aiutami a risolvere un esercizio passo passo'],
    ['📅', 'Organizzami un piano di studio per la settimana'],
  ];
}

const drawer = () => $('#ai-drawer');

export function openAi(prefill) {
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  document.body.classList.add('ai-open');
  updateContext();
  renderMessages();
  if (prefill) {
    $('#ai-input').value = prefill;
    send();
  } else if (window.matchMedia('(pointer: fine)').matches) {
    $('#ai-input').focus();
  }
}

function closeAi() {
  drawer().classList.remove('open');
  drawer().setAttribute('aria-hidden', 'true');
  document.body.classList.remove('ai-open');
}

function updateContext() {
  const ctx = state.aiContext;
  $('#ai-context').textContent = ctx ? ctx.label : 'Domanda libera';
  $('#ai-attach-label').hidden = !ctx?.noteId;
  if (ctx?.noteTitle) $('#ai-attach-text').textContent = `Usa "${ctx.noteTitle}" come riferimento`;
  if (drawer().classList.contains('open') && !history.length) renderMessages();
}

function assistantHtml(m, i, isLast) {
  const actions = !m.pending && !m.error
    ? `<div class="msg-actions">
        <button type="button" data-copy="${i}" title="Copia">⧉ Copia</button>
        ${isLast ? '<button type="button" data-regen title="Rigenera la risposta">↻ Rigenera</button>' : ''}
      </div>`
    : m.error ? '<div class="msg-actions"><button type="button" data-retry>↻ Riprova</button></div>' : '';
  return `<div class="msg-row"><img class="msg-avatar" src="/icons/ai-64.png" alt="" aria-hidden="true">
    <div class="msg assistant ${m.error ? 'error' : ''} ${m.pending ? 'typing' : ''}">
    <div class="prose">${m.error ? esc(m.content) : renderMarkdown(m.content)}</div>${actions}</div></div>`;
}

function renderMessages() {
  const box = $('#ai-messages');
  if (!state.site.aiEnabled) {
    box.innerHTML = '<div class="msg assistant">L\'assistente AI non è ancora configurato. Il proprietario del sito deve impostare la chiave gratuita <code>GEMINI_API_KEY</code>.</div>';
    return;
  }
  if (!history.length) {
    const first = (state.user?.name || '').trim().split(/\s+/)[0];
    box.innerHTML = `
      <div class="ai-welcome">
        <img class="ai-icon ai-icon-xl" src="/icons/ai-256.png" alt="" aria-hidden="true">
        <h3>Ciao${first ? ` ${esc(first)}` : ''}, come posso aiutarti?</h3>
        <p class="muted small">${state.aiContext?.noteId ? 'Sto guardando l\'appunto che hai aperto: chiedimi qualsiasi cosa.' : 'Chiedimi di spiegarti un argomento, risolvere un esercizio o prepararti all\'interrogazione.'}</p>
      </div>
      <div class="ai-suggestions">${suggestions().map(([icon, text]) => `<button type="button" class="ai-chip" data-suggest="${esc(text)}"><span>${icon}</span>${esc(text)}</button>`).join('')}</div>`;
    return;
  }
  const lastAssistant = history.map((m) => m.role).lastIndexOf('assistant');
  box.innerHTML = history.map((m, i) => (m.role === 'user'
    ? `<div class="msg user">${esc(m.content)}</div>`
    : assistantHtml(m, i, i === lastAssistant))).join('');
  // le formule vengono disegnate appena KaTeX è pronto
  if (history.some((m) => m.role === 'assistant' && hasMath(m.content))) ensureKatex(renderMessages);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (nearBottom || busy) box.scrollTop = box.scrollHeight;
}

function setBusy(value) {
  busy = value;
  const btn = $('#ai-send');
  btn.classList.toggle('stop', value);
  btn.textContent = value ? '■' : '↑';
  btn.setAttribute('aria-label', value ? 'Ferma la risposta' : 'Invia');
}

function autosize() {
  const t = $('#ai-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

async function send(textOverride) {
  const input = $('#ai-input');
  const text = (textOverride ?? input.value).trim();
  if (!text || busy || !state.site.aiEnabled) return;
  input.value = '';
  autosize();
  history.push({ role: 'user', content: text });
  await ask();
}

/** Invia la conversazione e riceve la risposta in streaming. */
async function ask() {
  const reply = { role: 'assistant', content: '', pending: true };
  history.push(reply);
  setBusy(true);
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
      reply.content += reply.content ? '\n\n_(risposta interrotta)_' : '_(risposta interrotta)_';
    } else {
      reply.content = err.message === 'Failed to fetch' ? 'Connessione assente: controlla internet e riprova.' : err.message;
      reply.error = true;
      // la domanda resta visibile ma non viene reinviata come contesto finché non si riprova
      history[history.indexOf(reply) - 1].excluded = true;
    }
  } finally {
    reply.pending = false;
    controller = null;
    setBusy(false);
    saveHistory();
    renderMessages();
  }
}

/** Rigenera l'ultima risposta (o riprova dopo un errore). */
function regenerate() {
  if (busy) return;
  const lastUser = history.map((m) => m.role).lastIndexOf('user');
  if (lastUser < 0) return;
  history = history.slice(0, lastUser + 1);
  delete history[lastUser].excluded;
  ask();
}

export function initAi() {
  $('#ai-fab').addEventListener('click', () => (drawer().classList.contains('open') ? closeAi() : openAi()));
  $('#ai-close').addEventListener('click', closeAi);
  $('#ai-clear').addEventListener('click', () => {
    controller?.abort();
    history = [];
    saveHistory();
    renderMessages();
    $('#ai-input').focus();
  });
  $('#ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) controller?.abort();
    else send();
  });
  const input = $('#ai-input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      if (!busy) send();
    }
  });
  $('#ai-messages').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-suggest]');
    if (chip) return send(chip.dataset.suggest);
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(history[Number(copy.dataset.copy)].content);
        toast('Risposta copiata');
      } catch {
        toast('Copia non riuscita', 'error');
      }
      return undefined;
    }
    if (e.target.closest('[data-regen], [data-retry]')) regenerate();
    return undefined;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer().classList.contains('open')) closeAi(); });
  window.addEventListener('ai-context', updateContext);
  renderMessages();
  updateContext();
}
