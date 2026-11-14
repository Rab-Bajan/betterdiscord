// Phase E through SweepersService / SweepersRoom: the 2 s scale rule and what it weighs, the 80/20
// split, unlocks, the inspector, the team shop, the generator, the economy update and persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { parsePersonal, serialisePersonal } from '../../../src/modules/sweepers/debris/personal.ts';
import type { EconomyUpdate, InspectionPayload } from '../../../src/modules/sweepers/economy/Economy.ts';
import { lmeEpoch, lmeRow } from '../../../src/modules/sweepers/economy/lme.ts';
import { receipt } from '../../../src/modules/sweepers/economy/payout.ts';
import { INSPECT_MS, POWER } from '../../../src/modules/sweepers/economy/tables.ts';
import { CRANE, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { districtAt, HEX_CELLS, axialToWorld } from '../../../src/modules/sweepers/hexGrid.ts';
import { NEW_PLAYER_STATS } from '../../../src/modules/sweepers/SweepersRoom.ts';
import { ROOM_STATE_VERSION } from '../../../src/modules/sweepers/roomState.ts';
import type { ScaleWeighedPayload } from '../../../src/modules/sweepers/types.ts';
import { paint } from './debrisSupport.ts';
import { code, load, ROOM, world } from './logisticsSupport.ts';
import { guest, MemoryStore } from './support.ts';

type W = ReturnType<typeof world>;
const WB = cityLayout().landmarks.weighbridge;
const PAD = CRANE.targets[0] ?? { x: 0, z: 0 };
const OFFICE = cityLayout().landmarks.office;
const GEN = cityLayout().landmarks.generator;

/** Moves the player as an accepted input would (re-anchors the scale). */
const stand = (w: W, x: number, z: number): void => {
  w.at(x, z);
  w.room.afterInput(w.player, w.clock.ms);
};
const weighed = (w: W): ScaleWeighedPayload[] => w.events.of('scaleWeighed').map(([, p]) => p as ScaleWeighedPayload);
const economy = (w: W): EconomyUpdate[] => w.events.of('economy').map(([, u]) => u as EconomyUpdate);
const pct = (w: W): number[] => lmeRow(lmeEpoch(w.clock.ms)).pct;

test('scale: 1.9 s still → nothing, 2.0 s → one weighing; re-arms only after moving > 0.15 m or leaving; no goods → no event', () => {
  const w = world();
  w.player.personal.pack = load({ copper: 1 });
  stand(w, WB.x, WB.z);
  w.events.clear();
  w.tick(1_900);
  assert.equal(weighed(w).length, 0);
  w.tick(100);
  assert.equal(weighed(w).length, 1);
  assert.equal(weighed(w)[0]?.scale, 0);
  w.player.personal.pack = load({ copper: 1 });
  stand(w, WB.x + 0.1, WB.z);
  w.ticks(30);
  assert.equal(weighed(w).length, 1, 'a 0.1 m shuffle does not re-arm');
  stand(w, WB.x + 0.3, WB.z);
  w.tick(1_000);
  w.tick(1_000);
  assert.equal(weighed(w).length, 2, 'moved 0.3 m from the anchor: weighed again after 2 s');
  stand(w, WB.x + 0.3, WB.z + 8);
  stand(w, WB.x + 0.3, WB.z);
  w.ticks(30);
  assert.equal(weighed(w).length, 2, 'left and came back, but nothing to weigh');
  w.player.personal.pack = load({ iron: 2 });
  stand(w, WB.x - 5.9, WB.z + 1.7);
  w.tick(2_000);
  assert.equal(weighed(w).length, 3, 'the weighbridge corner counts');
  stand(w, WB.x - 6.2, WB.z);
  w.player.personal.pack = load({ iron: 2 });
  w.tick(2_000);
  assert.equal(weighed(w).length, 3, 'off the 12 m deck');
});

test('weighing: pack + carried bag + ground bags on the pad (stack included, crane-held excluded) → receipt, emptied, 80/20', () => {
  const w = world();
  w.tieAt(PAD.x, PAD.z + 1.1, { dust: 2, iron: 5 });
  const carried = [...w.logistics.bags.values()][0];
  assert.ok(carried);
  w.at(PAD.x, PAD.z + 1.1);
  w.act({ kind: 'pickup', id: carried.id });
  w.player.pose = { ...w.player.pose, state: 'HOLDING_BAG' };
  assert.ok(w.logistics.restoreGroundBag({ id: 9_001, tier: 4, tint: 3, x: PAD.x, z: PAD.z, rot8: 0, load: load({ copper: 20 }) }));
  assert.ok(w.logistics.restoreGroundBag({ id: 9_002, tier: 3, tint: 2, x: PAD.x, z: PAD.z, rot8: 0, load: load({ iron: 50 }) }));
  assert.equal(w.logistics.bags.get(9_002)?.on, 9_001, 'stacked');
  assert.ok(w.logistics.restoreGroundBag({ id: 9_003, tier: 1, tint: 0, x: -11, z: -3.5, rot8: 0, load: load({ copper: 10 }) }));
  const craned = w.logistics.bags.get(9_003);
  assert.ok(craned);
  w.logistics.startCrane(craned, 0, w.clock.ms + 1e9);
  assert.equal(craned.st, 2);
  w.player.personal.pack = load({ dust: 3, copper: 2 });
  const expected = receipt([
    { load: load({ dust: 3, copper: 2 }), proc: 0 }, { load: load({ dust: 2, iron: 5 }), proc: 0 },
    { load: load({ iron: 50 }), proc: 1 }, { load: load({ copper: 20 }), proc: 2 }
  ], pct(w));
  const funds = w.room.teamFunds;
  const cash = w.player.personal.cash;
  stand(w, PAD.x, PAD.z + 1.1);
  w.events.clear();
  w.tick(2_000);
  const [sale] = weighed(w);
  assert.ok(sale);
  assert.deepEqual(sale, {
    scale: 1, by: w.player.id, kgDg: expected.kgDg, lines: expected.lines, dirtyFt: expected.dirtyFt, total: expected.total,
    team: expected.total - Math.floor(0.2 * expected.total), each: Math.floor(0.2 * expected.total), to: [w.player.id], epoch: lmeEpoch(w.clock.ms)
  });
  assert.ok(expected.dirtyFt < 0, 'the dusty pack and bag are contaminated');
  assert.equal(w.room.teamFunds, funds + sale.team);
  assert.equal(w.player.personal.cash, cash + sale.each);
  assert.equal(w.player.carry, 0);
  assert.equal(w.player.pose.state, 'IDLE');
  assert.equal(w.logistics.bags.has(carried.id), false);
  assert.equal(w.logistics.bags.has(9_001) || w.logistics.bags.has(9_002), false);
  assert.equal(w.logistics.bags.get(9_003)?.st, 2, 'the crane-held bag stays');
  assert.equal(w.player.personal.pack.copperG + w.player.personal.buf.copperG, 0);
  const update = w.events.of('logisticsUpdate').map(([, u]) => u as { del?: number[] }).flatMap((u) => u.del ?? []);
  assert.ok([carried.id, 9_001, 9_002].every((id) => update.includes(id)));
  assert.equal(economy(w).at(-1)?.funds, w.room.teamFunds);
  const personal = w.events.of('personalUpdate').at(-1)?.[1] as { cash: number };
  assert.equal(personal.cash, w.player.personal.cash);
});

test('split: 1, 2 and 3 connected (+1 in the grace window): each, the remainder to the team, lifetime revenue and an unlock', () => {
  for (const n of [1, 2, 3]) {
    const w = world(false);
    for (let i = 2; i <= n; i++) w.service.join(ROOM, `s${i}`, guest(`P${i}`));
    w.service.join(ROOM, 'ghost', guest('Ghost'));
    w.service.disconnect('ghost');
    w.player.personal.pack = load({ copper: 12 });
    const total = receipt([{ load: load({ copper: 12 }), proc: 0 }], pct(w)).total;
    assert.ok(total >= 25_000, `${total}`);
    stand(w, WB.x, WB.z);
    w.events.clear();
    w.tick(2_000);
    const sale = weighed(w)[0];
    const each = Math.floor(Math.floor(0.2 * total) / n);
    assert.equal(sale?.each, each);
    assert.equal(sale?.team, total - each * n);
    assert.equal(sale?.to.length, n, 'the player in the grace window is not paid');
    for (let i = 2; i <= n; i++) assert.equal(w.room.bySocket(`s${i}`)?.personal.cash, 2_000 + each);
    assert.equal(w.room.lifetimeEarned, total);
    assert.deepEqual(w.events.of('districtUnlocked').map(([, p]) => (p as { district: number }).district), [1]);
    assert.ok(w.store.saves > 0, 'saved at the unlock');
  }
});

test('inspector: counts down only while someone is connected; scaled quotas, a fine per failing district, debt; kg attribution', () => {
  const w = world(true);
  const d1 = HEX_CELLS.find((c) => c.district === 1 && c.q * c.q + c.r * c.r > 0);
  assert.ok(d1);
  const at = axialToWorld(d1);
  assert.equal(districtAt(at.x, at.z), 1);
  w.at(at.x, at.z);
  paint(w.room.debris, at.x, at.z, 1.5, 0xff);
  w.clock.ms += 2_000;
  const ack = w.service.sweepHit('s1', { channelId: ROOM, seq: 1, tool: 0, alt: false, x: at.x, z: at.z, rotY: 0 });
  assert.ok(ack.kg > 0);
  assert.ok(Math.abs((w.room.economy.kg[1] ?? 0) - ack.kg) < 1e-3);
  assert.equal(w.room.economy.kg[0], 0);

  w.service.disconnect('s1');
  const before = w.room.economy.inspInMs;
  w.ticks(5, 1_000);
  assert.equal(w.room.economy.inspInMs, before, 'paused with nobody connected');
  w.service.join(ROOM, 's1', guest('Builder'));
  w.room.teamFunds = 30_000;
  w.room.economy.kg[2] = 400;
  w.room.economy.inspInMs = 1_500;
  w.events.clear();
  w.tick(1_000);
  assert.equal(w.events.of('inspection').length, 0);
  w.tick(1_000);
  const visit = w.events.of('inspection')[0]?.[1] as InspectionPayload | undefined;
  assert.ok(visit);
  // One player: quotas × 0.25 → [0, 500, 375, 625, 300, 250]; district 2 has 400 ≥ 375.
  assert.deepEqual(visit.results.map(([d, quota, , fine]) => [d, quota, fine]), [[1, 500, 25_000], [2, 375, 0], [3, 625, 25_000], [4, 300, 25_000], [5, 250, 25_000]]);
  assert.equal(visit.fine, 100_000);
  assert.equal(visit.funds, 30_000 - 100_000, 'funds may go negative');
  assert.equal(w.room.teamFunds, -70_000);
  assert.deepEqual(w.room.economy.kg, [0, 0, 0, 0, 0, 0]);
  assert.equal(w.room.economy.inspInMs, INSPECT_MS);
  const insp = w.room.economy.inspRow(w.clock.ms, 4);
  assert.deepEqual(insp.quota, [0, 2_000, 1_500, 2_500, 1_200, 1_000]);
  // A locked district is not inspected.
  const closed = world(false);
  closed.room.economy.inspInMs = 500;
  closed.events.clear();
  closed.tick(1_000);
  assert.deepEqual((closed.events.of('inspection')[0]?.[1] as InspectionPayload).results, []);
});

test('shop: grease gun from cash; blueprint, diesel and licence from the team funds; location, ownership and funds refusals', () => {
  const w = world(false);
  const buy = (request: Record<string, unknown>) => code(() => w.service.buyUpgrade('s1', { channelId: ROOM, ...request } as never));
  w.at(0, 0);
  assert.equal(buy({ item: 'blueprint', tier: 0 }), 'notAtWorkbench');
  w.at(OFFICE.x, OFFICE.z + 3);
  w.room.teamFunds = 39_999;
  assert.equal(buy({ item: 'blueprint', tier: 0 }), 'notEnoughTeamFunds');
  w.room.teamFunds = 100_000;
  assert.deepEqual(w.service.buyUpgrade('s1', { channelId: ROOM, item: 'blueprint', tier: 0 }), { cash: 2_000, teamFunds: 60_000 });
  assert.equal(w.room.economy.bp, 1);
  assert.equal(buy({ item: 'blueprint', tier: 0 }), 'alreadyOwned');
  assert.equal(w.service.buyUpgrade('s1', { channelId: ROOM, item: 'diesel' }).teamFunds, 55_000);
  assert.equal(w.room.economy.grid.dieselL, POWER.startDieselL + 20);
  w.room.economy.grid.dieselL = 59.5;
  assert.equal(buy({ item: 'diesel' }), 'tankFull');
  w.room.economy.grid.dieselL = 50;
  w.service.buyUpgrade('s1', { channelId: ROOM, item: 'diesel' });
  assert.equal(w.room.economy.grid.dieselL, 60, 'capped at 60 L');
  assert.equal(buy({ item: 'license', tier: 3 }), 'notEnoughTeamFunds');
  w.events.clear();
  assert.equal(w.service.buyUpgrade('s1', { channelId: ROOM, item: 'license', tier: 1 }).teamFunds, 50_000 - 15_000);
  assert.deepEqual(w.room.unlockedDistricts(), [0, 1]);
  assert.equal(w.room.lifetimeEarned, 0, 'a licence is not revenue');
  assert.deepEqual(w.events.of('districtUnlocked').map(([, p]) => p), [{ district: 1, unlockedDistricts: [0, 1] }]);
  assert.equal(buy({ item: 'license', tier: 1 }), 'alreadyUnlocked');
  w.player.personal.cash = 3_499;
  assert.equal(buy({ item: 'grease' }), 'notEnoughCash');
  w.player.personal.cash = 4_000;
  assert.deepEqual(w.service.buyUpgrade('s1', { channelId: ROOM, item: 'grease' }), { cash: 500, teamFunds: 35_000 });
  assert.equal(w.player.personal.greaseGun, true);
  assert.equal(buy({ item: 'grease' }), 'alreadyOwned');
  w.tick();
  assert.equal((w.events.of('personalUpdate').at(-1)?.[1] as { greaseGun: boolean }).greaseGun, true);
  assert.equal(economy(w).at(-1)?.funds, 35_000);
});

test('generator: only next to it, not without diesel; it powers the grid and burns diesel; economy update carries grid and lme', () => {
  const w = world();
  assert.equal(code(() => w.act({ kind: 'generator', on: true })), 'notAtGenerator');
  w.at(GEN.x, GEN.z + 1.5);
  w.room.economy.grid.dieselL = 0;
  assert.equal(code(() => w.act({ kind: 'generator', on: true })), 'noDiesel');
  assert.deepEqual(w.act({ kind: 'generator', on: false }), { ok: true, on: false });
  w.room.economy.grid.dieselL = 10;
  w.events.clear();
  assert.deepEqual(w.act({ kind: 'generator', on: true }), { ok: true, on: true });
  w.ticks(13);
  const grid = economy(w).map((u) => u.grid).filter((g) => g !== undefined).at(-1);
  assert.equal(grid?.genOn, true);
  assert.equal(grid?.genW, 25_000);
  assert.ok((w.room.economy.grid.dieselL ?? 0) < 10);
  assert.ok(economy(w).length <= 13, 'at most one per tick');
  const init = w.room.initState(w.player, 12, w.clock.ms).economy;
  assert.deepEqual(Object.keys(init), ['funds', 'bp', 'grid', 'lme', 'insp']);
  assert.equal(init.lme.epoch, lmeEpoch(w.clock.ms));
  // A new LME epoch is pushed once.
  w.clock.ms = (lmeEpoch(w.clock.ms) + 1) * 900_000;
  w.events.clear();
  w.ticks(3);
  assert.equal(economy(w).filter((u) => u.lme).length, 1);
});

test('persistence: economy round trip, defaults, corrupt economy keeps debris and logistics, machine wear/grease, stats v4', () => {
  const store = new MemoryStore();
  const a = world(true, { store });
  a.room.economy.bp = 0b0011;
  a.room.economy.grid.battWh = 1_234;
  a.room.economy.grid.dieselL = 7.5;
  a.room.economy.grid.genOn = true;
  a.room.economy.inspInMs = 99_000;
  a.room.economy.kg[3] = 42;
  a.at(4, -2);
  const stripper = a.place(TYPE.stripper, 4, -6.5);
  const st = a.logistics.structures.get(stripper);
  assert.ok(st);
  st.wear = 1_600;
  st.flags |= 4 | (0b0101 << 3);
  a.logistics.markStructuresDirty();
  a.logistics.restoreBuffer(stripper, load({ copper: 7 }));
  a.player.personal.greaseGun = true;
  a.service.dispose();
  const saved = store.rooms.get(ROOM);
  assert.ok(saved);
  assert.equal(saved.state['v'], ROOM_STATE_VERSION);
  assert.equal(ROOM_STATE_VERSION, 4);
  assert.deepEqual(saved.state['economy'], { v: 1, battWh: 1_234, dieselL: 7.5, genOn: true, bp: 3, inspInMs: 99_000, kg: [0, 0, 0, 42, 0, 0] });
  const config = store.structures.get(ROOM)?.find((r) => r.type === 'stripper')?.config;
  assert.deepEqual(config, { v: 1, rot: 0, lvl: 0, jam: false, wear: 1_600, grease: 5 });

  const b = world(false, { store });
  assert.deepEqual(b.room.loadWarnings, []);
  assert.deepEqual(b.room.economy.record(), saved.state['economy']);
  const st2 = b.logistics.structures.get(stripper);
  assert.equal(st2?.wear, 1_600);
  assert.equal((st2?.flags ?? 0) & 0b1111100, 4 | (0b0101 << 3));
  assert.ok(Math.abs((b.logistics.bufferOf(stripper)?.copperG ?? 0) - 7_000) < 1e-6);
  assert.equal(b.player.personal.greaseGun, true);
  b.service.dispose();

  // Corrupt economy → defaults; the blueprint is gone so the machine row is dropped with a warning; debris and logistics survive.
  const stored = store.rooms.get(ROOM);
  assert.ok(stored);
  store.rooms.set(ROOM, { ...stored, state: { ...stored.state, economy: { v: 1, battWh: 'x', dieselL: -5, genOn: 1, bp: 99, inspInMs: null, kg: 'no' } } });
  const c = world(false, { store });
  assert.deepEqual(c.room.economy.record(), { v: 1, battWh: POWER.batteryWh, dieselL: 0, genOn: false, bp: 0, inspInMs: INSPECT_MS, kg: [0, 0, 0, 0, 0, 0] });
  assert.ok(c.room.loadWarnings.some((m) => m.includes(`structure ${stripper} rejected`)));
  assert.ok(c.room.loadWarnings.some((m) => m.includes('buffer moved to the hopper')));
  assert.equal(c.room.debris.items.size > 0, true);
  c.service.dispose();
  // No economy key (a D row) → defaults.
  store.rooms.set(ROOM, { ...stored, state: { ...stored.state, economy: undefined } });
  const d = world(false, { store });
  assert.deepEqual(d.room.economy.record(), { v: 1, battWh: POWER.batteryWh, dieselL: POWER.startDieselL, genOn: false, bp: 0, inspInMs: INSPECT_MS, kg: [0, 0, 0, 0, 0, 0] });
  d.service.dispose();

  // stats_json v3 → v4: greaseGun defaults to false.
  const v3 = parsePersonal({ ...NEW_PLAYER_STATS }, { v: 3, starter: true, starterBags: true }, 0);
  assert.equal(v3.data.greaseGun, false);
  v3.data.greaseGun = true;
  const json = serialisePersonal(v3.data, 0);
  assert.equal(json['v'], 4);
  assert.equal(parsePersonal({ ...NEW_PLAYER_STATS }, json, 0).data.greaseGun, true);
});
