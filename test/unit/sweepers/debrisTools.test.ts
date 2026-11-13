// Phase C tool uses (C.3) on a controlled debris world: cells, push, piles, scoop, clog, turbo,
// blower, rake magnet, hand, crush, spill, drain, wear and kicks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headWidth, loadKg } from '../../../src/modules/sweepers/debris/personal.ts';
import { FLAG_BURIED, FLAG_STUCK, KIND } from '../../../src/modules/sweepers/debris/tables.ts';
import { drainBuffer, kickCan, kickDistance, moveLoad, spill, useTool } from '../../../src/modules/sweepers/debris/tools.ts';
import { SweepersError } from '../../../src/modules/sweepers/SweepersError.ts';
import { ValidationError } from '../../../src/core/errors/ValidationError.ts';
import { ALL_DISTRICTS, cellAt, context, emptyWorld, paint, personal, put } from './debrisSupport.ts';

// Origin (2.25, 4.45) facing −z: the arc of the 1.2 m tools passes the centre of cell (2.25, 3.25).
const OX = 2.25;
const OZ = 4.45;
const owning = (...tools: number[]): number => tools.reduce((bits, t) => bits | (1 << t), 0b1000_0001);
const refusedWith = (message: string) => (err: unknown): boolean => err instanceof SweepersError && err.message === message;
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('cells: tool 2 dry ×1.15, tool 1 dust eff 0.6, heavy (drizzle) ×0.5 × hardness, stench ×0.5', () => {
  const cases: Array<{ tool: number; drizzle?: boolean; hardLvl?: number; cabbage?: boolean; gloves?: boolean; byte: number }> = [
    { tool: 2, byte: (10 << 4) | 10 },
    { tool: 1, byte: (13 << 4) | 12 },
    { tool: 2, drizzle: true, byte: (12 << 4) | 10 },
    { tool: 2, drizzle: true, hardLvl: 3, byte: (10 << 4) | 10 },
    { tool: 2, cabbage: true, byte: (12 << 4) | 12 },
    { tool: 2, cabbage: true, gloves: true, byte: (10 << 4) | 10 }
  ];
  for (const c of cases) {
    const world = emptyWorld();
    const index = cellAt(world, 2.25, 3.25);
    world.setCell(index, 0xff);
    if (c.cabbage) put(world, KIND.cabbage, 2.6, 3.25, 600);
    const data = personal({ owned: owning(1, 2), toolTier: c.tool, hardLvl: c.hardLvl ?? 0, gloves: c.gloves ?? false });
    const ctx = context(world, data, 10_000, false, c.drizzle ?? false);
    const result = useTool(ctx, c.tool, false, OX, OZ, 0);
    assert.equal(world.cells[index], c.byte, JSON.stringify(c));
    assert.equal(data.fx.stench !== undefined, c.cabbage === true && c.gloves !== true, 'stench');
    assert.ok(result.kg > 0);
  }
  const world = emptyWorld();
  world.setCell(cellAt(world, 2.25, 3.25), 0xff);
  const data = personal({ owned: owning(2), toolTier: 2 });
  const result = useTool(context(world, data), 2, false, OX, OZ, 0);
  // District 0: dust 5/15 · 1.6 · 0.8 · 0.25 kg, seed 5/15 · 0.3 · 0.2 · 0.25 kg.
  assert.ok(near(data.buf.dustG, (5 / 15) * 1.6 * 0.8 * 0.25 * 1000));
  assert.ok(near(data.buf.seedG, (5 / 15) * 0.3 * 0.2 * 0.25 * 1000));
  assert.ok(near(result.kg, loadKg(data.buf)));
  assert.equal(data.stamina, 990);
  assert.ok(near(data.totalKg, result.kg));
});

