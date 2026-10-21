// The game list. Only games you put in games.json appear in the launcher.
// The launcher reads the latest games.json from the OnlyLegend repo on GitHub, so adding a game
// there reaches every player without a new launcher build. If GitHub can't be reached it falls back
// to the copy bundled with the app (and then to the last copy it downloaded).

const fs = require('fs');
const path = require('path');

const REMOTE_URL = 'https://raw.githubusercontent.com/Syn34/OnlyLegend/main/games.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validate(list) {
  if (!Array.isArray(list)) throw new Error('games.json must be a list');
  const seen = new Set();
  return list.filter((g) => {
    const ok =
      g && ID_RE.test(g.id) && REPO_RE.test(g.repo) && typeof g.name === 'string' && !seen.has(g.id);
    if (ok) seen.add(g.id);
    else console.warn('[catalog] skipping invalid entry', g && g.id);
    return ok;
  });
}

async function loadCatalog(fetchFn, appDir, cacheDir) {
  const bundled = path.join(appDir, 'games.json');
  const cached = path.join(cacheDir, 'games.cache.json');

  try {
    const res = await fetchFn(REMOTE_URL + '?t=' + Date.now(), {
      headers: { 'User-Agent': 'OnlyLegend-Launcher' },
    });
    if (res.ok) {
      const list = validate(await res.json());
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cached, JSON.stringify(list, null, 2));
      return { games: list, source: 'online' };
    }
  } catch (e) {
    console.warn('[catalog] online list unavailable:', e.message);
  }

  for (const file of [cached, bundled]) {
    try {
      return { games: validate(JSON.parse(fs.readFileSync(file, 'utf8'))), source: 'offline' };
    } catch {
      /* try the next one */
    }
  }
  return { games: [], source: 'none' };
}

module.exports = { loadCatalog, validate, REMOTE_URL };
