// Saathi v2 — shared UI helpers: toast, confirm-dialog, mandal list.
// Replaces scattered native alert()/confirm() calls and copy-pasted mandal <option> lists.
(function () {
  const SaathiUI = {};

  SaathiUI.MANDALS = [
    'Amaravathi', 'Atchampet', 'Bellamkonda', 'Krosuru',
    'Muppalla', 'Nekarikallu', 'Pedakurapadu', 'Rajupalem',
    'Sattenapalli', 'Bollapalle', 'Chilakaluripet', 'Edlapadu',
    'Ipuru', 'Nadendla', 'Narasaraopet', 'Nuzendla',
    'Rompicherla', 'Savalyapuram', 'Vinukonda', 'Dachepalle',
    'Durgi', 'Gurazala', 'Karempudi', 'Machavaram',
    'Macherla', 'Piduguralla', 'Rentachintala', 'Veldurthi',
  ];

  SaathiUI.mandalOptionsHTML = function (selected) {
    return SaathiUI.MANDALS.map(m =>
      `<option value="${m}"${m === selected ? ' selected' : ''}>${m}</option>`
    ).join('');
  };

  function ensureToastContainer() {
    let el = document.getElementById('saathi-toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'saathi-toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  const TOAST_ICONS = { info: 'info', success: 'check-circle', danger: 'alert-circle' };

  SaathiUI.toast = function (message, type = 'info', duration = 4000) {
    const container = ensureToastContainer();
    const el = document.createElement('div');
    el.className = `saathi-toast${type !== 'info' ? ' toast-' + type : ''}`;
    el.innerHTML = `<i data-lucide="${TOAST_ICONS[type] || 'info'}"></i><span></span>`;
    el.querySelector('span').textContent = message;
    container.appendChild(el);
    if (window.lucide) lucide.createIcons({ nodes: [el] });
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, duration);
  };

  SaathiUI.confirm = function (message, opts = {}) {
    const { title = 'Are you sure?', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = opts;
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-dialog open';
      overlay.innerHTML = `
        <div class="modal" role="alertdialog" aria-modal="true">
          <div class="confirm-dialog-icon"><i data-lucide="${danger ? 'alert-triangle' : 'help-circle'}"></i></div>
          <h3>${title}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="cancel">${cancelLabel}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm">${confirmLabel}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      if (window.lucide) lucide.createIcons({ nodes: [overlay] });

      function close(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.addEventListener('click', e => {
        if (e.target === overlay) close(false);
      });
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => close(true));
    });
  };

  window.SaathiUI = SaathiUI;
})();
