# OnlyLegend

A Windows game launcher for a hand-picked set of games hosted on GitHub. Pick a game, press
**Download**, and OnlyLegend fetches it from GitHub into its own library. Press **Play** and it
runs from the launcher. Updates, uninstalling (with your saves kept) and any files a game needs
from you, such as your own ROM, are handled in the same place.

## Get it

Download from [Releases](https://github.com/Syn34/OnlyLegend/releases):

* `OnlyLegend-Setup-x.y.z.exe`: installer with Start-menu and desktop shortcuts
* `OnlyLegend-x.y.z-portable.exe`: a single exe, nothing to install

Games are kept in `%APPDATA%\OnlyLegend\library\<game>` (changeable from the sidebar).

## The game list

Only the games in [`games.json`](games.json) appear in the launcher. The launcher reads that file
from this repo's `main` branch every time it starts, so **adding or editing a game here reaches
every player without a new launcher release**. Offline, it uses the last list it downloaded, or the
copy built into the exe.

An entry looks like this:

```json
{
  "id": "projshadow",                       // lowercase, unique; also the library folder name
  "name": "Spyro: Shadow Legacy",
  "subtitle": "Native PC port (projShadow)",
  "repo": "Syn34/projShadow",               // owner/repo on GitHub
  "description": "Shown on the game's page.",
  "color": "#7b3fe4",                       // accent colour for the game's page and icon
  "platforms": ["win32"],

  "install": {
    "from": "release",                      // "release": a file from the latest GitHub Release
    "asset": "^spShadowLegacy.*\\.(exe|zip)$" //   regex for which release file to download
  },                                        // or { "from": "branch", "branch": "main" }: the repo's files

  "launch": {
    "type": "exe",                          // "exe": run a program, "web": open index.html in a game window
    "entry": "spShadowLegacy.exe",          // path inside the download
    "entryPattern": "^spShadowLegacy\\.exe$", // fallback: first file anywhere matching this
    "args": []
  },

  "requires": {                             // optional: a file the player must supply
    "key": "rom",
    "label": "Spyro: Shadow Legacy (USA) ROM",
    "help": "Shown under the file picker.",
    "extensions": ["nds"],
    "ndsGameCode": "ASSE",                  // .nds files are checked against this
    "passAs": "argument"                    // given to the game on its command line
  },

  "keepFiles": ["spyro.sav", "spyro.ini"]   // offered to keep when uninstalling
}
```

Zip downloads are unpacked into the game's folder (a single top-level folder in the zip is
dropped). Updating unpacks over the old version, so saves and settings the game wrote stay.

### Getting a game ready for OnlyLegend

A game that installs `from: "release"` needs a published GitHub Release whose files include one
matching `asset`. For **projShadow**, that means a release with `spShadowLegacy.exe` attached (or a
`.zip` containing it); until one exists the launcher says the game has no release yet.
The exe is built from the projShadow repo with `python3 tools/pcbuild.py`, and the player's ROM
is never part of the release: OnlyLegend asks each player for their own.

### Private game repos

OnlyLegend can download from private repos with an access key built into the launcher. The key is
never in this repository: `scripts/inject-token.js` adds it at build time from the
`OL_GITHUB_TOKEN` secret (GitHub Actions) or environment variable (local builds).

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   resource owner **Syn34**, *Only select repositories* → the private game repos,
   permissions → **Contents: Read-only**. Nothing else.
2. In this repo: *Settings → Secrets and variables → Actions → New repository secret*,
   name `OL_GITHUB_TOKEN`, value the token.
3. Push or run the workflow; the exe it builds can download those repos.

Anyone with the exe can recover the key, so it must stay read-only and limited to the game repos.
When it expires, launchers already handed out stop downloading until players get a new build.

## Building

```sh
npm install
npm start          # run the launcher from source
npm test           # download/install/update/uninstall smoke test
npm run dist:win   # dist/OnlyLegend-Setup-*.exe and dist/OnlyLegend-*-portable.exe
```

Building the Windows exe on Linux needs Wine. GitHub Actions builds it on every push
(see the run's *Artifacts*), and pushing a tag publishes a release:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

## How it's put together

| File | What it does |
|---|---|
| `main.js` | Electron main process: window, library, downloads, launching games |
| `preload.js` | the small API the interface may call |
| `lib/catalog.js` | loads and checks `games.json` (online, then cached, then built-in) |
| `lib/github.js` | finds the latest release file or branch commit and downloads it with progress |
| `lib/installer.js` | safe unzip, install/update/uninstall, finding the file to run |
| `lib/files.js` | checks files the player supplies (e.g. a ROM's game code) |
| `renderer/` | the interface |

Web games are served to their window from a private `game://` address so they can load their own
assets; the launcher's pages have no access to Node or the file system.
