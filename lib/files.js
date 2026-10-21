// Files a game needs from the player that the launcher can't download (e.g. their own ROM).

const fs = require('fs');

/** Check a .nds file's 4-letter game code (header offset 0x0C). */
function ndsGameCode(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0x0c);
    return buf.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/** Returns null if the file is fine for this requirement, or a message saying what's wrong. */
function checkRequiredFile(req, file) {
  if (!file || !fs.existsSync(file)) return 'File not found.';
  const ext = file.split('.').pop().toLowerCase();
  if (req.extensions && !req.extensions.includes(ext)) {
    return `Expected a .${req.extensions.join(' / .')} file.`;
  }
  if (req.ndsGameCode) {
    const code = ndsGameCode(file);
    if (code !== req.ndsGameCode) {
      return `This ROM's game code is "${code}", but ${req.label} needs "${req.ndsGameCode}".`;
    }
  }
  return null;
}

module.exports = { checkRequiredFile, ndsGameCode };
