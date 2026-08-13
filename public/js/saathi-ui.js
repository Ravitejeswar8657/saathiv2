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

  // ── "Prepare brief" bar ────────────────────────────────────────────────────
  // The brief workflow is entered by date (/brief_workflow.html?date=…), so a
  // page that lists events used to repeat that link once per date group — a wall
  // of near-identical rows. One control with a date dropdown replaces all of them.
  //
  // The dropdown lists only dates that actually have events, deliberately: the
  // wizard dead-ends on "No events for this date", so a free date input would let
  // staff walk into an empty brief. The old per-date buttons made that impossible
  // and this keeps that property.

  function dateLabel(date, todayIST) {
    if (date === todayIST) return 'Today';
    return new Date(date + 'T00:00:00')
      .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  SaathiUI.briefDates = function (events, todayIST) {
    const counts = new Map();
    (events || []).forEach(ev => {
      if (!ev || !ev.date) return;
      counts.set(ev.date, (counts.get(ev.date) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({
        date, count,
        label: `${dateLabel(date, todayIST)} · ${count} event${count > 1 ? 's' : ''}`,
      }));
  };

  SaathiUI.briefBarHTML = function (events, opts = {}) {
    const { todayIST = '', selected = '', id = 'brief-date-select' } = opts;
    const dates = SaathiUI.briefDates(events, todayIST);
    if (!dates.length) return '';

    const has = d => d && dates.some(x => x.date === d);
    const pick = has(selected) ? selected
      : has(todayIST) ? todayIST
      : (dates.find(x => x.date > todayIST) || dates[dates.length - 1]).date;

    const options = dates.map(d =>
      `<option value="${d.date}"${d.date === pick ? ' selected' : ''}>${d.label}</option>`
    ).join('');

    return `
      <div class="brief-bar">
        <label for="${id}">Prepare brief for</label>
        <select id="${id}">${options}</select>
        <button type="button" class="btn btn-primary" onclick="SaathiUI.openBrief('${id}')">Prepare brief &rarr;</button>
      </div>`;
  };

  SaathiUI.openBrief = function (selectId) {
    const el = document.getElementById(selectId);
    if (!el || !el.value) return;
    location.href = `/brief_workflow.html?date=${el.value}`;
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

  // The third argument accepts either a duration in ms (the original signature,
  // still used by every existing caller) or an options object. An `actionLabel`
  // + `onAction` pair renders an inline button — which is where an Undo belongs,
  // rather than on a separate screen the user has to go and find.
  SaathiUI.toast = function (message, type = 'info', options = 4000) {
    const opts = typeof options === 'number' ? { duration: options } : (options || {});
    const { duration = 4000, actionLabel, onAction } = opts;

    const container = ensureToastContainer();
    const el = document.createElement('div');
    el.className = `saathi-toast${type !== 'info' ? ' toast-' + type : ''}`;
    el.innerHTML = `<i data-lucide="${TOAST_ICONS[type] || 'info'}"></i><span></span>`;
    el.querySelector('span').textContent = message;

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    };

    if (actionLabel && typeof onAction === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'saathi-toast-action';
      btn.textContent = actionLabel;
      btn.addEventListener('click', async () => {
        // Dismiss first: the action may be slow, and a toast that lingers after
        // the click reads as a button that did nothing.
        dismiss();
        try {
          await onAction();
        } catch (e) {
          SaathiUI.toast('That could not be undone.', 'danger');
        }
      });
      el.appendChild(btn);
    }

    container.appendChild(el);
    if (window.lucide) lucide.createIcons({ nodes: [el] });
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(dismiss, duration);
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
