(function () {
  const LINKS = [
    { href: '/pa_schedule.html', label: 'Schedule',       icon: 'calendar' },
    { href: '/contacts.html',    label: 'Contacts',       icon: 'book-user' },
    { href: '/heatmap.html',     label: 'Heatmap',        icon: 'flame' },
    { href: '/admin.html',       label: 'Admin',          icon: 'layout-dashboard' },
    { href: '/broadcast.html',   label: 'Broadcast',      icon: 'radio' },
    { href: '/news.html',        label: 'News Submission',icon: 'file-text' },
    { href: '/ttd_letters.html', label: 'TTD Letters',    icon: 'landmark' },
    { href: '/visitor_forms.html', label: 'Visitor Forms', icon: 'clipboard-list' },
  ];

  function isDashboard() {
    const p = location.pathname.toLowerCase();
    return p === '/' || p === '' || p === '/index.html';
  }

  function isActive(href) {
    return location.pathname.toLowerCase() === href;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'saathi-sidebar-style';
    style.textContent = `
      body { margin-left: 220px; }
      .saathi-sidebar {
        position: fixed; top: 3px; left: 0; bottom: 0; width: 220px;
        background: #fff; border-right: 1px solid #e5e5e5; z-index: 40;
        overflow-y: auto; padding: 20px 12px;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        display: flex; flex-direction: column;
      }
      .saathi-brand {
        font-size: 12px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .6px; color: #78716c; padding: 0 10px 14px;
      }
      .saathi-dashboard-btn {
        display: flex; align-items: center; gap: 10px;
        padding: 13px 14px; margin-bottom: 16px;
        background: #b45309; color: #fff; border-radius: 8px;
        text-decoration: none; font-size: 14px; font-weight: 700;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      }
      .saathi-dashboard-btn:hover { background: #92400e; }
      .saathi-dashboard-btn.active { background: #92400e; }
      .saathi-dashboard-btn [data-lucide] { width: 18px; height: 18px; flex-shrink: 0; }
      .saathi-divider { height: 1px; background: #e5e5e5; margin: 0 4px 14px; }
      .saathi-link {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-radius: 6px; color: #374151;
        text-decoration: none; font-size: 14px; font-weight: 500;
        border-left: 3px solid transparent; margin-bottom: 2px;
      }
      .saathi-link:hover { background: #fafaf9; }
      .saathi-link.active { background: #fff7ed; color: #b45309; border-left-color: #b45309; font-weight: 600; }
      .saathi-link [data-lucide] { width: 16px; height: 16px; flex-shrink: 0; }
      .saathi-toggle {
        display: none; position: fixed; top: 10px; left: 10px; z-index: 60;
        background: #1a1208; color: #fff; border: none; border-radius: 6px;
        padding: 8px; align-items: center; justify-content: center; cursor: pointer;
      }
      .saathi-backdrop {
        display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 35;
      }
      @media (max-width: 900px) {
        body { margin-left: 0 !important; }
        .saathi-sidebar {
          top: 0; padding-top: 56px; transform: translateX(-100%);
          transition: transform .2s ease;
        }
        .saathi-sidebar.open { transform: translateX(0); }
        .saathi-toggle { display: flex; }
        .saathi-backdrop.open { display: block; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildSidebarHTML() {
    const dashActive = isDashboard();
    const linksHTML = LINKS.map(l => `
      <a class="saathi-link${isActive(l.href) ? ' active' : ''}" href="${l.href}">
        <i data-lucide="${l.icon}"></i> ${l.label}
      </a>
    `).join('');

    return `
      <button id="saathi-sidebar-toggle" class="saathi-toggle" aria-label="Menu">
        <i data-lucide="menu"></i>
      </button>
      <div id="saathi-sidebar-backdrop" class="saathi-backdrop"></div>
      <nav id="saathi-sidebar" class="saathi-sidebar">
        <div class="saathi-brand">Saathi &middot; Palanadu</div>
        <a class="saathi-dashboard-btn${dashActive ? ' active' : ''}" href="/">
          <i data-lucide="home"></i> Dashboard
        </a>
        <div class="saathi-divider"></div>
        ${linksHTML}
      </nav>
    `;
  }

  function init() {
    injectStyles();
    document.body.insertAdjacentHTML('afterbegin', buildSidebarHTML());
    if (window.lucide) lucide.createIcons();

    const sidebar = document.getElementById('saathi-sidebar');
    const toggle = document.getElementById('saathi-sidebar-toggle');
    const backdrop = document.getElementById('saathi-sidebar-backdrop');

    function closeDrawer() {
      sidebar.classList.remove('open');
      backdrop.classList.remove('open');
    }
    function openDrawer() {
      sidebar.classList.add('open');
      backdrop.classList.add('open');
    }

    toggle.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) closeDrawer();
      else openDrawer();
    });
    backdrop.addEventListener('click', closeDrawer);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
