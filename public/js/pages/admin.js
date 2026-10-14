import {
  state, api, esc, timeAgo, formatDate, formatDuration, formatBytes, toast, toastError, confirmDialog,
  openModal, roleBadge, fileType, spinner,
} from '../util.js';
import { deviceName } from './profile.js';
import { subjectForm } from './home.js';

// Area privata del proprietario: panoramica, utenti online in tempo reale, sessioni, utenti, contenuti, impostazioni.

const TABS = [
  ['overview', '📊 Panoramica'],
  ['online', '🟢 Online ora'],
  ['sessions', '🔐 Sessioni'],
  ['users', '👥 Utenti'],
  ['content', '🗂️ Contenuti'],
  ['drive', '☁️ Google Drive'],
  ['settings', '⚙️ Impostazioni'],
];

let liveTimer = null;
window.addEventListener('route-change', () => {
  clearInterval(liveTimer);
  liveTimer = null;
});

export async function renderAdmin(app, { query }) {
  if (state.user.role !== 'owner') throw new Error('Area riservata al proprietario del sito.');
  const active = TABS.some(([k]) => k === query.get('tab')) ? query.get('tab') : 'overview';

  app.innerHTML = `
    <div class="page-head"><div class="titles"><h1>👑 Area riservata</h1>
      <p class="muted">Gestione completa del sito: visitatori in tempo reale, sessioni, utenti e contenuti.</p></div></div>
    <div class="tabs">${TABS.map(([k, label]) => `<a class="tab ${k === active ? 'active' : ''}" href="#/admin?tab=${k}">${label}</a>`).join('')}</div>
    <div id="tab-body">${spinner()}</div>`;

  const body = app.querySelector('#tab-body');
  const views = { overview, online, sessions, users, content, drive, settings };
  await views[active](body, query);
}

// ---------- Panoramica ----------

function bars(series) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    days.push(d.toISOString().slice(0, 10));
  }
  const map = new Map(series.map((r) => [r.day, r.n]));
  const max = Math.max(1, ...days.map((d) => map.get(d) || 0));
  return `<div class="bars">${days.map((d, i) => {
    const n = map.get(d) || 0;
    return `<div class="bar" style="height:${(n / max) * 100}%;--i:${i}" title="${d}: ${n}">${n ? `<span>${n}</span>` : ''}</div>`;
  }).join('')}</div>
  <div class="bars-labels">${days.map((d, i) => `<span>${i % 2 ? '' : d.slice(8)}</span>`).join('')}</div>`;
}

