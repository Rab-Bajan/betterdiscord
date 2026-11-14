// Phase E pure rules: receipt lines, contamination, the 80/20 split, the LME market and the grid.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KIND } from '../../../src/modules/sweepers/debris/tables.ts';
import { lmeEpoch, lmeHeadline, lmePct, lmeRow } from '../../../src/modules/sweepers/economy/lme.ts';
import { ftPerKg, receipt, split } from '../../../src/modules/sweepers/economy/payout.ts';
import { PowerGrid, solarW } from '../../../src/modules/sweepers/economy/PowerGrid.ts';
import { LME_EPOCH_MS, MATERIALS, POWER } from '../../../src/modules/sweepers/economy/tables.ts';
import { DAYLIGHT_MS } from '../../../src/modules/sweepers/dayClock.ts';
import { load } from './logisticsSupport.ts';

const FLAT = [0, 0, 0];

test('receipt: every material at its base price, contamination −15 % of the metal lines, total', () => {
  const r = receipt([{ load: load({ dust: 10, iron: 5, copper: 2, cans: 20 }), proc: 0 }], FLAT);
  assert.deepEqual(r.lines, [[0, 0, 1000, 2, 20], [2, 0, 100, 35, 35], [3, 0, 500, 90, 450], [4, 0, 200, 2200, 4400]]);
  // Bulk 10 kg of 18 kg ≥ 10 % with metal: −round(0.15 × 4 885) = −733.
  assert.equal(r.dirtyFt, -733);
  assert.equal(r.total, 20 + 35 + 450 + 4400 - 733);
  assert.equal(r.kgDg, 1800);
  const seed = receipt([{ load: { ...load({}), seedG: 4_000 }, proc: 0 }], FLAT);
  assert.deepEqual(seed.lines, [[1, 0, 400, 5, 20]]);
  assert.equal(seed.dirtyFt, 0, 'no metal: no contamination');
});

test('receipt: bala ×1.45, rez copper at 3 100, jackpots at their worth, LME factor and rounding; lines summed per (mat, proc)', () => {
  const bala = { load: load({ iron: 50 }), proc: 1 };
  const rez = { load: load({ copper: 20 }), proc: 2 };
  const jackpot = { load: load({ jackpots: [KIND.cauldron, KIND.cauldron] }), proc: 0 };
  const r = receipt([bala, rez, jackpot, { load: load({ copper: 1 }), proc: 0 }, { load: load({ copper: 1 }), proc: 0 }], FLAT);
  assert.deepEqual(r.lines, [[3, 1, 5000, 131, 6550], [4, 0, 200, 2200, 4400], [4, 2, 2000, 3100, 62_000], [5, 0, 9000, 120_000, 240_000]]);
  assert.equal(r.total, 6550 + 4400 + 62_000 + 240_000);
  assert.equal(MATERIALS[6]?.worth, 85_000);
  assert.equal(MATERIALS[7]?.worth, 150_000);
  // LME: copper +25 %, iron −15 %.
  const pct = [0, -15, 25];
  assert.equal(ftPerKg(4, 0, pct), 2750);
  assert.equal(ftPerKg(4, 2, pct), 3875);
  assert.equal(ftPerKg(3, 1, pct), Math.round(90 * 0.85 * 1.45));
  assert.equal(ftPerKg(0, 0, pct), 2, 'dust is LME-free');
  assert.equal(ftPerKg(2, 0, [-10, 0, 0]), Math.round(35 * 0.9));
  assert.deepEqual(receipt([{ load: load({ copper: 0.333 }), proc: 0 }], pct).lines, [[4, 0, 33, 2750, Math.round(0.333 * 2750)]]);
});

test('contamination: 9.9 % bulk is clean, 10 % is dirty, no metal is never dirty', () => {
  const clean = receipt([{ load: { ...load({ iron: 9.01 }), dustG: 990 }, proc: 0 }], FLAT);
  assert.equal(clean.dirtyFt, 0);
  const dirty = receipt([{ load: load({ dust: 1, iron: 9 }), proc: 0 }], FLAT);
  assert.equal(dirty.dirtyFt, -Math.round(0.15 * 810));
  assert.equal(dirty.total, 2 + 810 - 122);
  assert.equal(receipt([{ load: load({ dust: 50 }), proc: 0 }], FLAT).dirtyFt, 0);
  // Per container: a clean bag beside a dirty pack keeps its full price.
  const mixed = receipt([{ load: load({ dust: 1, iron: 9 }), proc: 0 }, { load: load({ iron: 10 }), proc: 0 }], FLAT);
  assert.equal(mixed.dirtyFt, -122);
  assert.deepEqual(receipt([], FLAT), { lines: [], dirtyFt: 0, total: 0, kgDg: 0 });
});

test('split: 20 % wage pool equally, the rounding remainder to the team', () => {
  assert.deepEqual(split(1001, 1), { each: 200, team: 801 });
  assert.deepEqual(split(1001, 2), { each: 100, team: 801 });
  assert.deepEqual(split(1001, 3), { each: 66, team: 1001 - 198 });
  assert.deepEqual(split(4, 3), { each: 0, team: 4 });
  assert.deepEqual(split(0, 2), { each: 0, team: 0 });
});

