// Web app installabile: service worker, pulsante "Installa" (Android/Chrome) e istruzioni per iPhone/iPad.
import { state, openModal, closeModal } from './util.js';

let deferredPrompt = null;
const DISMISS_KEY = 'install-banner-dismissed';

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isIOS() || /Android/i.test(navigator.userAgent);
export const canInstall = () => !isStandalone() && (Boolean(deferredPrompt) || isIOS());

function dismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
function setDismissed() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* modalità privata */ }
}

/** Avvia l'installazione: finestra di sistema su Android/Chrome, istruzioni su iPhone/iPad. */
export async function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.querySelector('#install-banner')?.remove();
    if (outcome === 'accepted') setDismissed();
    return;
  }
  const chrome = /CriOS/.test(navigator.userAgent);
  openModal('Installa l\'app', `
    <div class="install-card" style="margin-bottom:16px">
      <picture><source srcset="/icons/icon-dark-192.png" media="(prefers-color-scheme: dark)"><img src="/icons/icon-192.png" alt=""></picture>
      <div><strong>Appunti del Senato</strong><div class="muted small">Si apre a tutto schermo, come un'app, direttamente dalla schermata Home.</div></div>
    </div>
    <ol style="padding-left:1.2rem;line-height:1.7">
      <li>Tocca il pulsante <strong>Condividi</strong> <span aria-hidden="true">⬆️</span> ${chrome ? 'accanto alla barra degli indirizzi, in alto' : 'nella barra di Safari (in basso su iPhone, in alto su iPad)'}.</li>
      <li>Scorri e scegli <strong>"Aggiungi alla schermata Home"</strong>.</li>
      <li>Tocca <strong>Aggiungi</strong>: l'icona comparirà tra le tue app.</li>
    </ol>
    <div class="modal-actions"><button class="btn btn-primary" type="button" id="install-ok">Ho capito</button></div>`);
  document.querySelector('#install-ok').addEventListener('click', closeModal);
}

/** Piccolo invito in basso, solo su telefono/tablet, finché non si installa o lo si chiude. */
export function maybeShowInstallBanner() {
  if (!state.user || !canInstall() || !isMobile() || dismissed() || document.querySelector('#install-banner')) return;
  const el = document.createElement('div');
  el.id = 'install-banner';
  el.className = 'install-banner';
  el.innerHTML = `
    <picture><source srcset="/icons/icon-dark-192.png" media="(prefers-color-scheme: dark)"><img src="/icons/icon-192.png" alt=""></picture>
    <div class="grow"><strong>Installa l'app</strong><br><span class="muted">Appunti del Senato sulla tua schermata Home.</span></div>
    <button class="btn btn-primary btn-sm" type="button" data-install>Installa</button>
    <button class="icon-btn" type="button" data-close aria-label="Non ora">✕</button>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-install]')) installApp();
    if (e.target.closest('[data-close]')) { setDismissed(); el.remove(); }
  });
  document.body.append(el);
}

export function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstallBanner();
    window.dispatchEvent(new Event('install-available'));
  });
  window.addEventListener('appinstalled', () => {
    setDismissed();
    document.querySelector('#install-banner')?.remove();
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    // nuova versione del sito installata mentre l'app era aperta: si propone di ricaricare
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateBanner();
    });
    // initInstall parte dopo il login iniziale: la pagina potrebbe essere già caricata
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

function showUpdateBanner() {
  if (document.querySelector('#update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'install-banner update-banner';
  el.innerHTML = `<div class="grow"><strong>Nuova versione disponibile</strong><br><span class="muted">Tocca Aggiorna per usarla subito.</span></div>
    <button class="btn btn-primary btn-sm" type="button" data-reload>Aggiorna</button>
    <button class="icon-btn" type="button" data-close aria-label="Più tardi">✕</button>`;
  el.querySelector('[data-reload]').addEventListener('click', () => location.reload());
  el.querySelector('[data-close]').addEventListener('click', () => el.remove());
  document.body.append(el);
}
