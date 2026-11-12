// The frontend lives in a separate repo checked out next to this one (../betterdiscord-frontend).
// Some backend tests import frontend code to prove client/server logic stays identical.
// Files may sit at their new feature-folder path or the old one, so the two repos can be
// merged in either order; resolution fails loudly if neither exists.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FRONTEND_SRC = path.resolve(__dirname, '../../../betterdiscord-frontend/src');

/** Known frontend files that moved during the restructure: name -> [new path, old path]. */
const FRONTEND_FILES = {
  movement: ['features/games/arena/lib/movement.js', 'game/movement.js']
};

function resolveFrontendFile(name) {
  const candidates = FRONTEND_FILES[name];
  if (!candidates) throw new Error(`Unknown frontend file "${name}"`);
  const absolute = candidates.map((rel) => path.join(FRONTEND_SRC, rel));
  const found = absolute.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Frontend file "${name}" not found; looked in: ${absolute.join(', ')}`);
  return found;
}

/** Dynamically imports a known frontend ESM module. */
function importFrontendModule(name) {
  return import(pathToFileURL(resolveFrontendFile(name)).href);
}

module.exports = { resolveFrontendFile, importFrontendModule };
