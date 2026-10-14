import { state, api, esc } from '../util.js';

export function renderAuth(app, mode, onDone) {
  const isLogin = mode === 'login';
  const closed = !isLogin && !state.site.registrationOpen;
  app.className = '';
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <div class="card auth-card tilt" data-tilt="4">
        <img class="auth-logo" src="/icons/icon-192.png" alt="" width="84" height="84">
        <h1>${esc(state.site.name || 'Appunti')}</h1>
        <p class="muted" style="text-align:center;margin-bottom:24px">${isLogin ? 'Accedi per studiare con gli appunti condivisi.' : 'Crea il tuo account gratuito.'}</p>
        <div class="alert" id="auth-error" hidden></div>
        ${closed ? '<div class="alert">Le registrazioni sono momentaneamente chiuse.</div>' : `
        <form id="auth-form" novalidate>
          ${isLogin ? '' : '<div class="field"><label for="name">Nome</label><input id="name" name="name" required minlength="2" maxlength="60" autocomplete="name"></div>'}
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="${isLogin ? 1 : 8}" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
            ${isLogin ? '' : '<div class="muted small">Almeno 8 caratteri.</div>'}</div>
          <button class="btn btn-primary" style="width:100%;padding:13px;font-size:1rem;margin-top:6px" type="submit">${isLogin ? 'Accedi' : 'Crea account'}</button>
        </form>`}
        <div class="switch">${isLogin
          ? (state.site.registrationOpen ? 'Non hai un account? <a href="#/registrati">Registrati</a>' : '')
          : 'Hai già un account? <a href="#/accedi">Accedi</a>'}</div>
        <p class="muted small" style="text-align:center;margin:18px 0 0"><a href="/privacy" class="muted">Privacy</a> · <a href="/termini" class="muted">Termini di servizio</a></p>
      </div>
    </div>`;

  const form = app.querySelector('#auth-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = app.querySelector('#auth-error');
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      const { user } = await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body });
      app.className = 'container';
      onDone(user);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}
