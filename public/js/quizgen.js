// Generatore di quiz con l'AI: è l'unico modo per creare un quiz sul sito.
import { state, api, esc, openModal, closeModal, toast, toastError, isOwner, cap } from './util.js';

const HINTS = [
  'Sto leggendo gli appunti…',
  'Scelgo i concetti più importanti…',
  'Scrivo le domande e le risposte…',
  'Preparo le spiegazioni…',
  'Ultimi ritocchi…',
];

function unavailable() {
  openModal('Generazione quiz non attiva', `
    <div style="text-align:center">
      <div style="font-size:2.6rem;margin-bottom:8px">🤖</div>
      <p>I quiz vengono creati dall'intelligenza artificiale, che non è ancora attiva su questo sito.</p>
      ${isOwner()
        ? '<p class="muted small">Per attivarla aggiungi su Render la variabile <code>GEMINI_API_KEY</code> con la chiave gratuita di <strong>aistudio.google.com</strong>, poi salva e attendi il riavvio.</p>'
        : '<p class="muted small">Riprova più tardi: il gestore del sito la sta configurando.</p>'}
      <div class="modal-actions" style="justify-content:center"><button class="btn btn-primary" type="button" id="qg-ok">Ho capito</button></div>
    </div>`);
  document.querySelector('#qg-ok').addEventListener('click', closeModal);
}

/**
 * Apre il generatore. Opzioni: subjectId, topicId (facoltativi, preselezionati),
 * noteId + noteTitle (quiz su un singolo appunto).
 */
export async function openQuizGenerator({ subjectId = null, topicId = null, noteId = null, noteTitle = '' } = {}) {
  if (!state.site.aiEnabled) return unavailable();
  let subjects = [];
  if (!noteId) {
    try {
      ({ subjects } = await api('/subjects'));
    } catch (err) {
      return toastError(err);
    }
    if (!subjects.length) return toast('Non ci sono ancora materie.', 'error');
  }
  const counts = [5, 10, 15, 20];

  const body = openModal('✨ Genera un quiz con l\'AI', `
    <form id="qg-form">
      ${noteId ? `<p class="muted">L'AI preparerà le domande leggendo l'appunto <strong>${esc(noteTitle)}</strong>.</p>` : `
      <div class="field"><label>Materia</label>
        <select name="subjectId" id="qg-subject">${subjects.map((s) => `<option value="${s.id}" ${s.id === Number(subjectId) ? 'selected' : ''}>${esc(s.icon)} ${esc(cap(s.name))}</option>`).join('')}</select></div>
      <div class="field"><label>Argomento</label>
        <select name="topicId" id="qg-topic"><option value="">Tutta la materia</option></select></div>`}
      <div class="field"><label>Numero di domande</label>
        <div class="seg">${counts.map((n) => `<label><input type="radio" name="count" value="${n}" ${n === 10 ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
      <div class="field"><label>Difficoltà</label>
        <div class="seg">${[['facile', 'Facile'], ['media', 'Media'], ['difficile', 'Difficile']].map(([v, l]) => `<label><input type="radio" name="difficulty" value="${v}" ${v === 'media' ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>Indicazioni per l'AI <span class="muted">(facoltative)</span></label>
        <input name="instructions" maxlength="1000" placeholder="Es. concentrati sulle date e sui personaggi"></div>
      <div class="qg-loading" id="qg-loading" hidden>
        <div class="qg-orb"></div>
        <p id="qg-hint">${HINTS[0]}</p>
        <p class="muted small">Può richiedere fino a un minuto.</p>
      </div>
      <div class="modal-actions" id="qg-actions"><button class="btn btn-primary btn-lg" type="submit" style="width:100%">✨ Genera quiz</button></div>
    </form>`);

  const subjectSel = body.querySelector('#qg-subject');
  const topicSel = body.querySelector('#qg-topic');
  async function loadTopics() {
    if (!subjectSel) return;
    topicSel.innerHTML = '<option value="">Tutta la materia</option>';
    try {
      const { topics } = await api(`/subjects/${subjectSel.value}`);
      topicSel.innerHTML += topics.map((t) => `<option value="${t.id}" ${t.id === Number(topicId) ? 'selected' : ''}>${esc(t.name)}${t.note_count ? ` (${t.note_count} appunti)` : ''}</option>`).join('');
    } catch {
      // resta "Tutta la materia"
    }
  }
  subjectSel?.addEventListener('change', () => { topicId = null; loadTopics(); });
  loadTopics();

  body.querySelector('#qg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const loading = body.querySelector('#qg-loading');
    const actions = body.querySelector('#qg-actions');
    const fields = body.querySelectorAll('.field');
    fields.forEach((f) => { f.hidden = true; });
    actions.hidden = true;
    loading.hidden = false;
    let i = 0;
    const timer = setInterval(() => {
      i = Math.min(i + 1, HINTS.length - 1);
      const hint = body.querySelector('#qg-hint');
      if (hint) hint.textContent = HINTS[i];
    }, 6000);
    try {
      const { id } = await api('/ai/quiz', {
        method: 'POST',
        body: {
          noteId: noteId || undefined,
          subjectId: noteId ? undefined : Number(fd.get('subjectId')),
          topicId: noteId ? undefined : (Number(fd.get('topicId')) || undefined),
          count: Number(fd.get('count')),
          difficulty: fd.get('difficulty'),
          instructions: fd.get('instructions'),
        },
      });
      clearInterval(timer);
      closeModal();
      toast('Quiz pronto! In bocca al lupo 🍀');
      location.hash = `#/quiz/${id}`;
    } catch (err) {
      clearInterval(timer);
      toastError(err);
      fields.forEach((f) => { f.hidden = false; });
      actions.hidden = false;
      loading.hidden = true;
    }
  });
}