test('LME: deterministic per epoch, the pinned series 0..9, headlines and ties (copper > iron > alu)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((e) => lmeRow(e).pct), [
    [-10, -10, -10], [10, 5, 10], [-25, -10, 0], [-10, 5, -5], [5, 0, -5], [-25, -10, 25], [25, 0, -25], [-10, -10, -25], [15, 0, 5], [0, 5, 25]
  ]);
  assert.equal(lmePct(2, 5), lmeRow(5).pct[2]);
  assert.equal(lmeEpoch(LME_EPOCH_MS * 7 + 5), 7);
  assert.equal(lmeRow(7).until, LME_EPOCH_MS * 8);
  assert.equal(lmeRow(5).msg, 'LME TŐZSDEREPÜLÉS: Megugrott a vörösréz iránti kereslet! Ár: +25%!');
  assert.equal(lmeRow(2).msg, 'LME ZUHANÁS: Beesett az alumínium ára! Ár: −25%!');
  assert.equal(lmeRow(6).msg, 'LME ZUHANÁS: Beesett a vörösréz ára! Ár: −25%!', 'a tie |25| goes to copper');
  assert.equal(lmeRow(0).msg, 'LME: nyugodt piac.');
  assert.equal(lmeHeadline([0, -15, -15]), 'LME ZUHANÁS: Beesett a vörösréz ára! Ár: −15%!');
  assert.equal(lmeHeadline([15, 15, 0]), 'LME TŐZSDEREPÜLÉS: Megugrott az ócskavas iránti kereslet! Ár: +15%!');
  assert.equal(lmeHeadline([10, -10, 5]), 'LME: nyugodt piac.');
});

test('grid: ok / brownout / blackout at hand-picked inputs, battery integration and clamps, diesel burn and auto-off', () => {
  assert.equal(solarW(0), 0);
  assert.equal(solarW(DAYLIGHT_MS / 2), POWER.solarPeakW);
  assert.equal(solarW(DAYLIGHT_MS + 1), 0, 'night');
  const noon = DAYLIGHT_MS / 2;
  const ok = new PowerGrid(100_000, 20, false);
  ok.step(3_600_000, noon, 8_000);
  assert.equal(ok.st, 0);
  assert.equal(ok.pf, 1);
  assert.equal(ok.battWh, 110_000, '+10 kW surplus for an hour');
  ok.step(3_600_000 * 10, noon, 0);
  assert.equal(ok.battWh, POWER.batteryWh, 'clamped full');
  // Night, empty battery, demand without supply: blackout.
  const dark = new PowerGrid(0, 0, false);
  dark.step(1000, DAYLIGHT_MS + 1, 500);
  assert.deepEqual([dark.st, dark.pf], [2, 0]);
  dark.step(1000, DAYLIGHT_MS + 1, 0);
  assert.deepEqual([dark.st, dark.pf], [0, 1], 'no demand is ok');
  // Night, battery: covers up to 15 kW; above that it is a brownout that drains at 15 kW.
  const night = new PowerGrid(30_000, 0, false);
  night.step(3_600_000, DAYLIGHT_MS + 1, 15_000);
  assert.deepEqual([night.st, night.battWh], [0, 15_000]);
  night.step(1_800_000, DAYLIGHT_MS + 1, 16_000);
  assert.deepEqual([night.st, night.pf, night.battWh], [1, 0.4, 7_500]);
  night.step(3_600_000, DAYLIGHT_MS + 1, 16_000);
  assert.equal(night.battWh, 0, 'clamped empty');
  night.step(1000, DAYLIGHT_MS + 1, 16_000);
  assert.equal(night.st, 2);
  // Generator: 25 kW, 3.5 L/h, switches off at 0.
  const gen = new PowerGrid(0, 3.5, true);
  gen.step(1_800_000, DAYLIGHT_MS + 1, 20_000);
  assert.deepEqual([gen.st, gen.genW, gen.dieselL, gen.genOn], [0, 25_000, 1.75, true]);
  assert.equal(gen.battWh, 2_500, 'generator surplus charges the battery');
  gen.step(3_600_000, DAYLIGHT_MS + 1, 20_000);
  assert.deepEqual([gen.dieselL, gen.genOn], [0, false]);
  assert.deepEqual(gen.row(), { st: 0, pf: 1, solarW: 0, genW: 25_000, demandW: 20_000, battWh: 7_500, dieselDl: 0, genOn: false });
  // tick: one step per whole second, no catch-up.
  const ticking = new PowerGrid(1000, 0, false);
  assert.equal(ticking.tick(600, noon, () => 0), false);
  assert.equal(ticking.tick(600, noon, () => 0), true);
  assert.equal(ticking.tick(5_000, noon, () => 0), true);
  assert.equal(ticking.tick(10, noon, () => 0), false);
});
