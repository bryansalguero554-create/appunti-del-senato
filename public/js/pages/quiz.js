import {
  api, esc, timeAgo, emptyState, confirmDialog, toast, toastError, setAiContext, cap,
} from '../util.js';
import { openQuizGenerator } from '../quizgen.js';

// ---------- Elenco ----------

export async function renderQuizList(app) {
  const [{ quizzes }, { subjects }] = await Promise.all([api('/quizzes'), api('/subjects')]);
  let filter = 'all';

  app.innerHTML = `
    <div class="page-head">
      <div class="titles"><h1>✅ Quiz di verifica</h1><p class="muted">Scegli materia e argomento: l'AI prepara il quiz sui tuoi appunti.</p></div>
      <div class="row">
        <button class="btn btn-primary btn-lg" id="gen-quiz">✨ Genera un quiz</button>
      </div>
    </div>
    ${subjects.length > 1 ? `<div class="chips" id="subject-chips" style="margin-bottom:16px">
      <button class="chip active" data-s="all">Tutte le materie</button>
      ${subjects.map((s) => `<button class="chip" data-s="${s.id}">${esc(s.icon)} ${esc(cap(s.name))}</button>`).join('')}</div>` : ''}
    <div class="list" id="quiz-list"></div>`;

  const draw = () => {
    const list = quizzes.filter((q) => filter === 'all' || String(q.subject_id) === filter);
    app.querySelector('#quiz-list').innerHTML = list.map((q) => `
      <a class="list-item" href="#/quiz/${q.id}">
        <span style="font-size:1.6rem">${esc(q.subject_icon)}</span>
        <div class="grow">
          <div class="title">${esc(q.title)}</div>
          <div class="muted small">${esc(q.subject_name)}${q.topic_name ? ` › ${esc(q.topic_name)}` : ''} · ${q.question_count} domande · di ${esc(q.author_name || '—')} · ${timeAgo(q.created_at)}</div>
        </div>
        ${q.ai_generated ? '<span class="badge badge-ai">AI</span>' : ''}
        ${q.best !== null ? `<span class="badge ${q.best >= 0.6 ? 'badge-online' : ''}">Record ${Math.round(q.best * 100)}%</span>` : ''}
      </a>`).join('') || emptyState('📝', 'Nessun quiz ancora: fattene preparare uno dall\'AI!');
  };
  draw();
  app.querySelector('#gen-quiz').addEventListener('click', () => openQuizGenerator({ subjectId: filter === 'all' ? null : Number(filter) }));
  app.querySelector('#subject-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.s;
    app.querySelectorAll('#subject-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    draw();
  });
}

// ---------- Svolgimento ----------

