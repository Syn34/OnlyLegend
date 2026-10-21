// Smoke test for the download/install pipeline, run with plain Node: `npm test`.
// Uses a small public repo so it doesn't depend on any game in the catalog.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const installer = require('../lib/installer');
const { validate } = require('../lib/catalog');
const { checkRequiredFile } = require('../lib/files');

(async () => {
  const catalog = validate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'games.json'), 'utf8')));
  assert(catalog.length > 0, 'catalog has games');
  console.log('catalog ok:', catalog.map((g) => g.id).join(', '));

  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-lib-'));
  const game = {
    id: 'smoke', name: 'Smoke', repo: process.env.SMOKE_REPO || 'Syn34/OnlyLegend',
    install: { from: 'branch', branch: process.env.SMOKE_BRANCH || 'main' }, launch: { type: 'web', entry: 'renderer/index.html' },
    keepFiles: ['save.dat'],
  };
  let last;
  const m = await installer.install(fetch, lib, game, (p) => (last = p));
  assert(installer.findEntry(lib, game), 'entry file found after install');
  console.log('installed', m.label, 'last progress', last.stage, last.received, 'bytes');

  fs.writeFileSync(path.join(lib, 'smoke', 'save.dat'), 'progress');
  await installer.install(fetch, lib, game, () => {});
  assert.strictEqual(fs.readFileSync(path.join(lib, 'smoke', 'save.dat'), 'utf8'), 'progress', 'update keeps saves');
  const u = await installer.checkUpdate(fetch, lib, game);
  assert.strictEqual(u.available, false);

  installer.uninstall(lib, game, true);
  assert.deepStrictEqual(fs.readdirSync(path.join(lib, 'smoke')), ['save.dat'], 'uninstall keeping saves');
  installer.uninstall(lib, game, false);
  assert(!fs.existsSync(path.join(lib, 'smoke')));

  // ROM check: fake .nds with game code at 0x0C
  const rom = path.join(lib, 'x.nds');
  const buf = Buffer.alloc(0x200); buf.write('ASSE', 0x0c, 'latin1'); fs.writeFileSync(rom, buf);
  const req = catalog.find((g) => g.requires)?.requires;
  if (req) {
    assert.strictEqual(checkRequiredFile(req, rom), null);
    buf.write('XXXX', 0x0c, 'latin1'); fs.writeFileSync(rom, buf);
    assert(checkRequiredFile(req, rom));
  }
  // Release install from a private repo (what projShadow uses), against a fake GitHub.
  // Checks the key goes to GitHub but never to the storage server the download redirects to.
  const shadow = catalog.find((g) => g.id === 'projshadow');
  if (shadow) {
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-key';
    const exeBytes = Buffer.from('MZ fake exe');
    const seen = [];
    const fakeFetch = async (url, opts = {}) => {
      const auth = (opts.headers || {}).Authorization;
      seen.push([url, auth]);
      const json = (o) => ({ ok: true, status: 200, headers: new Map(), json: async () => o });
      if (!auth && url.startsWith('https://api.github.com')) return { ok: false, status: 404, headers: new Map() };
      if (url.endsWith('/releases/latest')) {
        return json({ tag_name: 'v0.9', name: 'v0.9', assets: [
          { name: 'source.tar.gz', size: 1, url: 'https://api.github.com/assets/1' },
          { name: 'spShadowLegacy.exe', size: exeBytes.length, url: 'https://api.github.com/assets/2' } ] });
      }
      if (url === 'https://api.github.com/assets/2') {
        assert.strictEqual(opts.redirect, 'manual');
        return { ok: false, status: 302, headers: new Map([['location', 'https://storage.example/exe?sig=1']]) };
      }
      if (url.startsWith('https://storage.example/')) {
        assert.strictEqual(auth, undefined, 'key must not be sent to the storage server');
        return { ok: true, status: 200, headers: new Map([['content-length', String(exeBytes.length)]]),
          body: new Blob([exeBytes]).stream() };
      }
      throw new Error('unexpected ' + url);
    };
    const sm = await installer.install(fakeFetch, lib, shadow, () => {});
    assert.strictEqual(sm.version, 'v0.9');
    assert(installer.findEntry(lib, shadow).endsWith('spShadowLegacy.exe'), 'release exe installed');
    assert(seen.some(([u, a]) => u.endsWith('/releases/latest') && a === 'Bearer test-key'), 'key sent to GitHub');

    delete process.env.GITHUB_TOKEN;
    await assert.rejects(installer.install(fakeFetch, lib, shadow, () => {}), /private/, 'clear error without a key');
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    console.log('private release install ok:', sm.label);
  }

  fs.rmSync(lib, { recursive: true, force: true });
  console.log('all smoke tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