async function overview(body) {
  const s = await api('/admin/stats');
  const stat = (value, label) => `<div class="card stat tilt" data-tilt="8"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  body.innerHTML = `
    <div class="stat-grid">
      ${stat(`<span class="live-dot"></span>${s.onlineUsers}`, `utenti online ora${s.onlineGuests ? ` (+${s.onlineGuests} ospiti)` : ''}`)}
      ${stat(s.users, 'utenti registrati')}
      ${stat(s.activeSessions, 'sessioni attive')}
      ${stat(s.subjects, 'materie')}
      ${stat(s.topics, 'argomenti')}
      ${stat(s.notes, 'appunti caricati')}
      ${stat(formatBytes(s.storageBytes), 'spazio occupato')}
      ${stat(s.quizzes, 'quiz')}
      ${stat(s.attempts, 'quiz svolti')}
      ${stat(s.aiEnabled ? s.aiToday : 'off', 'richieste AI (24h)')}
    </div>
    <div class="grid section" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card"><h3>Appunti caricati (14 giorni)</h3>${bars(s.uploadsPerDay)}</div>
      <div class="card"><h3>Nuove iscrizioni (14 giorni)</h3>${bars(s.signupsPerDay)}</div>
      <div class="card"><h3>🏅 Chi carica di più</h3>${s.topContributors.length
        ? `<ol style="padding-left:1.2rem;margin:0">${s.topContributors.map((c) => `<li>${esc(c.name)} – <strong>${c.n}</strong> appunti</li>`).join('')}</ol>`
        : '<p class="muted">Nessun appunto ancora.</p>'}</div>
    </div>
    ${s.aiEnabled ? '' : '<div class="card section"><strong>🤖 Assistente AI disattivato.</strong> <span class="muted">Aggiungi la chiave gratuita <code>GEMINI_API_KEY</code> (da aistudio.google.com) nelle impostazioni del server per attivarlo.</span></div>'}`;
}

// ---------- Online ora (aggiornamento automatico) ----------

async function online(body) {
  body.innerHTML = `
    <div class="section-head"><h2><span class="live-dot"></span>Chi sta visitando il sito adesso</h2><span class="spacer"></span>
      <span class="muted small" id="live-updated"></span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Visitatore</th><th>Pagina</th><th>Dispositivo</th><th>IP</th><th>Sul sito da</th><th>Ultimo segnale</th><th></th></tr></thead>
      <tbody id="live-rows"></tbody></table></div>
    <p class="muted small" style="margin-top:8px">La lista si aggiorna ogni 5 secondi. Un visitatore risulta online se ha una pagina aperta e attiva nell'ultimo minuto.</p>`;

  const tbody = body.querySelector('#live-rows');
  async function refresh() {
    try {
      const { visitors, now } = await api('/admin/online');
      tbody.innerHTML = visitors.map((v) => `
        <tr>
          <td>${v.userId ? `<strong>${esc(v.name)}</strong> ${roleBadge(v.role)}<div class="muted small">${esc(v.email)}</div>` : '<span class="muted">Ospite (non connesso)</span>'}</td>
          <td><a href="${esc(v.path)}">${esc(v.title || v.path)}</a><div class="muted small">da ${formatDuration(now - v.pageSince)}</div></td>
          <td>${deviceName(v.userAgent)}</td>
          <td>${esc(v.ip)}</td>
          <td>${formatDuration(now - v.since)}</td>
          <td>${formatDuration(now - v.lastSeen)} fa</td>
          <td class="actions">${v.sessionId && v.sessionId !== undefined && v.userId !== state.user.id
            ? `<button class="btn btn-sm btn-danger" data-kick="${v.sessionId}">Disconnetti</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">Nessun visitatore online in questo momento.</td></tr>';
      body.querySelector('#live-updated').textContent = `Aggiornato alle ${new Date().toLocaleTimeString('it-IT')}`;
    } catch (err) {
      if (err.status === 401 || err.status === 403) clearInterval(liveTimer);
    }
  }
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kick]');
    if (!btn || !(await confirmDialog('Chiudere la sessione di questo utente? Dovrà accedere di nuovo.', { confirmLabel: 'Disconnetti' }))) return;
    await api(`/admin/sessions/${btn.dataset.kick}`, { method: 'DELETE' });
    toast('Sessione chiusa');
    refresh();
  });
  await refresh();
  clearInterval(liveTimer);
  liveTimer = setInterval(refresh, 5000);
}

// ---------- Sessioni ----------

async function sessions(body) {
  const { sessions: list } = await api('/admin/sessions');
  body.innerHTML = `
    <div class="section-head"><h2>Sessioni attive (${list.length})</h2><span class="spacer"></span>
      <button class="btn btn-danger" id="revoke-all">Disconnetti tutti tranne me</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Utente</th><th>Stato</th><th>Dispositivo</th><th>IP</th><th>Accesso</th><th>Ultima attività</th><th>Scadenza</th><th></th></tr></thead>
      <tbody>${list.map((s) => `
        <tr>
          <td><strong>${esc(s.name)}</strong> ${roleBadge(s.role)}<div class="muted small">${esc(s.email)}</div></td>
          <td>${s.online ? `<span class="badge badge-online">online</span><div class="muted small">${esc(s.page || '')}</div>` : '<span class="muted small">inattiva</span>'}</td>
          <td>${deviceName(s.user_agent)}</td>
          <td>${esc(s.ip || '—')}</td>
          <td>${formatDate(s.created_at)}</td>
          <td>${timeAgo(s.last_seen_at)}</td>
          <td>${formatDate(s.expires_at)}</td>
          <td class="actions">${s.current ? '<span class="badge">questa</span>' : `<button class="btn btn-sm btn-danger" data-revoke="${s.id}">Chiudi</button>`}</td>
        </tr>`).join('')}</tbody></table></div>`;

  body.querySelector('tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    await api(`/admin/sessions/${btn.dataset.revoke}`, { method: 'DELETE' });
    toast('Sessione chiusa');
    sessions(body);
  });
  body.querySelector('#revoke-all').addEventListener('click', async () => {
    if (!(await confirmDialog('Disconnettere tutti gli utenti (tranne la tua sessione attuale)?', { confirmLabel: 'Disconnetti tutti' }))) return;
    const r = await api('/admin/sessions/revoke-all', { method: 'POST' });
    toast(`${r.revoked} sessioni chiuse`);
    sessions(body);
  });
}