export async function renderQuizTake(app, { params: [id] }) {
  const { quiz, questions, leaderboard } = await api(`/quizzes/${id}`);
  setAiContext({ subjectId: quiz.subject_id, topicId: quiz.topic_id, label: `${quiz.subject_name}${quiz.topic_name ? ` › ${quiz.topic_name}` : ''}` });

  app.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <div class="breadcrumb"><a href="#/quiz">Quiz</a> › <a href="#/materia/${quiz.subject_id}">${esc(quiz.subject_name)}</a>${quiz.topic_id ? ` › <a href="#/argomento/${quiz.topic_id}">${esc(quiz.topic_name)}</a>` : ''}</div>
        <h1>${esc(quiz.title)} ${quiz.ai_generated ? '<span class="badge badge-ai">AI</span>' : ''}</h1>
        ${quiz.description ? `<p class="muted">${esc(quiz.description)}</p>` : ''}
        <p class="muted small">${questions.length} domande · creato da ${esc(quiz.author_name || '—')}</p>
      </div>
      ${quiz.canManage ? `<div class="row"><a class="btn" href="#/quiz/${quiz.id}/modifica">✏️ Modifica</a><button class="btn btn-danger" id="delete-quiz">Elimina</button></div>` : ''}
    </div>
    <div class="viewer-layout">
      <form id="quiz-form">
        ${questions.map((q, i) => `
          <div class="card question" data-q="${q.id}">
            <div class="question-num">Domanda ${i + 1} di ${questions.length}</div>
            <div class="question-text">${esc(q.question)}</div>
            ${q.options.map((o, j) => `<label class="option" data-o="${j}"><input type="radio" name="q${q.id}" value="${j}"> <span>${esc(o)}</span></label>`).join('')}
            <div class="explanation" hidden></div>
          </div>`).join('')}
        <div class="row"><span class="spacer"></span><button class="btn btn-primary" type="submit" id="submit-quiz">Consegna e correggi</button></div>
      </form>
      <aside class="stack">
        <div class="card score-card" id="score-card" hidden></div>
        <div class="card">
          <h3>🏆 Classifica</h3>
          ${leaderboard.length ? `<ol style="padding-left:1.2rem;margin:0">${leaderboard.map((l) => `<li>${esc(l.name)} – <strong>${l.score}/${l.total}</strong></li>`).join('')}</ol>` : '<p class="muted small">Nessun tentativo ancora: sii il primo!</p>'}
        </div>
      </aside>
    </div>`;

  const form = app.querySelector('#quiz-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const answers = {};
    for (const q of questions) {
      const checked = form.querySelector(`input[name="q${q.id}"]:checked`);
      if (checked) answers[q.id] = Number(checked.value);
    }
    const missing = questions.length - Object.keys(answers).length;
    if (missing && !(await confirmDialog(`Non hai risposto a ${missing} domand${missing === 1 ? 'a' : 'e'}. Consegnare comunque?`, { confirmLabel: 'Consegna', danger: false }))) return;
    try {
      const result = await api(`/quizzes/${quiz.id}/submit`, { method: 'POST', body: { answers } });
      for (const r of result.results) {
        const card = form.querySelector(`[data-q="${r.id}"]`);
        card.querySelectorAll('input').forEach((i) => { i.disabled = true; });
        card.querySelector(`[data-o="${r.correct_index}"]`).classList.add('correct');
        if (r.given !== null && !r.correct) card.querySelector(`[data-o="${r.given}"]`)?.classList.add('wrong');
        const exp = card.querySelector('.explanation');
        exp.innerHTML = `${r.correct ? '✅ Corretto!' : r.given === null ? '⚪ Non risposta.' : '❌ Sbagliato.'} ${esc(r.explanation)}`;
        exp.hidden = false;
      }
      const pct = Math.round((result.score / Math.max(result.total, 1)) * 100);
      const sc = app.querySelector('#score-card');
      sc.innerHTML = `<div class="muted">Il tuo punteggio</div><div class="score-big">${result.score}/${result.total}</div>
        <p>${pct}% – ${pct >= 90 ? 'Eccellente! 🏆' : pct >= 70 ? 'Ottimo lavoro! 💪' : pct >= 50 ? 'Ci sei quasi, ripassa gli errori 📚' : 'Meglio ripassare l\'argomento 📖'}</p>
        <div class="row" style="justify-content:center"><button class="btn" id="retry">🔄 Riprova</button>
        <button class="btn btn-primary" id="new-quiz">✨ Nuovo quiz</button></div>`;
      sc.hidden = false;
      sc.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sc.querySelector('#retry').addEventListener('click', () => renderQuizTake(app, { params: [id] }));
      sc.querySelector('#new-quiz').addEventListener('click', () => openQuizGenerator({ subjectId: quiz.subject_id, topicId: quiz.topic_id }));
      app.querySelector('#submit-quiz').hidden = true;
    } catch (err) {
      toastError(err);
    }
  });

  app.querySelector('#delete-quiz')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Eliminare il quiz "${quiz.title}"?`, { confirmLabel: 'Elimina' }))) return;
    await api(`/quizzes/${quiz.id}`, { method: 'DELETE' });
    toast('Quiz eliminato');
    location.hash = '#/quiz';
  });
}

// ---------- Editor (manuale o generato con AI) ----------

const blankQuestion = () => ({ question: '', options: ['', '', '', ''], correct_index: 0, explanation: '' });

