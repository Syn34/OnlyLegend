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
  fs.rmSync(lib, { recursive: true, force: true });
  console.log('all smoke tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
