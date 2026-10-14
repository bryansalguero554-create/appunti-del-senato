import {
  state, api, esc, timeAgo, formatDate, fileType, formatBytes, toast, toastError, roleBadge, confirmDialog,
} from '../util.js';
import { installApp, isStandalone } from '../install.js';

export function deviceName(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Sconosciuto';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const icon = /Mobile|iPhone|Android/.test(ua) ? '📱' : '💻';
  return `${icon} ${browser} · ${os}`;
}

export async function renderProfile(app) {
  const [{ sessions }, { notes }, { attempts }] = await Promise.all([
    api('/auth/sessions'), api('/notes/mine'), api('/quizzes/attempts/mine'),
  ]);
  const u = state.user;

  app.innerHTML = `
    <div class="page-head"><div class="titles"><h1>👤 ${esc(u.name)} ${roleBadge(u.role)}</h1>
      <p class="muted">${esc(u.email)} · iscritto dal ${formatDate(u.created_at)}</p></div></div>

    ${isStandalone() ? '' : `
    <div class="card install-card" style="margin-bottom:20px">
      <picture><source srcset="/icons/icon-dark-192.png" media="(prefers-color-scheme: dark)"><img src="/icons/icon-192.png" alt=""></picture>
      <div class="grow" style="flex:1"><h2 style="margin:0 0 4px">📱 Installa l'app</h2>
        <p class="muted small" style="margin:0">Metti Appunti del Senato sulla schermata Home di iPhone, iPad o Android: si apre a tutto schermo come un'app.</p></div>
      <button class="btn btn-primary" id="install-app">Installa</button>
    </div>`}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card">
        <h2>🔑 Cambia password</h2>
        <form id="pw-form">
          <div class="field"><label>Password attuale</label><input type="password" name="currentPassword" required autocomplete="current-password"></div>
          <div class="field"><label>Nuova password</label><input type="password" name="newPassword" required minlength="8" autocomplete="new-password"></div>
          <button class="btn btn-primary" type="submit">Aggiorna password</button>
          <p class="muted small" style="margin-top:8px">Verrai disconnesso da tutti gli altri dispositivi.</p>
        </form>
      </div>
      <div class="card">
        <h2>🖥️ I tuoi dispositivi</h2>
        <div class="list" id="my-sessions">${sessions.map((s) => `
          <div class="list-item">
            <div class="grow"><div class="title">${deviceName(s.user_agent)} ${s.current ? '<span class="badge badge-online">questo</span>' : ''}</div>
              <div class="muted small">IP ${esc(s.ip || '—')} · attivo ${timeAgo(s.last_seen_at)}</div></div>
            ${s.current ? '' : `<button class="btn btn-sm btn-danger" data-revoke="${s.id}">Disconnetti</button>`}
          </div>`).join('')}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>📄 I miei appunti (${notes.length})</h2></div>
      ${notes.length ? `<div class="list">${notes.map((n) => `
        <a class="list-item" href="#/appunto/${n.id}">
          <span style="font-size:1.4rem">${fileType(n.ext).icon}</span>
          <div class="grow"><div class="title">${esc(n.title)}</div><div class="muted small">${esc(n.subject_name)} › ${esc(n.topic_name)} · ${formatBytes(n.size)}</div></div>
          <span class="muted small">${timeAgo(n.created_at)}</span>
        </a>`).join('')}</div>` : '<p class="muted">Non hai ancora caricato appunti.</p>'}
    </div>

    <div class="section">
      <div class="section-head"><h2>📊 I miei risultati nei quiz</h2></div>
      ${attempts.length ? `<div class="list">${attempts.map((a) => `
        <a class="list-item" href="#/quiz/${a.quiz_id}">
          <span class="badge ${a.score / a.total >= 0.6 ? 'badge-online' : 'badge-banned'}">${Math.round((a.score / Math.max(a.total, 1)) * 100)}%</span>
          <div class="grow"><div class="title">${esc(a.title)}</div><div class="muted small">${a.score}/${a.total} risposte corrette</div></div>
          <span class="muted small">${timeAgo(a.created_at)}</span>
        </a>`).join('')}</div>` : '<p class="muted">Non hai ancora svolto quiz.</p>'}
    </div>`;

  app.querySelector('#install-app')?.addEventListener('click', installApp);
  app.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Password aggiornata');
      renderProfile(app);
    } catch (err) {
      toastError(err);
    }
  });
  app.querySelector('#my-sessions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    if (!(await confirmDialog('Disconnettere questo dispositivo?', { confirmLabel: 'Disconnetti' }))) return;
    await api(`/auth/sessions/${btn.dataset.revoke}`, { method: 'DELETE' });
    toast('Dispositivo disconnesso');
    renderProfile(app);
  });
}