// ---------- Utenti ----------

async function users(body) {
  const { users: list } = await api('/admin/users');
  body.innerHTML = `
    <div class="section-head"><h2>Utenti (${list.length})</h2><span class="spacer"></span>
      <input type="search" id="user-filter" placeholder="Filtra per nome o email" style="max-width:260px"></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Utente</th><th>Ruolo</th><th>Contenuti</th><th>Iscritto</th><th>Ultimo accesso</th><th></th></tr></thead>
      <tbody>${list.map((u) => `
        <tr data-user="${u.id}" data-search="${esc(`${u.name} ${u.email}`.toLowerCase())}">
          <td><strong>${esc(u.name)}</strong> ${u.online ? '<span class="badge badge-online">online</span>' : ''} ${u.banned ? '<span class="badge badge-banned">sospeso</span>' : ''}
            <div class="muted small">${esc(u.email)}</div></td>
          <td>${u.role === 'owner' ? roleBadge('owner') : `<select data-role>
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>Utente</option>
              <option value="moderator" ${u.role === 'moderator' ? 'selected' : ''}>Moderatore</option></select>`}</td>
          <td class="small">${u.note_count} appunti · ${u.quiz_count} quiz<div class="muted">${u.session_count} sessioni</div></td>
          <td class="small">${formatDate(u.created_at)}</td>
          <td class="small">${u.last_login_at ? timeAgo(u.last_login_at) : '—'}</td>
          <td class="actions">${u.role === 'owner' ? '' : `
            <button class="btn btn-sm" data-act="logout" title="Chiudi tutte le sessioni">Disconnetti</button>
            <button class="btn btn-sm" data-act="password">Password</button>
            <button class="btn btn-sm ${u.banned ? '' : 'btn-danger'}" data-act="ban" data-banned="${u.banned}">${u.banned ? 'Riattiva' : 'Sospendi'}</button>
            <button class="btn btn-sm btn-danger" data-act="delete">Elimina</button>`}</td>
        </tr>`).join('')}</tbody></table></div>
    <p class="muted small" style="margin-top:8px">I <strong>moderatori</strong> possono creare e modificare materie ed eliminare qualsiasi appunto o quiz, ma non accedono a quest'area.</p>`;

  body.querySelector('#user-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    body.querySelectorAll('tr[data-user]').forEach((tr) => { tr.hidden = !tr.dataset.search.includes(q); });
  });
  body.querySelector('tbody').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-role]')) return;
    const id = e.target.closest('tr').dataset.user;
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: { role: e.target.value } });
      toast('Ruolo aggiornato');
    } catch (err) {
      toastError(err);
    }
  });
  body.querySelector('tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.user;
    const user = list.find((u) => String(u.id) === id);
    try {
      if (btn.dataset.act === 'logout') {
        await api(`/admin/users/${id}/logout`, { method: 'POST' });
        toast(`${user.name} è stato disconnesso`);
      } else if (btn.dataset.act === 'ban') {
        const banned = btn.dataset.banned !== '1';
        if (banned && !(await confirmDialog(`Sospendere ${user.name}? Non potrà più accedere.`, { confirmLabel: 'Sospendi' }))) return;
        await api(`/admin/users/${id}`, { method: 'PATCH', body: { banned } });
        toast(banned ? 'Utente sospeso' : 'Utente riattivato');
      } else if (btn.dataset.act === 'password') {
        openModal(`Nuova password per ${user.name}`, `
          <form><div class="field"><label>Nuova password</label><input name="password" type="text" minlength="8" required autocomplete="off"></div>
          <p class="muted small">Comunica la nuova password all'utente: tutte le sue sessioni verranno chiuse.</p>
          <div class="modal-actions"><button class="btn btn-primary" type="submit">Imposta</button></div></form>`, async (fd) => {
          await api(`/admin/users/${id}/password`, { method: 'POST', body: { password: fd.get('password') } });
          toast('Password reimpostata');
        });
        return;
      } else if (btn.dataset.act === 'delete') {
        openModal(`Eliminare ${user.name}?`, `
          <form><p>L'account verrà eliminato definitivamente.</p>
          <label class="option"><input type="checkbox" name="withContent"> Elimina anche i suoi ${user.note_count} appunti</label>
          <div class="modal-actions"><button class="btn btn-danger" type="submit">Elimina account</button></div></form>`, async (fd) => {
          await api(`/admin/users/${id}${fd.get('withContent') ? '?withContent=1' : ''}`, { method: 'DELETE' });
          toast('Utente eliminato');
          users(body);
        });
        return;
      }
      users(body);
    } catch (err) {
      toastError(err);
    }
  });
}