test('push: a broom with a full buffer pushes the swept mass into a pile at O + dir·(reach + 0.6)', () => {
  const world = emptyWorld();
  world.setCell(cellAt(world, 2.25, 3.25), 0xff);
  const data = personal({ toolTier: 0 });
  data.buf.dustG = 500;
  const result = useTool(context(world, data), 0, false, 2.25, 3.85, 0);
  assert.equal(result.pushed, true);
  assert.equal(result.kg, 0);
  const pile = world.itemsNear(2.25, 3.85 - 1.2, 0.01)[0]?.item;
  assert.equal(pile?.kind, KIND.pile);
  // WC-kefe: f = 0.04 / 0.2094 → both levels 15 → 12: 3/15 of (0.32 + 0.015) kg = 6.7 dg.
  assert.equal(pile?.massDg, 7);
  assert.equal(data.buf.dustG, 500, 'buffer unchanged');
});

test('piles: the 3× rule per stroke, then the scoop tips the buffer and takes the rest of the pile', () => {
  const world = emptyWorld();
  const pile = put(world, KIND.pile, 2.25, 3.25, 500);
  const data = personal({ owned: owning(2), toolTier: 2 });
  const stroke = useTool(context(world, data), 2, false, OX, OZ, 0);
  assert.ok(near(stroke.kg, 3 * 0.85 * 0.5 * 1.6, 0.01), `${stroke.kg}`);
  assert.equal(world.items.get(pile.id)?.massDg, 500 - 204);
  const scoop = useTool(context(world, data), 2, true, OX, OZ, 0);
  assert.deepEqual(scoop.items, [pile.id]);
  assert.equal(world.items.has(pile.id), false);
  assert.ok(near(data.pack.dustG, 5000, 1));
  assert.equal(loadKg(data.buf), 0);
  assert.equal(data.stamina, 1000 - 10 - 20);
  // Tool 0 has no dustpan: it only tips.
  const small = put(world, KIND.pile, 2.25, 3.25, 300);
  const kefe = personal({ toolTier: 0 });
  kefe.buf.dustG = 200;
  assert.deepEqual(useTool(context(world, kefe), 0, true, OX, OZ, 0).items, []);
  assert.equal(world.items.get(small.id)?.massDg, 300);
  assert.ok(near(kefe.pack.dustG, 200));
  // A full pack refuses the scoop.
  const full = personal({ owned: owning(2), toolTier: 2 });
  full.pack.ironG = 10_000;
  full.buf.dustG = 100;
  assert.throws(() => useTool(context(world, full), 2, true, OX, OZ, 0), refusedWith('Tele a hátizsák – borítsd ki (G).'));
});

test('vacuum: 4 % can clog refuses until the reverse blow; a full tank refuses with tankFull', () => {
  const world = emptyWorld();
  const can = put(world, KIND.can, 2.25, OZ - 2, 5);
  const data = personal({ owned: owning(5), toolTier: 5 });
  const clogged = useTool(context(world, data, 10_000, true), 5, false, OX, OZ, 0);
  assert.deepEqual(clogged.items, []);
  assert.equal(data.clogged, true);
  assert.ok(world.items.has(can.id), 'the can stays in place');
  assert.throws(() => useTool(context(world, data), 5, false, OX, OZ, 0), refusedWith('Eldugult a cső – fújd ki (jobb klikk)!'));
  useTool(context(world, data), 5, true, OX, OZ, 0);
  assert.equal(data.clogged, false);
  assert.deepEqual(useTool(context(world, data), 5, false, OX, OZ, 0).items, [can.id]);
  assert.equal(data.buf.cans, 1);
  data.buf.dustG = 45_000;
  assert.throws(() => useTool(context(world, data), 5, false, OX, OZ, 0), refusedWith('Tele a tartály.'));
  // Copper ≤ 2 kg only; stuck cans never.
  const vac = personal({ owned: owning(5), toolTier: 5 });
  const light = put(world, KIND.copper, 2.25, OZ - 1.5, 200);
  const heavy = put(world, KIND.copper, 2.25, OZ - 1.7, 201);
  const stuck = put(world, KIND.can, 2.25, OZ - 1.9, 5, FLAG_STUCK);
  assert.deepEqual(useTool(context(world, vac), 5, false, OX, OZ, 0).items, [light.id]);
  assert.ok(world.items.has(heavy.id) && world.items.has(stuck.id));
});

