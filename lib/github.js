// Talks to GitHub: works out what to download for a game and downloads it.
// `fetchFn` is injected so this module runs both in Electron (net.fetch) and in plain Node (tests).

const fs = require('fs');

const API = 'https://api.github.com';
const HEADERS = {
  'User-Agent': 'OnlyLegend-Launcher',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

class GitHubError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function apiGet(fetchFn, path) {
  const res = await fetchFn(API + path, { headers: HEADERS });
  if (res.status === 404) return null;
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = res.headers.get('x-ratelimit-reset');
    const when = reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : '';
    throw new GitHubError(`GitHub is limiting requests right now.${when}`, 'RATE_LIMIT');
  }
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} for ${path}`, 'HTTP');
  return res.json();
}

/**
 * Work out what to download for a catalog entry.
 * Returns { version, url, fileName, size, kind: 'zip' | 'file', label }.
 */
async function resolveDownload(fetchFn, game) {
  const src = game.install || {};
  const repo = game.repo;

  if (src.from === 'release') {
    const release = src.prerelease
      ? ((await apiGet(fetchFn, `/repos/${repo}/releases?per_page=10`)) || [])[0]
      : await apiGet(fetchFn, `/repos/${repo}/releases/latest`);
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
      url: asset.browser_download_url,
      fileName: asset.name,
      size: asset.size,
      kind: /\.zip$/i.test(asset.name) ? 'zip' : 'file',
    };
  }

  // Default: a snapshot of a branch (good for games that run straight from source, e.g. web games).
  const branch = src.branch || 'main';
  const commit = await apiGet(fetchFn, `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  if (!commit) throw new GitHubError(`Couldn't find branch "${branch}" in ${repo}.`, 'NO_BRANCH');
  return {
    version: commit.sha,
    label: `${branch} @ ${commit.sha.slice(0, 7)}`,
    url: `https://codeload.github.com/${repo}/zip/${commit.sha}`,
    fileName: `${repo.replace('/', '-')}-${commit.sha.slice(0, 7)}.zip`,
    size: 0,
    kind: 'zip',
  };
}

/** Stream a URL to a file, calling onProgress({ received, total }). Follows redirects. */
async function downloadTo(fetchFn, url, destFile, onProgress, signal) {
  const res = await fetchFn(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal });
  if (!res.ok) throw new GitHubError(`Download failed (${res.status})`, 'HTTP');
  const total = Number(res.headers.get('content-length')) || 0;
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

module.exports = { resolveDownload, downloadTo, GitHubError };
