import { state, api, esc, timeAgo, fileType, emptyState, isModerator, openModal, toast } from '../util.js';

export function subjectForm(subject = {}) {
  return `
    <form>
      <div class="field"><label>Nome della materia</label><input name="name" required maxlength="80" value="${esc(subject.name || '')}" placeholder="Es. Storia"></div>
      <div class="field"><label>Descrizione</label><textarea name="description" rows="2" maxlength="500" placeholder="Facoltativa">${esc(subject.description || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Icona (emoji)</label><input name="icon" maxlength="8" value="${esc(subject.icon || '📚')}"></div>
        <div class="field"><label>Colore</label><input name="color" type="color" value="${esc(subject.color || '#4f46e5')}"></div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" type="submit">${subject.id ? 'Salva' : 'Crea materia'}</button></div>
    </form>`;
}

export async function renderHome(app) {
  const [{ subjects }, { notes }] = await Promise.all([api('/subjects'), api('/notes/recent')]);
  const first = state.user.name.split(' ')[0];

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <h1>Ciao ${esc(first)} 👋</h1>
        <p class="muted">Scegli la materia che vuoi studiare.</p>
      </div>
      ${isModerator() ? '<button class="btn btn-primary" id="new-subject">＋ Nuova materia</button>' : ''}
    </div>

    ${subjects.length ? `<div class="grid">${subjects.map((s) => `
      <a class="card subject-card" href="#/materia/${s.id}" style="--accent:${esc(s.color)}">
        <div class="subject-icon">${esc(s.icon)}</div>
        <h2>${esc(s.name)}</h2>
        ${s.description ? `<p class="muted small">${esc(s.description)}</p>` : ''}
        <div class="stats">
          <span>📁 ${s.topic_count} argomenti</span>
          <span>📄 ${s.note_count} appunti</span>
          <span>✅ ${s.quiz_count} quiz</span>
        </div>
        ${s.last_note_at ? `<div class="muted small" style="margin-top:6px">Ultimo appunto ${timeAgo(s.last_note_at)}</div>` : ''}
      </a>`).join('')}</div>`
    : emptyState('🗂️', isModerator() ? 'Non ci sono ancora materie. Crea la prima per iniziare!' : 'Non ci sono ancora materie: torna più tardi.')}

    ${notes.length ? `
    <div class="section">
      <div class="section-head"><h2>Ultimi appunti caricati</h2></div>
      <div class="list">${notes.map((n) => `
        <a class="list-item" href="#/appunto/${n.id}">
          <span style="font-size:1.6rem">${fileType(n.ext).icon}</span>
          <div class="grow">
            <div class="title">${esc(n.title)}</div>
            <div class="muted small">${esc(n.subject_icon)} ${esc(n.subject_name)} › ${esc(n.topic_name)} · ${esc(n.author_name || 'utente eliminato')}</div>
          </div>
          <span class="muted small">${timeAgo(n.created_at)}</span>
        </a>`).join('')}</div>
    </div>` : ''}`;

  app.querySelector('#new-subject')?.addEventListener('click', () => {
    openModal('Nuova materia', subjectForm(), async (fd) => {
      const { subject } = await api('/subjects', { method: 'POST', body: Object.fromEntries(fd) });
      toast('Materia creata');
      location.hash = `#/materia/${subject.id}`;
    });
  });
}