test('blower: LMB piles cells 7 m ahead and moves loose cans there; RMB turbo clears stuck cans in 3 m ±20°', () => {
  const world = emptyWorld();
  paint(world, 2.25, OZ - 3, 0.6, 0xff);
  const loose = put(world, KIND.can, 2.25, OZ - 2, 5);
  const iron = put(world, KIND.iron, 2.25, OZ - 2.5, 500);
  const data = personal({ owned: owning(4), toolTier: 4 });
  const result = useTool(context(world, data), 4, false, OX, OZ, 0);
  assert.equal(result.kg, 0);
  assert.equal(data.fuelMl, 2000 - 5);
  const target = { x: OX, z: OZ - 7 };
  const moved = world.items.get(loose.id);
  assert.ok(moved && Math.hypot(moved.x - target.x, moved.z - target.z) <= 1.0001, 'can scattered within 1 m of the target');
  assert.equal(world.items.get(iron.id)?.z, OZ - 2.5, 'iron stays');
  const pile = world.itemsNear(target.x, target.z, 1.5).find(({ item }) => item.kind === KIND.pile);
  assert.ok(pile, 'pile at the target');
  const inCone = put(world, KIND.can, ...([OX - Math.sin(0.2) * 2, OZ - Math.cos(0.2) * 2] as const), 5, FLAG_STUCK);
  const outside = put(world, KIND.can, ...([OX - Math.sin(0.45) * 2, OZ - Math.cos(0.45) * 2] as const), 5, FLAG_STUCK);
  useTool(context(world, data), 4, true, OX, OZ, 0);
  assert.equal((world.items.get(inCone.id)?.flags ?? 0) & FLAG_STUCK, 0);
  assert.equal((world.items.get(outside.id)?.flags ?? 0) & FLAG_STUCK, FLAG_STUCK, '25° is outside ±20°');
  assert.equal(data.fuelMl, 2000 - 5 - 50);
  data.fuelMl = 40;
  assert.throws(() => useTool(context(world, data), 4, true, OX, OZ, 0), refusedWith('Kifogyott a benzin – tankolj a MÉH műhelyben.'));
  data.fuelMl = 4;
  assert.throws(() => useTool(context(world, data), 4, false, OX, OZ, 0), refusedWith('Kifogyott a benzin – tankolj a MÉH műhelyben.'));
});

test('rake: iron and (buried) copper in the arc, plus iron within 2.5 m of the arc midpoint', () => {
  const world = emptyWorld();
  const magnet = put(world, KIND.iron, OX + 2, 3.25, 500);
  const copperAside = put(world, KIND.copper, OX + 2, 3.45, 300);
  const buried = put(world, KIND.copper, OX, 3.25, 300, FLAG_BURIED);
  const can = put(world, KIND.can, OX + 0.2, 3.3, 5);
  const data = personal({ owned: owning(6), toolTier: 6 });
  const result = useTool(context(world, data), 6, false, OX, OZ, 0);
  assert.deepEqual(new Set(result.items), new Set([magnet.id, buried.id]));
  assert.ok(world.items.has(copperAside.id) && world.items.has(can.id));
  assert.deepEqual([data.buf.ironG, data.buf.copperG], [5000, 3000]);
  assert.throws(() => useTool(context(world, data), 6, true, OX, OZ, 0), (err: unknown) => err instanceof ValidationError);
});

test('brooms: 1–2 take loose cans only, 3 also stuck cans, iron and copper; buried copper never', () => {
  for (const [tool, expected] of [[1, ['loose']], [2, ['loose']], [3, ['loose', 'stuck', 'iron', 'copper']]] as const) {
    const world = emptyWorld();
    const ids = {
      loose: put(world, KIND.can, OX, 3.25, 5).id,
      stuck: put(world, KIND.can, OX + 0.1, 3.3, 5, FLAG_STUCK).id,
      iron: put(world, KIND.iron, OX - 0.1, 3.3, 300).id,
      copper: put(world, KIND.copper, OX, 3.4, 100).id,
      buried: put(world, KIND.copper, OX, 3.2, 100, FLAG_BURIED).id
    };
    const data = personal({ owned: owning(1, 2, 3), toolTier: tool });
    const taken = new Set(useTool(context(world, data), tool, false, OX, OZ, 0).items);
    const names = (Object.keys(ids) as Array<keyof typeof ids>).filter((k) => taken.has(ids[k]));
    assert.deepEqual(names.sort(), [...expected].sort(), `tool ${tool}`);
  }
});

