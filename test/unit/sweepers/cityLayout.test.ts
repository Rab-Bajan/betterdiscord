import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout, generateCityLayout, LAYOUT_VERSION } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { buildingColliders, propColliders } from '../../../src/modules/sweepers/city/colliders.ts';
import { BUILDING_KINDS, PROP_KINDS, ROAD_KINDS, SURFACE_KINDS } from '../../../src/modules/sweepers/city/layoutTypes.ts';
import type { BuildingKind, Collider } from '../../../src/modules/sweepers/city/layoutTypes.ts';
import { HILL_HEIGHT, HILL_PEAK } from '../../../src/modules/sweepers/city/terrain.ts';
import { ColliderIndex, groundHeight, isBlocking, penetration, PLAYER_RADIUS, sweepCircle } from '../../../src/modules/sweepers/geometry.ts';
import { axialToWorld, districtAt, HEX_CELLS, hexAt } from '../../../src/modules/sweepers/hexGrid.ts';
import { spawnPose } from '../../../src/modules/sweepers/SweepersRoom.ts';

const layout = cityLayout();

test('deterministic: version 1, the same city on every generation; compact (< 120 kB)', () => {
  assert.equal(layout.version, LAYOUT_VERSION);
  assert.equal(LAYOUT_VERSION, 1);
  const again = generateCityLayout();
  assert.deepEqual(again, layout);
  const bytes = Buffer.byteLength(JSON.stringify(layout));
  assert.ok(bytes < 120_000, `layout is ${bytes} bytes`);
  assert.equal(cityLayout(), layout, 'generated once per process');
});

// Golden hash of the generated city (review LOW-3). Every district shares one RNG stream, so any
// change to a generator or a placement check moves later districts too. The frontend keeps a
// byte-identical fixture of this output and later phases persist world coordinates against it.
const LAYOUT_V1_SHA256 = 'd5ad3c17784e85340687e83e1f58f7252aaa69a36029086877446a9c42416042';

test('golden: the generated layout bytes are pinned to LAYOUT_VERSION 1', () => {
  const hash = createHash('sha256').update(JSON.stringify(generateCityLayout())).digest('hex');
  assert.equal(hash, LAYOUT_V1_SHA256,
    'The city layout output changed: bump LAYOUT_VERSION, update this hash and regenerate the frontend fixture with its explicit path: '
    + 'node scripts/buildSweepersFixture.mjs ../betterdiscord-frontend/tests/fixtures/sweepers-b-layout-fixture.json (frontend checkout next to this one; also copy to .omc/handoffs/ if used).');
});

test('numbers are rounded to 0.01 m and 0.001 rad', () => {
  const metres = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  const radians = (v: number): boolean => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6 && Math.abs(v) <= Math.PI + 1e-3;
  for (const b of layout.buildings) assert.ok([b.x, b.z, b.w, b.d, b.h].every(metres) && radians(b.rotY), b.id);
  for (const p of layout.props) assert.ok([p.x, p.z, p.s].every(metres) && radians(p.rotY), p.kind);
  for (const c of layout.colliders) {
    assert.ok([c.x, c.z, c.h].every(metres));
    if (c.shape === 'box') assert.ok([c.w, c.d].every(metres) && radians(c.rotY));
    else assert.ok(metres(c.r));
  }
  for (const r of layout.roads) assert.ok(r.points.flat().every(metres) && metres(r.width));
  assert.ok(layout.heightfield.heightsCm.every(Number.isInteger));
});

test('heightfield: 61 × 61 samples from -300 m every 10 m; flat city, the Avas hill in district 5', () => {
  const { heightfield } = layout;
  assert.deepEqual([heightfield.origin, heightfield.cell, heightfield.size, heightfield.heightsCm.length], [-300, 10, 61, 61 * 61]);
  assert.equal(groundHeight(heightfield, 0, 0), 0);
  for (const cell of HEX_CELLS.filter((c) => c.district === 0 || c.district === 2 || c.district === 3)) {
    const { x, z } = axialToWorld(cell);
    assert.equal(groundHeight(heightfield, x, z), 0, `hex ${cell.id}`);
  }
  assert.equal(districtAt(HILL_PEAK.x, HILL_PEAK.z), 5);
  const summit = groundHeight(heightfield, HILL_PEAK.x, HILL_PEAK.z);
  assert.ok(summit > HILL_HEIGHT * 0.9 && summit <= HILL_HEIGHT, `summit ${summit}`);
  // Walkable everywhere: no slope between neighbouring samples steeper than 50 %.
  for (let iz = 0; iz < 61; iz++) {
    for (let ix = 1; ix < 61; ix++) {
      const a = heightfield.heightsCm[iz * 61 + ix - 1] ?? 0;
      const b = heightfield.heightsCm[iz * 61 + ix] ?? 0;
      assert.ok(Math.abs(a - b) / 100 / 10 <= 0.5);
    }
  }
});

