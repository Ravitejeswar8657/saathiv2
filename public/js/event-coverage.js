// Saathi v2 — post-event coverage modal, shared by index.html and pa_schedule.html.
//
// An event used to be write-once: booked, then nothing. Everything that happened
// AFTER it — the press link, the photos from the ground, whether social went out —
// lived outside the system. This is where that gets recorded.
//
// Shared rather than copy-pasted onto both pages because the two schedule views
// already carry a byte-for-byte duplicate of the calendar code between them, and a
// third duplicate of a form this size would drift within a release. The event's own
// fields are read-only here on purpose: this modal is for what came of the event,
// not for re-editing what was booked.
(function () {
  const EventCoverage = {};

  const MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,application/pdf';
  const LINK_LIMIT = 20;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt12h(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    if (Number.isNaN(h)) return t;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m || 0).padStart(2, '0')} ${suffix}`;
  }

  // ── The at-a-glance strip on the cards ──────────────────────────────────
  // Exported so both schedule views show the same thing, and so staff can see
  // which events still have no write-up without opening each one.
  EventCoverage.chipsHTML = function (ev) {
    const links = (ev.media_links || []).length;
    const files = (ev.media || []).length;
    const chips = [];
    if (links) chips.push(`<span class="cov-chip"><i data-lucide="link"></i>${links}</span>`);
    if (files) chips.push(`<span class="cov-chip"><i data-lucide="paperclip"></i>${files}</span>`);
    if (ev.social_posted) chips.push('<span class="cov-chip cov-chip-posted"><i data-lucide="megaphone"></i>Posted</span>');
    if (ev.coverage_notes) chips.push('<span class="cov-chip"><i data-lucide="sticky-note"></i></span>');
    if (!chips.length) return '<span class="cov-chip cov-chip-empty">No coverage yet</span>';
    return chips.join('');
  };

  // ── Modal shell, injected once ──────────────────────────────────────────

  const STYLES = `
    .ec-modal { max-width: 620px; }
    .ec-head { border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 18px; }
    .ec-head h3 { margin-bottom: 6px; }
    .ec-head-meta { font-size: 13px; color: var(--stone-600); }
    .ec-head-sub { font-size: 12px; color: var(--stone-500); margin-top: 6px; }
    .ec-section { margin-bottom: 18px; }
    .ec-section > label { display: block; font-size: 12px; font-weight: 600;
      color: var(--stone-600); margin-bottom: 8px; }
    .ec-link-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
    .ec-link-row input { flex: 1; min-width: 0; }
    .ec-link-row input.ec-label-input { flex: 0 0 34%; }
    .ec-x {
      flex: none; width: 28px; height: 28px; border: 1px solid var(--border);
      background: #fff; border-radius: var(--radius-sm); color: var(--stone-500);
      cursor: pointer; line-height: 1; font-size: 15px;
    }
    .ec-x:hover { color: var(--danger); border-color: var(--danger-border); background: var(--danger-bg); }
    .ec-add { margin-top: 2px; }
    .ec-media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
      gap: 8px; margin-bottom: 10px; }
    .ec-thumb { position: relative; border: 1px solid var(--border); border-radius: var(--radius-sm);
      overflow: hidden; aspect-ratio: 1; background: var(--bg); }
    .ec-thumb img, .ec-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ec-thumb-file { display: flex; align-items: center; justify-content: center; height: 100%;
      font-size: 11px; color: var(--stone-500); gap: 4px; }
    .ec-thumb .ec-x { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px;
      font-size: 12px; padding: 0; opacity: .9; }
    .ec-radio-row { display: flex; gap: 8px; }
    .ec-radio {
      flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      cursor: pointer; font-size: 13px; background: #fff;
    }
    .ec-radio.on { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); font-weight: 600; }
    .ec-hint { font-size: 11px; color: var(--stone-500); margin-top: 6px; }
    .cov-strip { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .cov-chip {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 11px; color: var(--stone-600);
      background: var(--bg); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 2px 6px;
    }
    .cov-chip [data-lucide] { width: 11px; height: 11px; }
    .cov-chip-posted { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
    .cov-chip-empty { color: var(--stone-500); background: transparent; border-style: dashed; }
  `;

  let overlay = null;
  // Everything the modal is editing, held here rather than read back out of the
  // DOM — add/remove on a list of rows is a re-render, not a DOM diff.
  let state = null;

  // On load, not on first open: the .cov-chip rules style the summary strip on
  // the cards, which is on screen long before anybody opens the modal.
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  function ensureShell() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'event-coverage-modal';
    overlay.innerHTML = `
      <div class="modal ec-modal">
        <div class="ec-head">
          <h3 id="ec-title"></h3>
          <div class="ec-head-meta" id="ec-meta"></div>
          <div class="ec-head-sub" id="ec-sub"></div>
        </div>

        <div class="ec-section">
          <label>Media coverage links</label>
          <div id="ec-media-links"></div>
          <button class="btn btn-sm btn-ghost ec-add" id="ec-add-media-link">
            <i data-lucide="plus"></i> Add link
          </button>
          <div class="ec-hint">News articles, video coverage, or a drive folder.</div>
        </div>

        <div class="ec-section">
          <label>Photos, videos &amp; PDFs</label>
          <div class="ec-media-grid" id="ec-media-grid"></div>
          <div class="file-drop" id="ec-file-drop">
            <i data-lucide="image-plus"></i><br>
            Click to add photos, videos, or PDFs
          </div>
          <input type="file" id="ec-file-input" multiple accept="${MEDIA_ACCEPT}" style="display:none">
          <div class="file-preview-list" id="ec-file-preview"></div>
        </div>

        <div class="ec-section">
          <label>Was a social media post made?</label>
          <div class="ec-radio-row">
            <div class="ec-radio" id="ec-social-no"><i data-lucide="x"></i> No</div>
            <div class="ec-radio" id="ec-social-yes"><i data-lucide="check"></i> Yes</div>
          </div>
          <div id="ec-social-wrap" style="display:none; margin-top:10px">
            <div id="ec-social-links"></div>
            <button class="btn btn-sm btn-ghost ec-add" id="ec-add-social-link">
              <i data-lucide="plus"></i> Add post link
            </button>
            <div class="ec-hint">Facebook, X, Instagram or YouTube post URLs.</div>
          </div>
        </div>

        <div class="ec-section">
          <label>Coverage notes</label>
          <textarea id="ec-notes" rows="3" placeholder="How it went, who attended, what was promised..."></textarea>
        </div>

        <div class="modal-actions">
          <button class="btn btn-accent" id="ec-save">Save coverage</button>
          <button class="btn btn-secondary" id="ec-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('ec-cancel').onclick = close;
    document.getElementById('ec-save').onclick = save;
    document.getElementById('ec-add-media-link').onclick = () => {
      state.mediaLinks.push({ url: '', label: '' });
      renderLinks('media');
    };
    document.getElementById('ec-add-social-link').onclick = () => {
      state.socialLinks.push({ url: '', label: '' });
      renderLinks('social');
    };
    document.getElementById('ec-social-no').onclick = () => setPosted(false);
    document.getElementById('ec-social-yes').onclick = () => setPosted(true);
    document.getElementById('ec-file-drop').onclick = () =>
      document.getElementById('ec-file-input').click();
    document.getElementById('ec-file-input').onchange = onFilesChosen;
  }

  // ── Link lists ──────────────────────────────────────────────────────────
  // Typing writes straight back into state on input, so a re-render (triggered by
  // adding or removing a row) never discards what is already in the other rows.

  function renderLinks(kind) {
    const list = kind === 'media' ? state.mediaLinks : state.socialLinks;
    const host = document.getElementById(kind === 'media' ? 'ec-media-links' : 'ec-social-links');
    host.innerHTML = list.map((l, i) => `
      <div class="ec-link-row">
        <input type="url" placeholder="https://..." value="${esc(l.url)}" data-kind="${kind}" data-i="${i}" data-f="url">
        <input type="text" class="ec-label-input" placeholder="Label (optional)" value="${esc(l.label)}" data-kind="${kind}" data-i="${i}" data-f="label">
        <button class="ec-x" data-remove="${kind}" data-i="${i}" title="Remove link">&times;</button>
      </div>`).join('');

    host.querySelectorAll('input').forEach(input => {
      input.oninput = () => {
        const target = input.dataset.kind === 'media' ? state.mediaLinks : state.socialLinks;
        target[Number(input.dataset.i)][input.dataset.f] = input.value;
      };
    });
    host.querySelectorAll('[data-remove]').forEach(btn => {
      btn.onclick = () => {
        const target = btn.dataset.remove === 'media' ? state.mediaLinks : state.socialLinks;
        target.splice(Number(btn.dataset.i), 1);
        renderLinks(btn.dataset.remove);
      };
    });
    if (window.lucide) lucide.createIcons();
  }

  function setPosted(posted) {
    state.posted = posted;
    document.getElementById('ec-social-yes').classList.toggle('on', posted);
    document.getElementById('ec-social-no').classList.toggle('on', !posted);
    document.getElementById('ec-social-wrap').style.display = posted ? 'block' : 'none';
    if (posted && !state.socialLinks.length) state.socialLinks.push({ url: '', label: '' });
    if (posted) renderLinks('social');
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  function renderMedia() {
    const grid = document.getElementById('ec-media-grid');
    grid.innerHTML = state.keptMedia.map((m, i) => {
      const src = `/api/schedule/media/${encodeURIComponent(m.filename)}`;
      let inner;
      if (m.type === 'image') inner = `<img src="${src}" loading="lazy" alt="">`;
      else if (m.type === 'video') inner = `<video src="${src}" muted></video>`;
      else inner = `<a class="ec-thumb-file" href="${src}" target="_blank"><i data-lucide="file-text"></i> ${esc(m.type)}</a>`;
      return `<div class="ec-thumb">${inner}<button class="ec-x" data-drop="${i}" title="Remove">&times;</button></div>`;
    }).join('');

    grid.querySelectorAll('[data-drop]').forEach(btn => {
      btn.onclick = () => {
        // Staged, not deleted: the file is only unlinked once Save goes through,
        // so closing the modal instead is a clean discard.
        const [dropped] = state.keptMedia.splice(Number(btn.dataset.drop), 1);
        state.removeMedia.push(dropped.filename);
        renderMedia();
      };
    });
    if (window.lucide) lucide.createIcons();
  }

  function onFilesChosen() {
    const input = document.getElementById('ec-file-input');
    state.newFiles.push(...Array.from(input.files));
    // Clearing the input is what lets the same file be picked again after it was
    // removed from the list — the change event does not fire on an identical value.
    input.value = '';
    renderNewFiles();
  }

  function renderNewFiles() {
    const host = document.getElementById('ec-file-preview');
    host.innerHTML = state.newFiles.map((f, i) => `
      <div class="file-preview-item">
        <i data-lucide="file"></i>
        <span style="flex:1">${esc(f.name)}</span>
        <button class="ec-x" data-newfile="${i}" title="Remove">&times;</button>
      </div>`).join('');
    host.querySelectorAll('[data-newfile]').forEach(btn => {
      btn.onclick = () => { state.newFiles.splice(Number(btn.dataset.newfile), 1); renderNewFiles(); };
    });
    if (window.lucide) lucide.createIcons();
  }

  // ── Open / save / close ─────────────────────────────────────────────────

  /**
   * Open the coverage modal for one event.
   *
   * @param {object} ev       the event as /api/schedule returns it
   * @param {function} onSaved called with the updated event once the save lands
   */
  EventCoverage.open = function (ev, onSaved) {
    ensureShell();
    state = {
      id: ev.id,
      onSaved,
      // Copies, so cancelling leaves the caller's list untouched.
      mediaLinks: (ev.media_links || []).map(l => ({ url: l.url || '', label: l.label || '' })),
      socialLinks: (ev.social_links || []).map(l => ({ url: l.url || '', label: l.label || '' })),
      posted: !!ev.social_posted,
      keptMedia: (ev.media || []).slice(),
      removeMedia: [],
      newFiles: [],
    };

    const place = [ev.village, ev.mandal].filter(Boolean).join(', ');
    const when = [ev.date, ev.time ? fmt12h(ev.time) : ''].filter(Boolean).join(' · ');
    document.getElementById('ec-title').textContent = ev.event_name || 'Event';
    document.getElementById('ec-meta').textContent = [when, place].filter(Boolean).join('  ·  ');
    document.getElementById('ec-sub').textContent = [
      ev.event_type,
      ev.nearby_count ? `${ev.nearby_count} priority contacts nearby` : '',
    ].filter(Boolean).join('  ·  ');
    document.getElementById('ec-notes').value = ev.coverage_notes || '';

    if (!state.mediaLinks.length) state.mediaLinks.push({ url: '', label: '' });
    renderLinks('media');
    renderMedia();
    renderNewFiles();
    setPosted(state.posted);

    overlay.classList.add('open');
    if (window.lucide) lucide.createIcons();
  };

  function close() {
    if (overlay) overlay.classList.remove('open');
    state = null;
  }

  function cleanLinks(list) {
    return list.map(l => ({ url: (l.url || '').trim(), label: (l.label || '').trim() }))
      .filter(l => l.url);
  }

  async function save() {
    const mediaLinks = cleanLinks(state.mediaLinks);
    const socialLinks = state.posted ? cleanLinks(state.socialLinks) : [];

    const bad = [...mediaLinks, ...socialLinks].find(l => !/^https?:\/\//i.test(l.url));
    if (bad) { toast(`"${bad.url}" is not a valid link — it should start with http:// or https://`, 'danger'); return; }
    if (mediaLinks.length > LINK_LIMIT || socialLinks.length > LINK_LIMIT) {
      toast(`At most ${LINK_LIMIT} links.`, 'danger'); return;
    }

    const fd = new FormData();
    fd.append('media_links', JSON.stringify(mediaLinks));
    fd.append('social_links', JSON.stringify(socialLinks));
    fd.append('social_posted', String(state.posted));
    fd.append('coverage_notes', document.getElementById('ec-notes').value);
    fd.append('remove_media', JSON.stringify(state.removeMedia));
    state.newFiles.forEach(f => fd.append('media', f));

    const btn = document.getElementById('ec-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const r = await fetch(`/api/schedule/${state.id}`, { method: 'PATCH', body: fd });
      const data = await r.json();
      if (!r.ok) { toast(data.error || 'Failed to save coverage.', 'danger'); return; }
      const onSaved = state.onSaved;
      close();
      toast('Coverage saved.', 'success');
      if (onSaved) onSaved(data.event);
    } catch (e) {
      toast('Failed to save coverage.', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save coverage';
    }
  }

  function toast(msg, type) {
    if (window.SaathiUI) SaathiUI.toast(msg, type);
    else console.log(msg);
  }

  window.EventCoverage = EventCoverage;
})();
