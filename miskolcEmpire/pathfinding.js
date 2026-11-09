// A* rácson, oktális mozgással, sarokvágás tiltással és egyenesítéssel (string pulling).
// A blocked tömb tile-onként nem nulla, ha az útban van.

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

class Pathfinder {
  constructor(w, h, blocked) {
    this.w = w; this.h = h; this.blocked = blocked;
    const n = w * h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.run = 0;
    this.heap = new MinHeap();
    this.expanded = 0; // utolsó keresés lépésszáma
  }

  isFree(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.blocked[y * this.w + x] === 0;
  }

  // Egyenes látótér a (x0,y0) és (x1,y1) pont között (lebegőpontos tile-koordináták)
  lineClear(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isFree(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t))) return false;
    }
    return true;
  }

  // Legközelebbi szabad tile egy adott pont körül
  nearestFree(x, y, maxR = 12) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (this.isFree(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxR; r++) {
      let best = null;
      let bd = Infinity;
      for (let yy = cy - r; yy <= cy + r; yy++) {
        for (let xx = cx - r; xx <= cx + r; xx++) {
          if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r || !this.isFree(xx, yy)) continue;
          const d = (xx + 0.5 - x) ** 2 + (yy + 0.5 - y) ** 2;
          if (d < bd) { bd = d; best = [xx, yy]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // goal: { x0,y0,x1,y1 } tile téglalap (zárt), reach: ennyi tile-lel a téglalaptól még célnak számít.
  // Visszatér: lapos [x,y,...] útvonal tile-középpontokkal, vagy null. partial esetén a legközelebbi pontig megy.
  find(sx, sy, goal, reach, maxExpand = 4000) {
    const { w, h, blocked, g, parent, stamp, closed, heap } = this;
    const start = this.nearestFree(sx, sy, 3);
    if (!start) return null;
    const gcx = (goal.x0 + goal.x1) / 2 + 0.5;
    const gcy = (goal.y0 + goal.y1) / 2 + 0.5;
    const distRect = (x, y) => Math.max(goal.x0 - x, x - goal.x1, goal.y0 - y, y - goal.y1, 0);
    const hfn = (x, y) => {
      const dx = Math.max(goal.x0 - x, x - goal.x1, 0);
      const dy = Math.max(goal.y0 - y, y - goal.y1, 0);
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 1.1;
    };
    this.run++;
    const run = this.run;
    heap.clear();
    const s = start[1] * w + start[0];
    g[s] = 0; parent[s] = -1; stamp[s] = run;
    heap.push(hfn(start[0], start[1]), s);
    let best = s;
    let bestH = hfn(start[0], start[1]);
    let found = -1;
    let expanded = 0;
    while (heap.size && expanded < maxExpand) {
      const cur = heap.pop();
      if (closed[cur] === run) continue;
      closed[cur] = run;
      expanded++;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const ch = hfn(cx, cy);
      if (ch < bestH) { bestH = ch; best = cur; }
      if (distRect(cx, cy) <= reach) { found = cur; break; }
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (blocked[ni] !== 0) continue;
        if (d >= 4 && (blocked[cy * w + nx] !== 0 || blocked[ny * w + cx] !== 0)) continue;
        const ng = g[cur] + DIRS[d][2];
        if (stamp[ni] === run && ng >= g[ni]) continue;
        stamp[ni] = run; g[ni] = ng; parent[ni] = cur;
        heap.push(ng + hfn(nx, ny), ni);
      }
    }
    this.expanded = expanded;
    const end = found >= 0 ? found : best;
    if (end === s && found < 0) return null;
    const pts = [];
    for (let p = end; p !== -1; p = parent[p]) pts.push([(p % w) + 0.5, ((p / w) | 0) + 0.5]);
    pts.reverse();
    return this.smooth(sx, sy, pts);
  }

  // Mohó egyenesítés: a lehető legtávolabbi látható pontra ugrik
  smooth(sx, sy, pts) {
    const out = [];
    let cx = sx;
    let cy = sy;
    let i = 0;
    while (i < pts.length) {
      let far = i;
      for (let j = pts.length - 1; j > i; j--) {
        if (this.lineClear(cx, cy, pts[j][0], pts[j][1])) { far = j; break; }
      }
      out.push(pts[far][0], pts[far][1]);
      cx = pts[far][0]; cy = pts[far][1];
      i = far + 1;
    }
    return out;
  }
}

module.exports = { Pathfinder, MinHeap };