test('every building, prop, road and surface kind of the protocol appears; all kinds are known', () => {
  assert.deepEqual(new Set(layout.buildings.map((b) => b.kind)), new Set(BUILDING_KINDS));
  assert.deepEqual(new Set(layout.props.map((p) => p.kind)), new Set(PROP_KINDS));
  assert.deepEqual(new Set(layout.roads.map((r) => r.kind)), new Set(ROAD_KINDS));
  assert.deepEqual(new Set(layout.surfaces.map((s) => s.kind)), new Set(SURFACE_KINDS));
  assert.equal(new Set(layout.buildings.map((b) => b.id)).size, layout.buildings.length, 'unique building ids');
});

test('each district has its caricature and every building stands in its own district', () => {
  const kindsOf = (district: number): Set<BuildingKind> => new Set(layout.buildings.filter((b) => b.district === district).map((b) => b.kind));
  const expected: Record<number, BuildingKind[]> = {
    0: ['scrap_fence', 'office_container', 'weighbridge', 'led_display', 'hopper', 'generator', 'sorting_shed', 'scrap_pile'],
    1: ['panel10', 'kukatarolo', 'playground'],
    2: ['market_row', 'market_stall'],
    3: ['factory_hall', 'chimney', 'ore_wagon', 'gantry_crane'],
    4: ['bus_platform', 'bus_shelter', 'ticket_kiosk', 'subway_stairs'],
    5: ['wine_cellar', 'tv_tower', 'lookout']
  };
  for (const [district, kinds] of Object.entries(expected)) {
    const present = kindsOf(Number(district));
    for (const kind of kinds) assert.ok(present.has(kind), `district ${district} lacks ${kind}`);
  }
  for (const b of layout.buildings) assert.equal(hexAt(b.x, b.z)?.district, b.district, `${b.id} (${b.kind}) at ${b.x}, ${b.z}`);
  // Spec details: panel blocks are ten storeys, the scrap fence 2 m, the weighbridge 12 × 3.5 m, the hopper 4 × 4 m.
  assert.ok(layout.buildings.filter((b) => b.kind === 'panel10').every((b) => b.h >= 28));
  assert.ok(layout.buildings.filter((b) => b.kind === 'scrap_fence').every((b) => b.h === 2));
  const weighbridge = layout.buildings.find((b) => b.kind === 'weighbridge');
  const hopper = layout.buildings.find((b) => b.kind === 'hopper');
  assert.ok(weighbridge && hopper);
  assert.deepEqual(layout.landmarks.weighbridge, { x: weighbridge.x, z: weighbridge.z, w: 12, d: 3.5, rotY: weighbridge.rotY });
  assert.deepEqual(layout.landmarks.hopper, { x: hopper.x, z: hopper.z, w: 4, d: 4, rotY: hopper.rotY });
  for (const kind of ['office_container', 'generator'] as const) {
    const b = layout.buildings.find((x) => x.kind === kind);
    const mark = kind === 'office_container' ? layout.landmarks.office : layout.landmarks.generator;
    assert.ok(b);
    assert.deepEqual(mark, { x: b.x, z: b.z, rotY: b.rotY });
  }
  // Wine cellars and the summit towers stand on the hill.
  for (const b of layout.buildings.filter((x) => x.kind === 'wine_cellar' || x.kind === 'tv_tower')) {
    assert.ok(groundHeight(layout.heightfield, b.x, b.z) > 3, `${b.kind} at ground ${groundHeight(layout.heightfield, b.x, b.z)}`);
  }
});

test('a hex_lamp on every hex centre', () => {
  const lamps = layout.props.filter((p) => p.kind === 'hex_lamp');
  assert.equal(lamps.length, 37);
  for (const cell of HEX_CELLS) {
    const { x, z } = axialToWorld(cell);
    assert.ok(lamps.some((l) => Math.abs(l.x - x) < 0.01 && Math.abs(l.z - z) < 0.01), `hex ${cell.id}`);
  }
});

