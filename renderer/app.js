// OnlyLegend launcher UI.
const api = window.onlylegend;
const $ = (sel) => document.querySelector(sel);

let games = [];
let selected = null;
const progress = {}; // id -> latest progress event
const updates = {}; // id -> { available, latest, label }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  return name.split(/[\s:]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function shortVersion(v) {
  return /^[0-9a-f]{40}$/.test(v || '') ? v.slice(0, 7) : v;
}

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4500);
}

async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  }
}

function upsert(state) {
  if (!state) return;
  const i = games.findIndex((g) => g.id === state.id);
  if (i >= 0) games[i] = state;
  render();
}

function statusOf(g) {
  if (g.downloading) return { text: 'Downloading…', cls: 'busy' };
  if (g.running) return { text: 'Playing', cls: 'busy' };
  if (updates[g.id]?.available) return { text: 'Update available', cls: 'busy' };
  if (g.installed) return { text: 'Installed', cls: 'ready' };
  return { text: 'Not installed', cls: '' };
}

// ---------- sidebar ----------
function renderList() {
  const nav = $('#game-list');
  nav.innerHTML = games
    .map((g) => {
      const s = statusOf(g);
      return `<button class="game-item ${g.id === selected ? 'active' : ''}" data-id="${esc(g.id)}" style="--item-color:${esc(g.color || '#7b3fe4')}">
        <span class="game-icon">${esc(initials(g.name))}</span>
        <span class="game-item-text">
          <div class="game-item-name">${esc(g.name)}</div>
          <div class="game-item-status ${s.cls}">${esc(s.text)}</div>
        </span>
      </button>`;
    })
    .join('');
  nav.querySelectorAll('.game-item').forEach((b) =>
    b.addEventListener('click', () => {
      selected = b.dataset.id;
      render();
    })
  );
}

// ---------- detail ----------
function renderProgress(g) {
  const p = progress[g.id] || { stage: 'resolving' };
  const total = p.total || p.size || 0;
  const pct = total ? Math.min(100, Math.round((p.received / total) * 100)) : null;
  const label =
    p.stage === 'resolving' ? 'Finding the latest version…'
    : p.stage === 'installing' ? 'Installing…'
    : total ? `${fmtBytes(p.received)} of ${fmtBytes(total)}`
    : `${fmtBytes(p.received || 0)} downloaded`;
  const indeterminate = p.stage !== 'downloading' || pct === null;
  return `<div class="progress">
      <div class="progress-top"><span>${esc(label)}</span><span>${pct !== null && !indeterminate ? pct + '%' : ''}</span></div>
      <div class="progress-bar ${indeterminate ? 'indeterminate' : ''}"><div class="progress-fill" style="${indeterminate ? '' : `width:${pct}%`}"></div></div>
    </div>
    <button class="btn btn-ghost" data-act="cancel">Cancel</button>`;
}

function renderActions(g) {
  if (g.downloading) return renderProgress(g);
  if (!g.installed) {
    return `<button class="btn btn-primary" data-act="install">Download</button>`;
  }
  const blocked = g.requiredFile && g.requiredFile.problem;
  const upd = updates[g.id];
  return `<button class="btn btn-primary btn-play" data-act="play" ${g.running || blocked ? 'disabled' : ''}>
      ${g.running ? 'Playing' : 'Play'}
    </button>
    ${upd?.available ? `<button class="btn" data-act="install">Update to ${esc(shortVersion(upd.latest))}</button>` : ''}`;
}

function renderRequirement(g) {
  if (!g.requires) return '';
  const r = g.requiredFile;
  const ok = !r.problem;
  return `<div class="card">
    <h2>Needed to play</h2>
    <div class="req ${ok ? 'ok' : ''}">
      <span class="req-dot"></span>
      <div style="min-width:0;flex:1">
        <div class="req-title">${esc(g.requires.label)}</div>
        <div class="req-help">${esc(g.requires.help || '')}</div>
        ${r.path ? `<div class="req-path">${esc(r.path)}</div>` : ''}
        ${!ok && r.path ? `<div class="req-problem">${esc(r.problem)}</div>` : ''}
        <button class="btn" data-act="choose">${r.path ? 'Change file…' : 'Choose file…'}</button>
      </div>
    </div>
  </div>`;
}

