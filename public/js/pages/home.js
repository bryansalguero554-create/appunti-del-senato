import { state, api, esc, timeAgo, fileType, emptyState, isModerator, openModal, toast, cap } from '../util.js';

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

function subjectTile(s) {
  return `
    <a class="card subject-tile tilt" data-tilt="9" href="#/materia/${s.id}" style="--accent:${esc(s.color)}" data-name="${esc(s.name.toLowerCase())}">
      <div class="subject-icon pop">${esc(s.icon)}</div>
      <h3 class="pop-sm">${esc(cap(s.name))}</h3>
      <p class="tile-desc">${esc(s.description || '')}</p>
      <div class="tile-stats"><span>${s.topic_count} argomenti</span><span>·</span><span>${s.note_count} appunti</span></div>
    </a>`;
}

export async function renderHome(app, { query } = {}) {
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
          <button class="btn btn-primary btn-lg" id="toggle-subjects" aria-expanded="false" aria-controls="subjects-panel">
            Le tue materie <span class="chev" aria-hidden="true">›</span>
          </button>
          <a class="btn btn-lg" href="#/quiz">Mettiti alla prova</a>
        </div>
      </div>
      ${orbitScene(subjects)}
    </section>

    <section class="subjects-panel" id="subjects-panel" hidden>
      <div class="section-head">
        <h2>Le tue materie <span class="muted" style="font-weight:500">${subjects.length}</span></h2>
        <span class="spacer"></span>
        ${subjects.length > 6 ? '<input type="search" class="panel-search" id="subject-filter" placeholder="Cerca una materia" aria-label="Cerca una materia">' : ''}
        ${isModerator() ? '<button class="btn btn-sm" id="new-subject">＋ Nuova materia</button>' : ''}
        <button class="icon-btn" id="close-subjects" aria-label="Chiudi">✕</button>
      </div>
      <div id="subjects-body"></div>
    </section>

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

  const panel = app.querySelector('#subjects-panel');
  const toggle = app.querySelector('#toggle-subjects');
  const bodyEl = app.querySelector('#subjects-body');

  function open(scroll = true) {
    // le card vengono inserite all'apertura, così l'animazione a cascata parte ogni volta
    bodyEl.innerHTML = subjects.length
      ? `<div class="subjects-grid">${subjects.map(subjectTile).join('')}</div><p class="muted small" id="no-match" hidden>Nessuna materia trovata.</p>`
      : emptyState('🗂️', isModerator() ? 'Non ci sono ancora materie. Crea la prima per iniziare!' : 'Non ci sono ancora materie: torna più tardi.');
    panel.hidden = false;
    panel.classList.remove('closing');
    panel.classList.add('opening');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
    if (scroll) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  function close() {
    panel.classList.remove('opening');
    panel.classList.add('closing');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
    setTimeout(() => { panel.hidden = true; panel.classList.remove('closing'); }, 380);
  }
  toggle.addEventListener('click', () => (panel.hidden ? open() : close()));
  app.querySelector('#close-subjects').addEventListener('click', () => {
    close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  app.querySelector('#subject-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let visible = 0;
    app.querySelectorAll('.subject-tile').forEach((t) => {
      t.hidden = Boolean(q) && !t.dataset.name.includes(q);
      if (!t.hidden) visible += 1;
    });
    app.querySelector('#no-match').hidden = visible > 0;
  });
  if (query?.get('materie') === '1') open(false);

  app.querySelector('#new-subject')?.addEventListener('click', () => {
    openModal('Nuova materia', subjectForm(), async (fd) => {
      const { subject } = await api('/subjects', { method: 'POST', body: Object.fromEntries(fd) });
      toast('Materia creata');
      location.hash = `#/materia/${subject.id}`;
    });
  });
}