test('roads join every district: the main road graph connects all hex centres and the yard gates', () => {
  const mainRoads = layout.roads.filter((r) => r.kind === 'road');
  const key = ([x, z]: [number, number]): string => `${Math.round(x)},${Math.round(z)}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let p = parent.get(k) ?? k;
    while (parent.get(p) !== undefined && parent.get(p) !== p) p = parent.get(p) ?? p;
    return p;
  };
  const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
  // The gates open into one yard.
  const gates = mainRoads.map((r) => r.points[0]).filter((p): p is [number, number] => p !== undefined && Math.hypot(p[0], p[1]) < 34);
  assert.equal(gates.length, 3);
  for (const gate of gates) union(key(gate), 'yard');
  for (const road of mainRoads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      if (a && b) union(key(a), key(b));
    }
  }
  const root = find('yard');
  for (const cell of HEX_CELLS.slice(1)) {
    const { x, z } = axialToWorld(cell);
    assert.equal(find(key([x, z])), root, `hex ${cell.id} not connected`);
  }
});

test('colliders: derived from buildings, props and curbs only, never for walk-over pads; curbs step-over', () => {
  const derived = [...layout.buildings.flatMap(buildingColliders), ...layout.props.flatMap(propColliders)];
  const curbs = layout.colliders.slice(derived.length);
  assert.equal(layout.colliders.length, derived.length + curbs.length);
  assert.ok(curbs.length >= 2 * layout.roads.filter((r) => r.kind === 'road').length);
  for (const c of curbs) assert.ok(c.shape === 'box' && c.h === 0.15 && !isBlocking(c));
  assert.ok(layout.props.some((p) => p.kind === 'curb_ramp'));
  for (const b of layout.buildings.filter((x) => x.kind === 'playground' || x.kind === 'weighbridge')) {
    assert.equal(buildingColliders(b).length, 0);
  }
  for (const kind of ['cardboard', 'awning', 'satellite_dish', 'laundry', 'hazard_tape', 'stair_flight', 'curb_ramp', 'iron_beam', 'rail_segment'] as const) {
    assert.ok(layout.props.filter((p) => p.kind === kind).every((p) => propColliders(p).length === 0), kind);
  }
  assert.ok(layout.buildings.filter((b) => b.kind === 'bus_platform').every((b) => b.h <= 0.35), 'platforms are stepped onto');
});

test('the main roads are drivable: no blocking collider on a carriageway except the hex lamp islands', () => {
  const lampSpots = HEX_CELLS.map(axialToWorld);
  const obstacles = new ColliderIndex(layout.colliders.filter((c) => !(c.shape === 'cyl' && lampSpots.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 0.01))));
  for (const road of layout.roads.filter((r) => r.kind === 'road')) {
    const [a, b] = road.points;
    assert.ok(a && b);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let u = 0; u <= length; u += 0.5) {
      const x: number = a[0] + ((b[0] - a[0]) * u) / length;
      const z: number = a[1] + ((b[1] - a[1]) * u) / length;
      const hits: Collider[] = obstacles.near(x, z, road.width / 2).filter((c) => penetration(c, x, z, road.width / 2 - 0.05));
      assert.equal(hits.length, 0, `road ${a.join(',')} → ${b.join(',')} blocked at ${x.toFixed(1)}, ${z.toFixed(1)}: ${JSON.stringify(hits[0])}`);
    }
  }
});

test('the spawn area and the yard lanes are free of blocking colliders; the gates are open', () => {
  const index = new ColliderIndex(layout.colliders);
  for (let id = 1; id <= 64; id++) {
    const { x, z } = spawnPose(id);
    assert.equal(index.near(x, z, PLAYER_RADIUS).filter((c: Collider) => penetration(c, x, z, PLAYER_RADIUS)).length, 0, `spawn ${id}`);
  }
  // From the centre out through each gate to the next hex centre's road.
  for (const target of [[60, 0], [-30, 52], [-30, -52]] as const) {
    const angle = Math.atan2(target[1], target[0]);
    const from = { x: Math.cos(angle) * 3, z: Math.sin(angle) * 3 };
    assert.equal(sweepCircle(index, from.x, from.z, target[0], target[1]).hit, false, `lane to ${target.join(',')}`);
  }
});

test('surfaces: wet puddles on the roads, mud at the market, grease and acid at the steelworks', () => {
  const at = (kind: string): number[] => layout.surfaces.filter((s) => s.kind === kind).map((s) => districtAt(s.x, s.z));
  assert.ok(at('wet').length >= 5);
  assert.ok(at('mud').includes(2));
  assert.ok(at('grease').every((d) => d === 3) && at('grease').length > 0);
  assert.ok(at('acid').every((d) => d === 3) && at('acid').length > 0);
  for (const s of layout.surfaces) assert.ok(s.r > 0 && s.shape === 'circle');
});

test('district borders: one per hex edge between two districts, each shared by two neighbouring hexes', () => {
  assert.ok(layout.borders.length > 0);
  for (const border of layout.borders) {
    assert.ok(border.a < border.b);
    assert.equal(border.len, 40);
    // Just inside each side of the edge midpoint lie the two districts.
    const nx = Math.sin(border.rotY);
    const nz = Math.cos(border.rotY);
    const sides = [districtAt(border.x + nx, border.z + nz), districtAt(border.x - nx, border.z - nz)].sort();
    assert.deepEqual(sides, [border.a, border.b]);
  }
  const keys = layout.borders.map((b) => `${b.x},${b.z}`);
  assert.equal(new Set(keys).size, keys.length);
  // The centre hex borders all five ring districts (six edges: Avas twice).
  assert.equal(layout.borders.filter((b) => b.a === 0).length, 6);
});
