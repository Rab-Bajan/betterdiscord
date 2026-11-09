const { EmpireMatch } = require('../simulation');
const { createAi } = require('../ai');

function makeMatch(opts = {}) {
  const players = opts.players || [{ name: 'Egy', team: 0 }, { name: 'Kettő', team: 1 }];
  return new EmpireMatch({ seed: opts.seed ?? 11, players, createAi: opts.ai ? createAi : null });
}
const stepN = (m, n) => { for (let i = 0; i < n; i++) m.step(); };
const own = (m, idx, kind) => [...m.units.values()].filter((u) => u.o === idx && (!kind || u.k === kind));
const ownB = (m, idx, kind) => [...m.buildings.values()].filter((b) => b.o === idx && (!kind || b.k === kind));
const rich = (m, idx) => { Object.assign(m.players[idx].res, { iron: 5000, copper: 5000, food: 5000, wood: 5000 }); };
// Szabad hely egy játékos bázisa mellett (körkörös keresés)
function freeSpot(m, idx, size = 2) {
  const tc = ownB(m, idx, 'townCenter')[0];
  for (let r = 4; r < 20; r++) for (let dx = -r; dx <= r; dx++) for (const dy of [-r, r]) {
    const x = tc.x + dx;
    const y = tc.y + dy;
    if (!m.checkPlacement(x, y, size)) return [x, y];
  }
  throw new Error('nincs hely');
}
module.exports = { makeMatch, stepN, own, ownB, rich, freeSpot, createAi };