test('hand: nearest fitting item into the pack (jackpots too); too big refuses; RMB crushes up to 10 cans', () => {
  const world = emptyWorld();
  const lenin = put(world, KIND.lenin, OX, OZ - 1, 6000);
  const data = personal({ toolTier: 7 });
  assert.throws(() => useTool(context(world, data), 7, false, OX, OZ, 0), refusedWith('Ez túl nehéz vagy túl nagy a hátizsákodnak.'));
  const can = put(world, KIND.can, OX, OZ - 1.5, 5);
  assert.deepEqual(useTool(context(world, data), 7, false, OX, OZ, 0).items, [can.id]);
  assert.ok(world.items.has(lenin.id));
  const big = personal({ toolTier: 7, backpackTier: 4 });
  assert.deepEqual(useTool(context(world, big), 7, false, OX, OZ, 0).items, [lenin.id]);
  assert.deepEqual(big.pack.jackpots, [KIND.lenin]);
  data.pack.cans = 12;
  const before = data.stamina;
  useTool(context(world, data), 7, true, OX, OZ, 0);
  assert.deepEqual([data.pack.cans, data.pack.crushed, before - data.stamina], [2, 10, 50]);
  const none = personal({ toolTier: 7 });
  assert.throws(() => useTool(context(world, none), 7, true, OX, OZ, 0), refusedWith('Üres a hátizsák.'));
  none.stamina = 2;
  assert.throws(() => useTool(context(world, none), 7, false, OX, OZ, 0), refusedWith('Kifulladtál – pihenj egy kicsit!'));
});

test('spill: one pile, cans, iron ≤ 15 kg, copper ≤ 8 kg, jackpots apart, mass kept; drain 3 kg/s', () => {
  const world = emptyWorld();
  const load = { dustG: 1000, seedG: 500, cans: 3, crushed: 2, ironG: 20_000, copperG: 9_000, jackpots: [KIND.cauldron] };
  spill(world, load, 3, 3, 0);
  const items = [...world.items.values()];
  const of = (kind: number): number[] => items.filter((i) => i.kind === kind).map((i) => i.massDg).sort((a, b) => b - a);
  assert.deepEqual(of(KIND.pile), [150]);
  assert.equal(of(KIND.can).length, 5);
  assert.deepEqual(of(KIND.iron), [1500, 500]);
  assert.deepEqual(of(KIND.copper), [800, 100]);
  assert.deepEqual(of(KIND.cauldron), [4500]);
  assert.equal(loadKg(load), 0);
  const vac = personal({ owned: owning(5), toolTier: 5 });
  vac.buf.dustG = 6000;
  assert.equal(drainBuffer(vac, 1000), true);
  assert.ok(near(vac.buf.dustG, 3000) && near(vac.pack.dustG, 3000));
  const broom = personal({ owned: owning(2), toolTier: 2 });
  broom.buf.dustG = 1000;
  assert.equal(drainBuffer(broom, 1000), false, 'brooms tip only by scoop');
  const to = { dustG: 0, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] };
  const from = { dustG: 0, seedG: 0, cans: 20, crushed: 0, ironG: 0, copperG: 0, jackpots: [] };
  moveLoad(from, to, 10, 3);
  assert.deepEqual([from.cans, to.cans], [15, 5], 'litres limit the cans (0.6 L each)');
});

