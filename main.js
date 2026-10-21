// OnlyLegend: the main process. Owns the window, the library folder, downloads and launching.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const { loadCatalog } = require('./lib/catalog');
const installer = require('./lib/installer');
const { checkRequiredFile } = require('./lib/files');

// Web games are served from game://<id>/... so they can load their own assets with fetch/XHR.
protocol.registerSchemesAsPrivileged([
  { scheme: 'game', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// net.fetch can't stop at a redirect (it throws), and downloads must stop at GitHub's redirect so
// the access key isn't sent on to the storage server. Those requests go through net.request instead.
const { Readable } = require('stream');
function fetchFn(url, opts = {}) {
  if (opts.redirect !== 'manual') return net.fetch(url, opts);
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'manual', headers: opts.headers || {} });
    const abort = () => {
      req.abort();
      reject(Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return abort();
      opts.signal.addEventListener('abort', abort, { once: true });
    }
    req.on('redirect', (status, _method, location) => {
      req.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    req.on('response', (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const body = res.statusCode === 204 || res.statusCode === 304 ? null : Readable.toWeb(res);
      resolve(new Response(body, { status: res.statusCode, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let win;
let catalog = [];
const running = new Map(); // id -> child process or BrowserWindow
const downloads = new Map(); // id -> AbortController

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
let settings = {};
const library = () => settings.libraryDir || path.join(app.getPath('userData'), 'library');
const gameById = (id) => catalog.find((g) => g.id === id);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function gameState(game) {
  const manifest = installer.readManifest(library(), game);
  const req = game.requires;
  const reqFile = req ? (settings.files || {})[`${game.id}:${req.key}`] : null;
  return {
    ...game,
    installed: !!manifest,
    manifest,
    running: running.has(game.id),
    downloading: downloads.has(game.id),
    supported: !game.platforms || game.platforms.includes(process.platform) || canEmulateWindows(game),
    requiredFile: req
      ? { path: reqFile || null, problem: reqFile ? checkRequiredFile(req, reqFile) : 'Not chosen yet.' }
      : null,
  };
}

// Windows-only games can still run on Linux/macOS through Wine if the player has it.
function canEmulateWindows(game) {
  return process.platform !== 'win32' && game.platforms && game.platforms.includes('win32');
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0a10',
    title: 'OnlyLegend',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links in the launcher open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  settings = loadSettings();

  protocol.handle('game', (req) => {
    const url = new URL(req.url);
    const game = gameById(url.hostname);
    if (!game) return new Response('Unknown game', { status: 404 });
    const root = path.resolve(installer.gameDir(library(), game));
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------
ipcMain.handle('catalog:load', async () => {
  const result = await loadCatalog(fetchFn, __dirname, app.getPath('userData'));
  catalog = result.games;
  return { source: result.source, games: catalog.map(gameState), library: library() };
});

ipcMain.handle('game:state', (_e, id) => {
  const g = gameById(id);
  return g ? gameState(g) : null;
});

ipcMain.handle('game:install', async (_e, id) => {
  const game = gameById(id);
  if (!game) throw new Error('Unknown game');
  if (downloads.has(id)) return gameState(game);
  if (running.has(id)) throw new Error(`Close ${game.name} before updating it.`);

  const ctrl = new AbortController();
  downloads.set(id, ctrl);
  send('game:changed', gameState(game));
  try {
    await installer.install(fetchFn, library(), game, (p) => send('game:progress', { id, ...p }), ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('Download cancelled.');
    throw e;
  } finally {
    // Clear the download before building any state, so nothing reports it as still downloading.
    downloads.delete(id);
    send('game:changed', gameState(game));
  }
  return gameState(game);
});

ipcMain.handle('game:cancel', (_e, id) => {
  const ctrl = downloads.get(id);
  if (ctrl) ctrl.abort();
});

ipcMain.handle('game:checkUpdate', async (_e, id) => {
  const game = gameById(id);
  return installer.checkUpdate(fetchFn, library(), game);
});

ipcMain.handle('game:uninstall', async (_e, id) => {
  const game = gameById(id);
  if (running.has(id)) throw new Error(`Close ${game.name} first.`);
  const hasSaves = (game.keepFiles || []).length > 0;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Uninstall',
    message: `Uninstall ${game.name}?`,
    detail: hasSaves ? 'You can keep your save and settings files so nothing is lost if you reinstall.' : '',
    buttons: hasSaves ? ['Uninstall, keep saves', 'Uninstall everything', 'Cancel'] : ['Uninstall', 'Cancel'],
    cancelId: hasSaves ? 2 : 1,
    defaultId: 0,
  });
  if ((hasSaves && response === 2) || (!hasSaves && response === 1)) return gameState(game);
  installer.uninstall(library(), game, hasSaves && response === 0);
  return gameState(game);
});

ipcMain.handle('game:openFolder', (_e, id) => {
  const dir = installer.gameDir(library(), gameById(id));
  if (fs.existsSync(dir)) shell.openPath(dir);
});

ipcMain.handle('game:chooseFile', async (_e, id) => {
  const game = gameById(id);
  const req = game.requires;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: `Choose ${req.label}`,
    properties: ['openFile'],
    filters: req.extensions ? [{ name: req.label, extensions: req.extensions }] : [],
  });
  if (canceled || !filePaths[0]) return gameState(game);
  const problem = checkRequiredFile(req, filePaths[0]);
  if (problem) throw new Error(problem);
  settings.files = { ...(settings.files || {}), [`${id}:${req.key}`]: filePaths[0] };
  saveSettings(settings);
  return gameState(game);
});

ipcMain.handle('game:play', async (_e, id) => {
  const game = gameById(id);
  const state = gameState(game);
  if (!state.installed) throw new Error(`${game.name} isn't installed.`);
  if (state.running) return state;
  if (state.requiredFile && state.requiredFile.problem) {
    throw new Error(`${game.requires.label}: ${state.requiredFile.problem}`);
  }

  const launch = game.launch || { type: 'web' };
  if (launch.type === 'web') {
    playWeb(game, launch);
  } else {
    playExe(game, launch, state);
  }
  send('game:changed', gameState(game));
  return gameState(game);
});

function playWeb(game, launch) {
  const w = new BrowserWindow({
    width: launch.width || 1024,
    height: launch.height || 768,
    title: game.name,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.loadURL(`game://${game.id}/${(launch.entry || 'index.html').replace(/^\/+/, '')}`);
  running.set(game.id, w);
  w.on('closed', () => {
    running.delete(game.id);
    send('game:changed', gameState(game));
  });
}

function playExe(game, launch, state) {
  const exe = installer.findEntry(library(), game);
  if (!exe) throw new Error(`Couldn't find ${launch.entry} in the installed files. Try reinstalling.`);

  const args = [...(launch.args || [])];
  if (state.requiredFile && game.requires.passAs === 'argument') args.push(state.requiredFile.path);

  let cmd = exe;
  let cmdArgs = args;
  if (process.platform !== 'win32' && /\.exe$/i.test(exe)) {
    cmd = 'wine';
    cmdArgs = [exe, ...args];
  }

  const child = spawn(cmd, cmdArgs, { cwd: path.dirname(exe), detached: false, stdio: 'ignore' });
  running.set(game.id, child);
  const done = (err) => {
    if (!running.has(game.id)) return;
    running.delete(game.id);
    send('game:changed', gameState(game));
    if (err) {
      const msg =
        err.code === 'ENOENT' && cmd === 'wine'
          ? `${game.name} is a Windows game. Install Wine to play it on this computer.`
          : `${game.name} couldn't start: ${err.message}`;
      send('toast', { kind: 'error', text: msg });
    }
  };
  child.on('error', done);
  child.on('exit', (code) => {
    if (code) send('toast', { kind: 'info', text: `${game.name} closed (exit code ${code}).` });
    done();
  });
}

ipcMain.handle('library:choose', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where OnlyLegend keeps games',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return library();
  settings.libraryDir = filePaths[0];
  saveSettings(settings);
  return library();
});

ipcMain.handle('library:open', () => {
  fs.mkdirSync(library(), { recursive: true });
  shell.openPath(library());
});

ipcMain.handle('link:open', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
});
