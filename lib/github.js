// Talks to GitHub: works out what to download for a game and downloads it.
// `fetchFn` is injected so this module runs both in Electron (net.fetch) and in plain Node (tests).
//
// Private game repos are reached with an access key that is built into the launcher at build time
// (lib/token.js, written by scripts/inject-token.js; never committed). Without one, public repos
// still work.

const fs = require('fs');

const API = 'https://api.github.com';
const UA = 'OnlyLegend-Launcher';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

class GitHubError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function bundledToken() {
  try {
    const t = require('./token');
    return typeof t === 'function' ? t() : null;
  } catch {
    return null;
  }
}

/** The key to use: GITHUB_TOKEN (CI and testing), else the one built into the launcher. */
function token() {
  return process.env.GITHUB_TOKEN || bundledToken();
}

function authHeaders(extra) {
  const t = token();
  return { ...HEADERS, ...extra, ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

function rateLimitError(res) {
  const reset = res.headers.get('x-ratelimit-reset');
  const when = reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : '';
  return new GitHubError(`GitHub is limiting requests right now.${when}`, 'RATE_LIMIT');
}

async function apiGet(fetchFn, path, repo) {
  const res = await fetchFn(API + path, { headers: authHeaders() });
  if (res.status === 401) {
    throw new GitHubError(
      "OnlyLegend's access key was refused by GitHub (it may have expired). A new launcher build is needed.",
      'AUTH'
    );
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    throw rateLimitError(res);
  }
  if (res.status === 404) {
    // GitHub answers 404 for private repos it won't show, so check whether the repo is reachable at all.
    if (repo && path !== `/repos/${repo}`) {
      const r = await fetchFn(`${API}/repos/${repo}`, { headers: authHeaders() });
      if (r.status === 404) {
        throw new GitHubError(
          token()
            ? `OnlyLegend's access key can't see ${repo}. The key needs read access to that repository.`
            : `${repo} is private, and this launcher build has no access key for it.`,
          'NO_ACCESS'
        );
      }
    }
    return null;
  }
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} for ${path}`, 'HTTP');
  return res.json();
}

/**
 * Work out what to download for a catalog entry.
 * Returns { version, url, headers, fileName, size, kind: 'zip' | 'file', label }.
 */
async function resolveDownload(fetchFn, game) {
  const src = game.install || {};
  const repo = game.repo;

  if (src.from === 'release') {
    const release = src.prerelease
      ? ((await apiGet(fetchFn, `/repos/${repo}/releases?per_page=10`, repo)) || [])[0]
      : await apiGet(fetchFn, `/repos/${repo}/releases/latest`, repo);
    if (!release) {
      throw new GitHubError(`${game.name} has no published release on GitHub yet.`, 'NO_RELEASE');
    }
    const pattern = new RegExp(src.asset || '.*', 'i');
    const asset = (release.assets || []).find((a) => pattern.test(a.name));
    if (!asset) {
      throw new GitHubError(
        `The latest ${game.name} release (${release.tag_name}) has no file matching "${src.asset}".`,
        'NO_ASSET'
      );
    }
    return {
      version: release.tag_name,
      label: release.name || release.tag_name,
      // The API address works for private repos too (the browser link doesn't).
      url: asset.url,
      api: true,
      accept: 'application/octet-stream',
      fileName: asset.name,
      size: asset.size,
      kind: /\.zip$/i.test(asset.name) ? 'zip' : 'file',
    };
  }

  // Default: a snapshot of a branch (good for games that run straight from source, e.g. web games).
  const branch = src.branch || 'main';
  const commit = await apiGet(fetchFn, `/repos/${repo}/commits/${encodeURIComponent(branch)}`, repo);
  if (!commit) throw new GitHubError(`Couldn't find branch "${branch}" in ${repo}.`, 'NO_BRANCH');
  return {
    version: commit.sha,
    label: `${branch} @ ${commit.sha.slice(0, 7)}`,
    url: `${API}/repos/${repo}/zipball/${commit.sha}`,
    api: true,
    fileName: `${repo.replace('/', '-')}-${commit.sha.slice(0, 7)}.zip`,
    size: 0,
    kind: 'zip',
  };
}

/**
 * Open a download. GitHub answers API download addresses with a redirect to a short-lived storage
 * link; the key goes only to GitHub, never to the storage server, so redirects are followed by hand.
 */
async function openDownload(fetchFn, pick, signal) {
  let url = pick.url;
  let headers = pick.api ? authHeaders(pick.accept ? { Accept: pick.accept } : {}) : { 'User-Agent': UA };
  for (let hops = 0; hops < 5; hops++) {
    const res = await fetchFn(url, { headers, signal, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== new URL(url).origin) headers = { 'User-Agent': UA };
      url = next.toString();
      continue;
    }
    if (res.status === 401) throw new GitHubError("OnlyLegend's access key was refused by GitHub.", 'AUTH');
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      throw rateLimitError(res);
    }
    if (!res.ok) throw new GitHubError(`Download failed (${res.status})`, 'HTTP');
    return res;
  }
  throw new GitHubError('Download failed (too many redirects)', 'HTTP');
}

/** Stream a download to a file, calling onProgress({ received, total }). */
async function downloadTo(fetchFn, pick, destFile, onProgress, signal) {
  const res = await openDownload(fetchFn, pick, signal);
  const total = Number(res.headers.get('content-length')) || pick.size || 0;
  const out = fs.createWriteStream(destFile);
  let received = 0;
  let last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - last > 100) {
        last = now;
        onProgress({ received, total });
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (onProgress) onProgress({ received, total: total || received });
  return received;
}

module.exports = { resolveDownload, downloadTo, GitHubError, token };