test('wear: tools 1–3 lose 1 % per 100 kg of class 1, × the hardness multiplier; < 20 % halves the width', () => {
  for (const [hardLvl, factor] of [[0, 1], [3, 0.4]] as const) {
    const world = emptyWorld();
    paint(world, OX, 3.25, 1.5, 0xf0);
    const data = personal({ owned: owning(3), toolTier: 3, hardLvl });
    useTool(context(world, data), 3, false, OX, OZ, 0);
    const dust = data.buf.dustG / 1000;
    assert.ok(dust > 0);
    assert.ok(near(1000 - (data.dur[2] ?? 0), dust * 0.1 * factor), `hard ${hardLvl}`);
  }
  const data = personal({ owned: owning(3), toolTier: 3 });
  assert.equal(headWidth(data, 3), 1.6);
  data.dur[2] = 199;
  assert.equal(headWidth(data, 3), 0.8);
  data.widthLvl = 5;
  data.dur[2] = 1000;
  assert.ok(near(headWidth(data, 3), 1.6 * 2.1));
  assert.equal(headWidth(data, 6), 1.2, 'the width upgrade is for tools 0–3 only');
});

test('kick: u = 1.8·v capped at 6 m/s, distance |u|·0.286 + |u|²/6, deterministic, stopped by walls and locked districts', () => {
  const kickIn = (x: number, z: number, vx: number, vz: number, unlocked: ReadonlySet<number> = ALL_DISTRICTS) => {
    const world = emptyWorld();
    const can = put(world, KIND.can, x, z, 5);
    return kickCan(world, can, vx, vz, unlocked);
  };
  assert.ok(near(kickDistance(3.6), 3.6 * 0.286 + (3.6 * 3.6) / 6));
  assert.deepEqual(kickIn(3, 3, 2, 0), [kickIn(3, 3, 2, 0)[0], 300, 300, Math.round((3 + kickDistance(3.6)) * 100), 300]);
  assert.deepEqual(kickIn(3, 3, 2, 0), kickIn(3, 3, 2, 0), 'deterministic');
  assert.equal(kickIn(3, 3, 10, 0)[3], Math.round((3 + kickDistance(6)) * 100), 'capped at 6 m/s');
  // The office container (x 12..18 at z −6.6) stops a can rolling east.
  const wall = kickIn(9, -6.6, 5, 0);
  assert.ok(wall[3] <= 1195 && wall[3] > 900, `${wall[3]}`);
  // Only district 0 open: the can stops at the centre hex's east edge (x ≈ 34.64).
  const locked = kickIn(33, 0, 5, 0, new Set([0]));
  assert.ok(locked[3] <= 3464 && locked[3] >= 3400, `${locked[3]}`);
});

// Facing +x: rotY = −π/2 (rotY 0 faces −z). District 0 ends at x = 34.64 on the x axis.
const EAST = -Math.PI / 2;
const lockedCtx = (world: ReturnType<typeof emptyWorld>, data: ReturnType<typeof personal>) => ({ ...context(world, data), unlocked: new Set([0]) });

test('locked districts: cells and cans past the border are untouched by a broom and the vacuum', () => {
  for (const tool of [2, 5]) {
    const world = emptyWorld();
    const index = cellAt(world, 35.25, 0.05);
    world.setCell(index, 0xff);
    const can = put(world, KIND.can, 35.2, 0, 5);
    const data = personal({ owned: owning(tool), toolTier: tool });
    const result = useTool(lockedCtx(world, data), tool, false, 34.3, 0, EAST);
    assert.equal(world.cells[index], 0xff, `tool ${tool} cells`);
    assert.ok(world.items.has(can.id) && !result.items.includes(can.id), `tool ${tool} can`);
  }
});

test('locked districts: a push pile never lands in a locked district, it steps back to the origin side', () => {
  const world = emptyWorld();
  const data = personal({ owned: owning(1), toolTier: 1 });
  data.buf.dustG = 20_000;
  world.setCell(cellAt(world, 34.25, 0.25), 0xff);
  const result = useTool(lockedCtx(world, data), 1, false, 33.05, 0.25, EAST);
  assert.equal(result.pushed, true);
  const piles = [...world.items.values()].filter((item) => item.kind === KIND.pile);
  assert.ok(piles.length > 0 && piles.every((p) => p.x < 34.64), 'every pile stays in district 0');
});
