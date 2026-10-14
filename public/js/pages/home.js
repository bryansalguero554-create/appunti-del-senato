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

const DEFAULT_TILES = [['📚', '#0071e3'], ['🧠', '#bf5af2'], ['📐', '#ff9f0a'], ['🌍', '#30d158'], ['🧪', '#ff375f'], ['✏️', '#5e5ce6']];

function orbitScene(subjects) {
  const tiles = subjects.length >= 3
    ? subjects.slice(0, 8).map((s) => [s.icon, s.color])
    : DEFAULT_TILES;
  return `
    <div class="hero-scene" data-parallax aria-hidden="true">
      <div class="orbit-glow"></div>
      <div class="orbit">
        <div class="orbit-core">📖</div>
        <div class="orbit-ring">${tiles.map(([icon, color], i) => `
          <div class="orbit-tile" style="--a:${(360 / tiles.length) * i}deg;--c:${esc(color)}">${esc(icon)}</div>`).join('')}
        </div>
      </div>
    </div>`;
}

function greetingTitle(user) {
  const first = user.name.trim().split(/\s+/)[0];
  const hello = user.greeting === 'bentornato' ? 'Bentornato,' : 'Ciao';
  return `<span class="word" style="--w:0">${hello}</span> <span class="word name" style="--w:1">${esc(first)}.</span>`;
}

export async function renderHome(app) {
  const [{ subjects }, { notes }] = await Promise.all([api('/subjects'), api('/notes/recent')]);
  const returning = state.user.greeting === 'bentornato';
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="hero-eyebrow">${esc(today.charAt(0).toUpperCase() + today.slice(1))}</div>
        <h1 class="hero-title">${greetingTitle(state.user)}</h1>
        <p class="hero-sub">${returning ? 'Pronto a riprendere da dove avevi lasciato? Scegli la materia da studiare.' : 'Benvenuto. Scegli una materia e inizia a studiare con gli appunti di tutti.'}</p>
        <div class="row">
          ${subjects.length ? '<a class="btn btn-primary" href="#materie" id="go-subjects">Scegli la materia</a>' : ''}
          <a class="btn" href="#/quiz">Mettiti alla prova</a>
          ${isModerator() ? '<button class="btn btn-ghost" id="new-subject">＋ Nuova materia</button>' : ''}
        </div>
      </div>
      ${orbitScene(subjects)}
    </section>

    <div class="section-head" id="materie-anchor"><h2>Materie</h2></div>
    ${subjects.length ? `<div class="grid">${subjects.map((s) => `
      <a class="card subject-card tilt" href="#/materia/${s.id}" style="--accent:${esc(s.color)}">
        <span class="card-arrow" aria-hidden="true">›</span>
        <div class="subject-icon pop">${esc(s.icon)}</div>
        <h2 class="pop-sm">${esc(s.name)}</h2>
        ${s.description ? `<p class="muted small">${esc(s.description)}</p>` : ''}
        <div class="stats">
          <span>${s.topic_count} argomenti</span>
          <span>${s.note_count} appunti</span>
          <span>${s.quiz_count} quiz</span>
        </div>
        ${s.last_note_at ? `<div class="muted small" style="margin-top:6px">Ultimo appunto ${timeAgo(s.last_note_at)}</div>` : ''}
      </a>`).join('')}</div>`
    : emptyState('🗂️', isModerator() ? 'Non ci sono ancora materie. Crea la prima per iniziare!' : 'Non ci sono ancora materie: torna più tardi.')}

    ${notes.length ? `
    <div class="section">
      <div class="section-head"><h2>Appena caricati</h2></div>
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

  app.querySelector('#go-subjects')?.addEventListener('click', (e) => {
    e.preventDefault();
    app.querySelector('#materie-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  app.querySelector('#new-subject')?.addEventListener('click', () => {
    openModal('Nuova materia', subjectForm(), async (fd) => {
      const { subject } = await api('/subjects', { method: 'POST', body: Object.fromEntries(fd) });
      toast('Materia creata');
      location.hash = `#/materia/${subject.id}`;
    });
  });
}