// ---------- Contenuti ----------

async function content(body) {
  const [{ subjects }, { notes }] = await Promise.all([api('/subjects'), api('/admin/notes')]);
  body.innerHTML = `
    <div class="section-head"><h2>Materie</h2><span class="spacer"></span><button class="btn btn-primary btn-sm" id="new-subject">＋ Nuova materia</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Materia</th><th>Argomenti</th><th>Appunti</th><th>Quiz</th><th></th></tr></thead>
      <tbody id="subject-rows">${subjects.map((s) => `
        <tr data-id="${s.id}"><td><a href="#/materia/${s.id}">${esc(s.icon)} ${esc(s.name)}</a></td><td>${s.topic_count}</td><td>${s.note_count}</td><td>${s.quiz_count}</td>
          <td class="actions"><button class="btn btn-sm" data-act="edit">Modifica</button> <button class="btn btn-sm btn-danger" data-act="delete">Elimina</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">Nessuna materia.</td></tr>'}</tbody></table></div>

    <div class="section-head section"><h2>Tutti gli appunti (${notes.length})</h2><span class="spacer"></span>
      <input type="search" id="note-filter" placeholder="Filtra appunti" style="max-width:260px"></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Appunto</th><th>Posizione</th><th>Autore</th><th>Dimensione</th><th>Caricato</th><th></th></tr></thead>
      <tbody id="note-rows">${notes.map((n) => `
        <tr data-id="${n.id}" data-search="${esc(`${n.title} ${n.author_name} ${n.subject_name} ${n.topic_name}`.toLowerCase())}">
          <td><a href="#/appunto/${n.id}">${fileType(n.ext).icon} ${esc(n.title)}</a></td>
          <td class="small">${esc(n.subject_name)} › ${esc(n.topic_name)}</td>
          <td class="small">${esc(n.author_name || '—')}<div class="muted">${esc(n.author_email || '')}</div></td>
          <td class="small">${formatBytes(n.size)}</td>
          <td class="small">${timeAgo(n.created_at)}</td>
          <td class="actions"><button class="btn btn-sm btn-danger" data-del="${n.id}">Elimina</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">Nessun appunto.</td></tr>'}</tbody></table></div>`;

  body.querySelector('#new-subject').addEventListener('click', () => {
    openModal('Nuova materia', subjectForm(), async (fd) => {
      await api('/subjects', { method: 'POST', body: Object.fromEntries(fd) });
      toast('Materia creata');
      content(body);
    });
  });
  body.querySelector('#subject-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const subject = subjects.find((s) => String(s.id) === btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'edit') {
      openModal('Modifica materia', subjectForm(subject), async (fd) => {
        await api(`/subjects/${subject.id}`, { method: 'PATCH', body: Object.fromEntries(fd) });
        toast('Materia aggiornata');
        content(body);
      });
    } else if (await confirmDialog(`Eliminare "${subject.name}" con tutti gli argomenti, appunti e quiz?`, { confirmLabel: 'Elimina' })) {
      await api(`/subjects/${subject.id}`, { method: 'DELETE' });
      toast('Materia eliminata');
      content(body);
    }
  });
  body.querySelector('#note-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    body.querySelectorAll('#note-rows tr[data-search]').forEach((tr) => { tr.hidden = !tr.dataset.search.includes(q); });
  });
  body.querySelector('#note-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn || !(await confirmDialog('Eliminare questo appunto?', { confirmLabel: 'Elimina' }))) return;
    await api(`/notes/${btn.dataset.del}`, { method: 'DELETE' });
    btn.closest('tr').remove();
    toast('Appunto eliminato');
  });
}