export async function renderQuizEditor(app, { params: [quizId], query, isStale }) {
  // I quiz nuovi si creano solo con l'AI: "#/quiz/nuovo" apre il generatore.
  if (!quizId) {
    await renderQuizList(app);
    openQuizGenerator({
      subjectId: Number(query.get('materia')) || null,
      topicId: Number(query.get('argomento')) || null,
      noteId: Number(query.get('appunto')) || null,
    });
    return;
  }
  const { subjects } = await api('/subjects');
  const data = await api(`/quizzes/${quizId}?edit=1`);
  if (!data.quiz.canManage) throw new Error('Non puoi modificare questo quiz.');
  let draft = { ...data.quiz, questions: data.questions.map((q) => ({ ...q })) };
  if (isStale()) return;

  app.innerHTML = `
    <div class="page-head">
      <div class="titles"><div class="breadcrumb"><a href="#/quiz">Quiz</a> ›</div><h1>Modifica quiz</h1></div>
    </div>


    <form id="editor">
      <div class="card" style="margin-bottom:20px">
        <div class="field"><label>Titolo</label><input name="title" required maxlength="150" value="${esc(draft.title)}" placeholder="Es. Verifica Modulo 1"></div>
        <div class="field"><label>Descrizione</label><input name="description" maxlength="1000" value="${esc(draft.description)}" placeholder="Facoltativa"></div>
        <div class="field-row">
          <div class="field"><label>Materia</label><select name="subject_id" id="subject-select" ${quizId ? 'disabled' : ''}>
            ${subjects.map((s) => `<option value="${s.id}" ${s.id === draft.subject_id ? 'selected' : ''}>${esc(s.icon)} ${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Argomento</label><select name="topic_id" id="topic-select" ${quizId ? 'disabled' : ''}></select></div>
        </div>
      </div>
      <div id="questions"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" type="button" id="add-question">＋ Aggiungi domanda</button>
        <span class="spacer"></span>
        <a class="btn" href="#/quiz">Annulla</a>
        <button class="btn btn-primary" type="submit">💾 Salva quiz</button>
      </div>
    </form>`;

  const qBox = app.querySelector('#questions');
  const subjectSel = app.querySelector('#subject-select');
  const topicSel = app.querySelector('#topic-select');

  async function loadTopics() {
    topicSel.innerHTML = '<option value="">Caricamento…</option>';
    const { topics } = await api(`/subjects/${subjectSel.value}`);
    topicSel.innerHTML = `<option value="">— Tutta la materia —</option>${topics.map((t) => `<option value="${t.id}" ${t.id === draft.topic_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  }
  subjectSel.addEventListener('change', () => { draft.topic_id = null; loadTopics(); });
  topicSel.addEventListener('change', () => { draft.topic_id = Number(topicSel.value) || null; });
  await loadTopics();

  // Sincronizza i campi del DOM nel modello prima di ridisegnare
  function collect() {
    qBox.querySelectorAll('[data-qi]').forEach((card) => {
      const q = draft.questions[Number(card.dataset.qi)];
      q.question = card.querySelector('[data-f="question"]').value;
      q.explanation = card.querySelector('[data-f="explanation"]').value;
      q.options = [...card.querySelectorAll('[data-f="option"]')].map((i) => i.value);
      const checked = card.querySelector('input[type="radio"]:checked');
      q.correct_index = checked ? Number(checked.value) : 0;
    });
  }

  function drawQuestions() {
    qBox.innerHTML = draft.questions.map((q, i) => `
      <div class="card question editor-question" data-qi="${i}">
        <div class="row"><span class="question-num">Domanda ${i + 1}</span><span class="spacer"></span>
          <button type="button" class="btn btn-sm btn-danger" data-act="remove-q" ${draft.questions.length === 1 ? 'disabled' : ''}>Rimuovi</button></div>
        <div class="field" style="margin-top:8px"><textarea data-f="question" rows="2" required maxlength="1000" placeholder="Testo della domanda">${esc(q.question)}</textarea></div>
        <label class="muted small">Risposte (seleziona quella corretta)</label>
        ${q.options.map((o, j) => `
          <div class="editor-option">
            <input type="radio" name="correct-${i}" value="${j}" ${j === q.correct_index ? 'checked' : ''} aria-label="Risposta corretta">
            <input type="text" data-f="option" maxlength="400" value="${esc(o)}" placeholder="Risposta ${j + 1}">
            <button type="button" class="icon-btn" data-act="remove-o" data-o="${j}" ${q.options.length <= 2 ? 'disabled' : ''} aria-label="Rimuovi risposta">✕</button>
          </div>`).join('')}
        ${q.options.length < 6 ? '<button type="button" class="btn btn-sm" data-act="add-o">＋ Risposta</button>' : ''}
        <div class="field" style="margin-top:10px"><input data-f="explanation" maxlength="1500" value="${esc(q.explanation)}" placeholder="Spiegazione della risposta corretta (facoltativa)"></div>
      </div>`).join('');
  }
  drawQuestions();

  qBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    collect();
    const qi = Number(btn.closest('[data-qi]').dataset.qi);
    const q = draft.questions[qi];
    if (btn.dataset.act === 'remove-q') draft.questions.splice(qi, 1);
    if (btn.dataset.act === 'add-o') q.options.push('');
    if (btn.dataset.act === 'remove-o') {
      const oi = Number(btn.dataset.o);
      q.options.splice(oi, 1);
      if (q.correct_index >= q.options.length || q.correct_index === oi) q.correct_index = 0;
      else if (q.correct_index > oi) q.correct_index -= 1;
    }
    drawQuestions();
  });
  app.querySelector('#add-question').addEventListener('click', () => {
    collect();
    draft.questions.push(blankQuestion());
    drawQuestions();
    qBox.lastElementChild.scrollIntoView({ behavior: 'smooth' });
  });

  app.querySelector('#editor').addEventListener('submit', async (e) => {
    e.preventDefault();
    collect();
    const fd = new FormData(e.target);
    const body = {
      title: fd.get('title'),
      description: fd.get('description'),
      subject_id: Number(subjectSel.value),
      topic_id: Number(topicSel.value) || null,
      ai_generated: draft.ai_generated,
      questions: draft.questions.map((q) => ({ ...q, options: q.options.map((o) => o.trim()) })),
    };
    for (const [i, q] of body.questions.entries()) {
      if (q.options.some((o) => !o)) return toast(`Domanda ${i + 1}: compila tutte le risposte o rimuovi quelle vuote.`, 'error');
    }
    try {
      if (quizId) {
        await api(`/quizzes/${quizId}`, { method: 'PUT', body });
        toast('Quiz aggiornato');
        location.hash = `#/quiz/${quizId}`;
      } else {
        const { id } = await api('/quizzes', { method: 'POST', body });
        toast('Quiz creato!');
        location.hash = `#/quiz/${id}`;
      }
    } catch (err) {
      toastError(err);
    }
  });
}
