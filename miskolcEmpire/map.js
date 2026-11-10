// Térkép-generálás: g fű, d föld, r út, c beton, w víz (blokkol), x romok (blokkol)
const { createRng } = require('./rng');
const { MAP_SIZES } = require('./content');

const BLOCKING = new Set(['w', 'x']);

function startPositions(w, h, n) {
  const m = 11;
  const corners = [[m, m], [w - m - 3, h - m - 3], [w - m - 3, m], [m, h - m - 3]];
  if (n === 2) return [corners[0], corners[1]];
  if (n === 3) return [corners[0], corners[2], corners[3]];
  return corners;
}

function floodConnected(tiles, w, h, starts) {
  const seen = new Uint8Array(w * h);
  const stack = [starts[0][1] * w + starts[0][0]];
  seen[stack[0]] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (seen[q] || BLOCKING.has(tiles[q])) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return starts.every(([sx, sy]) => seen[(sy + 1) * w + sx + 1]);
}

function attempt(seed, playerCount) {
  const rng = createRng(seed);
  const size = MAP_SIZES[playerCount] || 64;
  const w = size;
  const h = size;
  const tiles = new Array(w * h).fill('g');
  const starts = startPositions(w, h, playerCount);
  const nearStart = (x, y, r) => starts.some(([sx, sy]) => Math.hypot(x - sx - 1, y - sy - 1) < r);

  const blob = (cx, cy, r, ch, safe) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        if (Math.hypot(x - cx, y - cy) > r * (0.7 + rng() * 0.3)) continue;
        if (safe && nearStart(x, y, 12)) continue;
        tiles[y * w + x] = ch;
      }
    }
  };

  for (let i = 0; i < w * h / 90; i++) blob(rng.range(0, w), rng.range(0, h), rng.range(2, 5), 'd', false);
  // Utak a bázisok között
  for (let i = 1; i < starts.length; i++) {
    let [x, y] = [starts[0][0] + 1, starts[0][1] + 1];
    const [ex, ey] = [starts[i][0] + 1, starts[i][1] + 1];
    while (x !== ex || y !== ey) {
      tiles[y * w + x] = 'r';
      if (Math.abs(ex - x) > Math.abs(ey - y)) x += Math.sign(ex - x); else y += Math.sign(ey - y);
    }
  }
  // Panelházas betonfoltok a bázisok körül
  for (const [sx, sy] of starts) blob(sx + 1, sy + 1, 6, 'c', false);
  // Tavak és romok
  for (let i = 0; i < Math.round(w / 12); i++) blob(rng.range(8, w - 8), rng.range(8, h - 8), rng.range(2, 4), 'w', true);
  for (let i = 0; i < Math.round(w / 8); i++) blob(rng.range(6, w - 6), rng.range(6, h - 6), rng.range(1, 2.4), 'x', true);

  const nodes = [];
  const free = (x, y) => x >= 1 && y >= 1 && x < w - 1 && y < h - 1 && !BLOCKING.has(tiles[y * w + x]) && !nodes.some((n) => n.x === x && n.y === y)
    && !starts.some(([sx, sy]) => x >= sx - 1 && x <= sx + 3 && y >= sy - 1 && y <= sy + 3);
  const cluster = (k, cx, cy, count, amount, spread) => {
    let placed = 0;
    for (let guard = 0; placed < count && guard < 80; guard++) {
      const x = Math.round(cx + rng.range(-spread, spread));
      const y = Math.round(cy + rng.range(-spread, spread));
      if (!free(x, y)) continue;
      nodes.push({ k, x, y, a: amount });
      placed++;
    }
  };
  starts.forEach(([sx, sy]) => {
    const cx = sx + 1;
    const cy = sy + 1;
    const dir = [cx < w / 2 ? 1 : -1, cy < h / 2 ? 1 : -1];
    cluster('iron', cx + dir[0] * 7, cy - dir[1] * 3, 4, 2400, 2);
    cluster('copper', cx - dir[0] * 3, cy + dir[1] * 7, 3, 2200, 2);
    cluster('food', cx + dir[0] * 3, cy + dir[1] * 5, 4, 1800, 2);
    cluster('wood', cx - dir[0] * 6, cy - dir[1] * 2, 5, 1500, 2);
  });
  // Semleges készletek középen és oldalt
  for (const k of ['iron', 'copper', 'food', 'wood']) {
    cluster(k, w / 2, h / 2, 3, k === 'wood' || k === 'food' ? 2400 : 3000, 6);
    cluster(k, rng.range(w * 0.3, w * 0.7), rng.range(h * 0.2, h * 0.8), 3, k === 'wood' || k === 'food' ? 1700 : 2100, 4);
  }
  return { w, h, tiles: tiles.join(''), starts, nodes, ok: floodConnected(tiles, w, h, starts) };
}

function generateMap(seed, playerCount) {
  const count = Math.min(4, Math.max(2, playerCount | 0));
  for (let i = 0; i < 12; i++) {
    const m = attempt((Number(seed) >>> 0) + i * 7919, count);
    if (m.ok) return m;
  }
  // Végső tartalék: üres fűtérkép
  const m = attempt(1, count);
  const size = m.w;
  const tiles = 'g'.repeat(size * size);
  return { ...m, tiles, ok: true };
}

module.exports = { generateMap, BLOCKING };
