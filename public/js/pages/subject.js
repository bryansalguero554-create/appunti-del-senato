import {
  api, esc, timeAgo, fileType, emptyState, isModerator, openModal, confirmDialog, toast, setAiContext,
} from '../util.js';
import { subjectForm } from './home.js';

export function topicForm(topic = {}) {
  return `
    <form>
      <div class="field"><label>Nome dell'argomento / cartella</label><input name="name" required maxlength="100" value="${esc(topic.name || '')}" placeholder="Es. Modulo 1 – L'età moderna"></div>
      <div class="field"><label>Descrizione</label><textarea name="description" rows="3" maxlength="500" placeholder="Facoltativa">${esc(topic.description || '')}</textarea></div>
      <div class="modal-actions"><button class="btn btn-primary" type="submit">${topic.id ? 'Salva' : 'Crea argomento'}</button></div>
    </form>`;
}

export async function renderSubject(app, { params: [id] }) {
  const { subject, topics, quizzes } = await api(`/subjects/${id}`);
  setAiContext({ subjectId: subject.id, label: `${subject.icon} ${subject.name}` });

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <div class="breadcrumb"><a href="#/">Materie</a> ›</div>
        <h1>${esc(subject.icon)} ${esc(subject.name)}</h1>
        ${subject.description ? `<p class="muted">${esc(subject.description)}</p>` : ''}
      </div>
      <div class="row">
        ${isModerator() ? '<button class="btn" id="edit-subject">Modifica</button><button class="btn btn-danger" id="delete-subject">Elimina</button>' : ''}
        <button class="btn btn-primary" id="new-topic">＋ Nuovo argomento</button>
      </div>
    </div>

    ${topics.length ? `<div class="grid">${topics.map((t) => {
      const formats = (t.formats || '').split(',').filter(Boolean);
      return `
      <a class="card folder-card" href="#/argomento/${t.id}">
        <div class="folder-top">
          <span class="folder-icon">📁</span>
          <div style="min-width:0">
            <h3 style="margin:0">${esc(t.name)}</h3>
            <div class="muted small">${t.note_count} appunti · ${t.contributor_count} autori${t.quiz_count ? ` · ${t.quiz_count} quiz` : ''}</div>
          </div>
        </div>
        ${t.description ? `<p class="muted small" style="margin:0">${esc(t.description)}</p>` : ''}
        ${t.preview.length ? `<ul class="folder-preview">${t.preview.map((n) => `<li>${fileType(n.ext).icon} ${esc(n.title)}</li>`).join('')}</ul>` : '<p class="muted small" style="margin:8px 0 0">Cartella vuota: carica il primo appunto!</p>'}
        ${formats.length ? `<div class="badges">${formats.map((f) => `<span class="badge">${esc(f)}</span>`).join('')}</div>` : ''}
        ${t.last_note_at ? `<div class="muted small" style="margin-top:8px">Aggiornato ${timeAgo(t.last_note_at)}</div>` : ''}
      </a>`;
    }).join('')}</div>`
    : emptyState('📂', 'Nessun argomento in questa materia. Crea la prima cartella (es. "Modulo 1").')}

    <div class="section">
      <div class="section-head">
        <h2>Quiz di ${esc(subject.name)}</h2>
        <span class="spacer"></span>
        <a class="btn btn-sm" href="#/quiz/nuovo?materia=${subject.id}">＋ Crea quiz</a>
      </div>
      ${quizzes.length ? `<div class="list">${quizzes.map((q) => `
        <a class="list-item" href="#/quiz/${q.id}">
          <span style="font-size:1.4rem">✅</span>
          <div class="grow"><div class="title">${esc(q.title)}</div>
            <div class="muted small">${q.question_count} domande · di ${esc(q.author_name || '—')}</div></div>
          ${q.ai_generated ? '<span class="badge badge-ai">AI</span>' : ''}
        </a>`).join('')}</div>` : '<p class="muted">Ancora nessun quiz per questa materia.</p>'}
    </div>`;

  app.querySelector('#new-topic').addEventListener('click', () => {
    openModal('Nuovo argomento', topicForm(), async (fd) => {
      const { topic } = await api(`/subjects/${subject.id}/topics`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('Argomento creato');
      location.hash = `#/argomento/${topic.id}`;
    });
  });
  app.querySelector('#edit-subject')?.addEventListener('click', () => {
    openModal('Modifica materia', subjectForm(subject), async (fd) => {
      await api(`/subjects/${subject.id}`, { method: 'PATCH', body: Object.fromEntries(fd) });
      toast('Materia aggiornata');
      renderSubject(app, { params: [id] });
    });
  });
  app.querySelector('#delete-subject')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Eliminare "${subject.name}" con tutti i suoi argomenti, appunti e quiz?`, { confirmLabel: 'Elimina' }))) return;
    await api(`/subjects/${subject.id}`, { method: 'DELETE' });
    toast('Materia eliminata');
    location.hash = '#/';
  });
}
