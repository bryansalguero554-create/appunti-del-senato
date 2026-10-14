// Creazione di una mappa concettuale per l'interrogazione con l'AI, a partire da un appunto.
import { state, api, esc, openModal, closeModal, toast, toastError } from './util.js';

const HINTS = [
  'Sto leggendo l\'appunto…',
  'Trovo i concetti chiave…',
  'Collego cause, fatti e conseguenze…',
  'Disegno i rami della mappa…',
  'Ultimi ritocchi…',
];

export function openMapGenerator({ noteId, noteTitle }) {
  if (!state.site.aiEnabled) return toast('L\'assistente AI non è ancora attivo su questo sito.', 'error');
  const body = openModal('🗺️ Mappa per l\'interrogazione', `
    <form id="mg-form">
      <p class="muted">L'IA leggerà <strong>${esc(noteTitle)}</strong> e preparerà una mappa concettuale da ripassare.
        Potrai modificarla (anche chiedendolo all'IA) e scaricarla.</p>
      <div class="field"><label>Su cosa concentrarsi? <span class="muted">(facoltativo)</span></label>
        <input name="instructions" maxlength="1000" placeholder="Es. date e personaggi, oppure solo il capitolo 2"></div>
      <div class="qg-loading" id="mg-loading" hidden>
        <div class="qg-orb"></div>
        <p id="mg-hint">${HINTS[0]}</p>
        <p class="muted small">Può richiedere fino a un minuto.</p>
      </div>
      <div class="modal-actions" id="mg-actions"><button class="btn btn-primary btn-lg" type="submit" style="width:100%">🗺️ Crea la mappa</button></div>
    </form>`);

  body.querySelector('#mg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const fields = body.querySelectorAll('.field, form > p');
    const actions = body.querySelector('#mg-actions');
    const loading = body.querySelector('#mg-loading');
    fields.forEach((f) => { f.hidden = true; });
    actions.hidden = true;
    loading.hidden = false;
    let i = 0;
    const timer = setInterval(() => {
      i = Math.min(i + 1, HINTS.length - 1);
      const hint = body.querySelector('#mg-hint');
      if (hint) hint.textContent = HINTS[i];
    }, 5000);
    try {
      const { id } = await api('/ai/map', { method: 'POST', body: { noteId, instructions: fd.get('instructions') } });
      clearInterval(timer);
      closeModal();
      toast('Mappa pronta 🗺️');
      location.hash = `#/mappa/${id}`;
    } catch (err) {
      clearInterval(timer);
      toastError(err);
      fields.forEach((f) => { f.hidden = false; });
      actions.hidden = false;
      loading.hidden = true;
    }
  });
}
