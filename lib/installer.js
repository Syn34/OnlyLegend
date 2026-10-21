// Installs, updates and removes games in the launcher's library folder.
// Each game lives in <library>/<id>/ with a manifest, .onlylegend.json, recording what was installed.

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { resolveDownload, downloadTo } = require('./github');

const MANIFEST = '.onlylegend.json';

function gameDir(library, game) {
  return path.join(library, game.id);
}

function readManifest(library, game) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gameDir(library, game), MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/** Extract a zip safely (no paths outside dest), dropping a single shared top-level folder. */
function extractZip(zipFile, dest) {
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0] + '/' : '';
  const root = path.resolve(dest);

  for (const entry of entries) {
    let name = entry.entryName.replace(/\\/g, '/');
    if (strip) name = name.slice(strip.length);
    if (!name) continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to extract "${entry.entryName}": it points outside the game folder.`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      const mode = (entry.attr >>> 16) & 0o777;
      if (mode & 0o111) fs.chmodSync(target, 0o755);
    }
  }
}

/**
 * Install or update a game. Files already in the folder that the download doesn't contain
 * (saves, settings) are left alone, so updating never loses progress.
 */
async function install(fetchFn, library, game, onProgress, signal) {
  onProgress({ stage: 'resolving' });
  const pick = await resolveDownload(fetchFn, game);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlylegend-'));
  const tmpFile = path.join(tmpDir, pick.fileName);
  try {
    await downloadTo(
      fetchFn,
      pick,
      tmpFile,
      (p) => onProgress({ stage: 'downloading', ...p, size: pick.size }),
      signal
    );

    onProgress({ stage: 'installing' });
    const dir = gameDir(library, game);
    fs.mkdirSync(dir, { recursive: true });
    if (pick.kind === 'zip') {
      extractZip(tmpFile, dir);
    } else {
      const target = path.join(dir, pick.fileName);
      fs.copyFileSync(tmpFile, target);
      fs.chmodSync(target, 0o755);
    }

    const manifest = {
      id: game.id,
      repo: game.repo,
      version: pick.version,
      label: pick.label,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Returns { available, latest, label } without downloading anything. */
async function checkUpdate(fetchFn, library, game) {
  const current = readManifest(library, game);
  const pick = await resolveDownload(fetchFn, game);
  return {
    available: !!current && current.version !== pick.version,
    latest: pick.version,
    label: pick.label,
  };
}

/** Remove a game. With keepSaves, the files listed in the game's keepFiles stay behind. */
function uninstall(library, game, keepSaves) {
  const dir = gameDir(library, game);
  const keep = new Set(keepSaves ? game.keepFiles || [] : []);
  if (!keep.size) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Find the file to run inside the game folder (exact path, or first match of a regex). */
function findEntry(library, game) {
  const dir = gameDir(library, game);
  const launch = game.launch || {};
  const wanted = launch.entry || 'index.html';
  const direct = path.join(dir, wanted);
  if (fs.existsSync(direct)) return direct;

  const pattern = launch.entryPattern ? new RegExp(launch.entryPattern, 'i') : null;
  if (!pattern) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (pattern.test(e.name)) return p;
    }
  }
  return null;
}

module.exports = { install, uninstall, checkUpdate, readManifest, findEntry, gameDir, extractZip };