// ---------- Google Drive ----------

async function drive(body, query) {
  const st = await api('/admin/drive');
  const esito = query?.get('esito');
  if (esito) {
    if (esito === 'ok') toast('Google Drive collegato!');
    else toast(esito, 'error');
    history.replaceState(null, '', '#/admin?tab=drive');
  }
  const r = st.lastResult;
  const steps = (n, done, html) => `<div class="list-item"><span class="badge ${done ? 'badge-online' : ''}" style="min-width:28px;justify-content:center">${done ? '✓' : n}</span><div class="grow">${html}</div></div>`;

  body.innerHTML = `
    <div class="card" style="max-width:760px">
      <h2>☁️ Sincronizzazione con Google Drive</h2>
      <p class="muted">Le materie e gli argomenti del sito diventano le cartelle del tuo Drive: <strong>Cartella principale › Materia › Argomento › file</strong>.
        Quello che aggiungi nel Drive compare sul sito (ogni ${st.intervalMinutes} minuti o subito con "Sincronizza ora"), e gli appunti caricati sul sito finiscono nella cartella giusta del Drive.
        I Documenti, le Presentazioni e i Fogli Google vengono mostrati come PDF/Excel.</p>
      <div class="list" style="margin-top:18px">
        ${steps(1, st.configured, st.configured ? 'Credenziali Google configurate sul server.' : 'Imposta <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> sul server (guida nel README, sezione "Google Drive").')}
        ${steps(2, st.connected, st.connected ? `Collegato all'account <strong>${esc(st.account || 'Google')}</strong>.` : '<button class="btn btn-primary btn-sm" id="drive-connect" ' + (st.configured ? '' : 'disabled') + '>Collega Google Drive</button>')}
        ${steps(3, Boolean(st.rootId), st.rootId ? `Cartella principale: <strong>${esc(st.rootName || st.rootId)}</strong>` : 'Scegli la cartella che contiene le materie.')}
      </div>
      ${st.connected ? `
      <form id="root-form" style="margin-top:18px">
        <label>Cartella principale (link di Google Drive)</label>
        <div class="row" style="flex-wrap:nowrap">
          <input name="folder" placeholder="https://drive.google.com/drive/folders/…" value="${st.rootId ? `https://drive.google.com/drive/folders/${esc(st.rootId)}` : ''}">
          <button class="btn btn-primary" type="submit">${st.rootId ? 'Cambia' : 'Usa questa cartella'}</button>
        </div>
        <div id="folder-picker" class="chips" style="margin-top:10px"><button type="button" class="btn btn-sm btn-ghost" id="load-folders">Mostra le cartelle del mio Drive</button></div>
      </form>` : ''}
      ${st.rootId && st.connected ? `
      <div class="row" style="margin-top:22px">
        <button class="btn btn-primary" id="drive-sync">🔄 Sincronizza ora</button>
        <span class="muted small">${st.lastSync ? `Ultima sincronizzazione ${timeAgo(st.lastSync)}` : 'Mai sincronizzato'}</span>
        <span class="spacer"></span>
        <button class="btn btn-danger btn-sm" id="drive-disconnect">Scollega</button>
      </div>
      ${r ? `<p class="small muted" style="margin-top:12px">Ultimo risultato: ${r.subjects} materie, ${r.topics} argomenti e ${r.notes} appunti nuovi · ${r.updated} aggiornati · ${r.removed} rimossi · ${r.pushed} inviati al Drive${r.skipped ? ` · ${r.skipped} file saltati (non supportati o troppo grandi)` : ''}.</p>
        ${(r.warnings || []).map((w) => `<p class="small" style="color:var(--gold)">⚠️ ${esc(w)}</p>`).join('')}` : ''}` : ''}
      ${st.lastError ? `<p class="small" style="color:var(--danger);margin-top:12px">Ultimo errore: ${esc(st.lastError)}</p>` : ''}
    </div>

    ${st.connected ? `
    <div class="card section" style="max-width:760px">
      <h2>🗄️ Database salvato nel Drive</h2>
      <p class="muted">Utenti, quiz e impostazioni vengono copiati nella cartella <strong>"Appunti del Senato – dati del sito (non toccare)"</strong> del tuo Drive
        pochi secondi dopo ogni modifica, e ripristinati da lì quando il server si riavvia. Così il sito funziona anche su un hosting gratuito senza disco.</p>
      ${st.backupBlocked ? `<p class="small" style="color:var(--danger)">⚠️ All'avvio non è stato possibile recuperare la copia dal Drive (${esc(st.backupBlocked)}): i backup sono sospesi per non sovrascriverla. Controlla il collegamento e riavvia il server.</p>` : ''}
      <div class="row">
        <button class="btn" id="backup-now" ${st.backupBlocked ? 'disabled' : ''}>💾 Salva ora</button>
        <span class="muted small">${st.lastBackup ? `Ultima copia ${timeAgo(st.lastBackup)}` : 'Nessuna copia ancora'}</span>
      </div>
      ${st.tokenInEnv ? '<p class="small" style="color:var(--success);margin-top:14px">✅ Il collegamento al Drive è salvato anche sul server: sopravvive ai riavvii.</p>' : `
      <div class="explanation" style="margin-top:16px">
        <strong>Ultimo passaggio (una volta sola):</strong> su un server gratuito, a ogni riavvio il sito deve sapere come ricollegarsi al tuo Drive.
        Copia il codice qui sotto e incollalo su Render in <strong>Environment → DRIVE_REFRESH_TOKEN</strong>, poi salva.
        <div class="row" style="margin-top:10px;flex-wrap:nowrap">
          <input id="token-field" type="password" readonly value="" placeholder="••••••••••••">
          <button class="btn btn-sm" id="token-show" type="button">Mostra</button>
          <button class="btn btn-sm btn-primary" id="token-copy" type="button">Copia</button>
        </div>
        <p class="small muted" style="margin:8px 0 0">È una chiave di accesso al tuo Drive: non condividerla con nessuno.</p>
      </div>`}
    </div>` : ''}`;

  const loadToken = async () => {
    const field = body.querySelector('#token-field');
    if (!field.value) field.value = (await api('/admin/drive/token')).token;
    return field;
  };
  body.querySelector('#token-show')?.addEventListener('click', async (e) => {
    const field = await loadToken();
    field.type = field.type === 'password' ? 'text' : 'password';
    e.target.textContent = field.type === 'password' ? 'Mostra' : 'Nascondi';
  });
  body.querySelector('#token-copy')?.addEventListener('click', async () => {
    const field = await loadToken();
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Codice copiato');
    } catch {
      field.type = 'text';
      field.select();
      toast('Seleziona e copia il codice');
    }
  });
  body.querySelector('#backup-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/admin/drive/backup', { method: 'POST' });
      toast('Database salvato nel Drive');
    } catch (err) {
      toastError(err);
    }
    drive(body);
  });
  body.querySelector('#drive-connect')?.addEventListener('click', async () => {
    try {
      const { url } = await api('/admin/drive/connect');
      location.href = url;
    } catch (err) {
      toastError(err);
    }
  });
  body.querySelector('#root-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Sincronizzazione…';
    try {
      const { folder } = await api('/admin/drive/root', { method: 'POST', body: { folder: new FormData(e.target).get('folder') } });
      toast(`Cartella "${folder.name}" collegata e sincronizzata`);
    } catch (err) {
      toastError(err);
    }
    drive(body);
  });
  body.querySelector('#load-folders')?.addEventListener('click', async (e) => {
    const picker = body.querySelector('#folder-picker');
    e.target.disabled = true;
    try {
      const { folders } = await api('/admin/drive/folders');
      picker.innerHTML = folders.map((f) => `<button type="button" class="chip" data-id="${esc(f.id)}">📁 ${esc(f.name)}</button>`).join('') || '<span class="muted small">Nessuna cartella nel Drive.</span>';
      picker.addEventListener('click', (ev) => {
        const chip = ev.target.closest('[data-id]');
        if (!chip) return;
        body.querySelector('[name=folder]').value = `https://drive.google.com/drive/folders/${chip.dataset.id}`;
        picker.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      });
    } catch (err) {
      toastError(err);
      e.target.disabled = false;
    }
  });
  body.querySelector('#drive-sync')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sincronizzazione…';
    try {
      const { stats } = await api('/admin/drive/sync', { method: 'POST' });
      toast(`Sincronizzato: ${stats.notes} nuovi appunti, ${stats.removed} rimossi`);
    } catch (err) {
      toastError(err);
    }
    drive(body);
  });
  body.querySelector('#drive-disconnect')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Scollegare Google Drive? Materie e appunti restano nel Drive, ma il sito smetterà di sincronizzarli e di salvare il database. Se hai impostato DRIVE_REFRESH_TOKEN sul server, toglilo anche da lì.', { confirmLabel: 'Scollega' }))) return;
    await api('/admin/drive/disconnect', { method: 'POST' });
    toast('Google Drive scollegato');
    drive(body);
  });
}