function renderDetail() {
  const g = games.find((x) => x.id === selected);
  const main = $('#detail');
  if (!g) {
    main.innerHTML = `<div class="empty">${games.length ? 'Pick a game.' : 'No games in the catalog yet.'}</div>`;
    return;
  }
  const m = g.manifest;
  const repoUrl = `https://github.com/${g.repo}`;
  const winOnly = g.platforms && g.platforms.length === 1 && g.platforms[0] === 'win32';
  const notWindows = !navigator.userAgent.includes('Windows');

  main.style.setProperty('--game-color', g.color || '#7b3fe4');
  main.innerHTML = `
    <section class="hero">
      <div class="hero-kicker">${g.installed ? 'In your library' : 'Available'}</div>
      <h1>${esc(g.name)}</h1>
      ${g.subtitle ? `<div class="hero-sub">${esc(g.subtitle)}</div>` : ''}
      ${g.description ? `<p class="hero-desc">${esc(g.description)}</p>` : ''}
      ${winOnly && notWindows ? `<div class="notice">This is a Windows game. On this computer it runs through Wine, if Wine is installed.</div>` : ''}
      <div class="actions">${renderActions(g)}</div>
    </section>
    <section class="body">
      <div>
        ${renderRequirement(g)}
        <div class="card">
          <h2>About</h2>
          <dl class="facts">
            <dt>Source</dt><dd><a data-link="${esc(repoUrl)}">${esc(g.repo)}</a></dd>
            <dt>Installs from</dt><dd>${g.install?.from === 'release' ? 'Latest GitHub release' : `Branch ${esc(g.install?.branch || 'main')}`}</dd>
            ${m ? `<dt>Installed</dt><dd>${esc(m.label || shortVersion(m.version))} · ${esc(new Date(m.installedAt).toLocaleDateString())}</dd>` : ''}
            ${g.platforms ? `<dt>Platform</dt><dd>${g.platforms.map((p) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[p] || p)).join(', ')}</dd>` : ''}
          </dl>
        </div>
      </div>
      <div>
        <div class="card">
          <h2>Manage</h2>
          <div class="side-actions">
            ${g.installed ? `<button class="btn" data-act="check" ${g.downloading ? 'disabled' : ''}>Check for updates</button>` : ''}
            ${g.installed ? `<button class="btn" data-act="folder">Open game folder</button>` : ''}
            ${g.installed ? `<button class="btn btn-danger" data-act="uninstall" ${g.running || g.downloading ? 'disabled' : ''}>Uninstall</button>` : ''}
            ${!g.installed ? `<div style="color:var(--muted);line-height:1.5">Download installs the game into your OnlyLegend library. You play it from here.</div>` : ''}
          </div>
        </div>
      </div>
    </section>`;

  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(g.id, b.dataset.act)));
  main.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', () => api.openLink(a.dataset.link)));
}

function render() {
  renderList();
  renderDetail();
}

async function act(id, what) {
  const g = games.find((x) => x.id === id);
  switch (what) {
    case 'install': {
      const wasInstalled = g.installed;
      progress[id] = { stage: 'resolving' };
      const res = await run(() => api.install(id));
      if (res) {
        delete updates[id];
        upsert(res);
        toast(`${g.name} ${wasInstalled ? 'updated' : 'installed'}.`, 'ok');
      }
      break;
    }
    case 'cancel':
      await api.cancel(id);
      break;
    case 'play':
      upsert(await run(() => api.play(id)));
      break;
    case 'choose':
      upsert(await run(() => api.chooseFile(id)));
      break;
    case 'folder':
      api.openFolder(id);
      break;
    case 'uninstall':
      upsert(await run(() => api.uninstall(id)));
      break;
    case 'check': {
      const u = await run(() => api.checkUpdate(id));
      if (u) {
        updates[id] = u;
        render();
        if (!u.available) toast(`${g.name} is up to date.`, 'ok');
      }
      break;
    }
  }
}

// ---------- events ----------
api.on('game:progress', (p) => {
  progress[p.id] = p;
  if (p.id === selected) {
    const g = games.find((x) => x.id === p.id);
    const actions = document.querySelector('.actions');
    if (g && g.downloading && actions) {
      actions.innerHTML = renderProgress(g);
      actions.querySelector('[data-act=cancel]').addEventListener('click', () => act(g.id, 'cancel'));
    }
  }
});
api.on('game:changed', upsert);
api.on('toast', (t) => toast(t.text, t.kind));

$('#library-btn').addEventListener('click', () => api.openLibrary());
$('#library-change').addEventListener('click', async () => {
  const dir = await run(() => api.chooseLibrary());
  if (dir) {
    $('#library-btn').title = dir;
    toast(`Games will be kept in ${dir}. Games already installed elsewhere need reinstalling.`);
    load();
  }
});

async function load() {
  const res = await run(() => api.loadCatalog());
  if (!res) return;
  games = res.games;
  $('#library-btn').title = res.library;
  $('#catalog-source').textContent =
    res.source === 'online' ? `${games.length} game${games.length === 1 ? '' : 's'} · up to date` : 'Offline · showing saved list';
  if (!games.find((g) => g.id === selected)) selected = games[0]?.id ?? null;
  render();

  // Quietly look for updates to installed games.
  for (const g of games.filter((x) => x.installed)) {
    api.checkUpdate(g.id).then((u) => { updates[g.id] = u; render(); }).catch(() => {});
  }
}

load();
