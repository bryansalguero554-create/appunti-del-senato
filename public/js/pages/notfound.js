// Pagina 404 personalizzata con numeri in rilievo 3D e un foglio di appunti che vola.

function digit(char, d) {
  const layers = Array.from({ length: 10 }, (_, i) => `<span class="layer" style="--z:${i * 4}" aria-hidden="true">${char}</span>`).join('');
  return `<span class="nf-digit" style="--d:${d}">${layers}<span class="face">${char}</span></span>`;
}

export function notFoundMarkup(homeHref = '#/') {
  return `
    <div class="nf" data-parallax>
      <div>
        <div class="nf-scene" aria-hidden="true">
          <div class="nf-digits">${digit('4', 0)}${digit('0', 1)}${digit('4', 2)}</div>
          <div class="nf-paper"></div>
        </div>
        <h1>Questa pagina si è persa tra gli appunti.</h1>
        <p>Forse è stata spostata o eliminata. Torna alle materie e riprendi a studiare.</p>
        <a class="btn btn-primary" href="${homeHref}">Torna alla home</a>
      </div>
    </div>`;
}

export function renderNotFound(app) {
  document.title = 'Pagina non trovata';
  app.innerHTML = notFoundMarkup();
}