// ---------- Impostazioni ----------

async function settings(body) {
  const s = await api('/admin/settings');
  body.innerHTML = `
    <div class="card" style="max-width:640px">
      <form id="settings-form">
        <div class="field"><label>Nome del sito</label><input name="site_name" maxlength="60" value="${esc(s.site_name)}"></div>
        <div class="field"><label>Avviso in evidenza (mostrato in alto a tutti gli utenti)</label>
          <textarea name="announcement" rows="2" maxlength="500" placeholder="Lascia vuoto per non mostrare nulla">${esc(s.announcement)}</textarea></div>
        <label class="option"><input type="checkbox" name="registration_open" ${s.registration_open ? 'checked' : ''}> Permetti a nuovi utenti di registrarsi</label>
        <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-primary" type="submit">Salva impostazioni</button></div>
      </form>
    </div>
    <div class="card section" style="max-width:640px">
      <h3>🤖 Assistente AI</h3>
      <p>${state.site.aiEnabled ? '✅ Attivo.' : '❌ Non configurato.'} <span class="muted">Usa Google Gemini con la chiave gratuita <code>GEMINI_API_KEY</code> (in alternativa Claude con <code>ANTHROPIC_API_KEY</code>). Il limite giornaliero per utente si imposta con <code>AI_DAILY_LIMIT</code>.</span></p>
    </div>`;

  body.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: { site_name: fd.get('site_name'), announcement: fd.get('announcement'), registration_open: fd.get('registration_open') === 'on' },
      });
      Object.assign(state.site, { name: fd.get('site_name'), announcement: fd.get('announcement'), registrationOpen: fd.get('registration_open') === 'on' });
      document.querySelector('#site-name').textContent = state.site.name;
      const ann = document.querySelector('#announcement');
      ann.textContent = state.site.announcement;
      ann.hidden = !state.site.announcement;
      toast('Impostazioni salvate');
    } catch (err) {
      toastError(err);
    }
  });
}
