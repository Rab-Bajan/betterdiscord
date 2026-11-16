// The MiskolcSweepers city: generated deterministically from a fixed seed (identical for every
// room; rooms differ in state, not geography) and sent in `init_state.layout`.
import { axialDistance, axialToWorld, HEX_CELLS, HEX_OUTER_RADIUS } from '../hexGrid.ts';
import { buildingColliders, propColliders } from './colliders.ts';
import type { DistrictContext } from './districtKit.ts';
import { buildAvas } from './districts/avas.ts';
import { buildAvasKilato } from './districts/avasKilato.ts';
import { buildBuzaTer } from './districts/buzaTer.ts';
import { buildMehTelep } from './districts/mehTelep.ts';
import { buildUjgyoriPiac } from './districts/ujgyoriPiac.ts';
import { buildVasgyar } from './districts/vasgyar.ts';
import { LayoutBuilder } from './LayoutBuilder.ts';
import type { Building, CityLayout, Collider, DistrictBorder, Prop, Road, Surface } from './layoutTypes.ts';
import { addMainRoads, addPuddles, addStreetLamps, curbsFor, mainRoadSegments } from './roads.ts';
import { rotationAlong } from './rotation.ts';
import { buildHeightfield } from './terrain.ts';

export const LAYOUT_VERSION = 1;
/** The seed of the one Miskolc ("MSKC"). Changing it changes the city: bump LAYOUT_VERSION too. */
export const LAYOUT_SEED = 0x4d534b43;

const GENERATORS: ReadonlyArray<(ctx: DistrictContext) => void> = [
  buildAvas, buildUjgyoriPiac, buildVasgyar, buildBuzaTer, buildAvasKilato
];

const m = (value: number): number => Math.round(value * 100) / 100 + 0;
const rad = (value: number): number => Math.round(Math.atan2(Math.sin(value), Math.cos(value)) * 1000) / 1000 + 0;

const roundBuilding = (b: Building): Building => ({ ...b, x: m(b.x), z: m(b.z), w: m(b.w), d: m(b.d), h: m(b.h), rotY: rad(b.rotY) });
const roundProp = (p: Prop): Prop => ({ kind: p.kind, x: m(p.x), z: m(p.z), rotY: rad(p.rotY), s: m(p.s) });
const roundRoad = (r: Road): Road => ({ kind: r.kind, width: m(r.width), points: r.points.map(([x, z]) => [m(x), m(z)]) });
const roundSurface = (s: Surface): Surface => ({ ...s, x: m(s.x), z: m(s.z), r: m(s.r) });
const roundCollider = (c: Collider): Collider => c.shape === 'cyl'
  ? { shape: 'cyl', x: m(c.x), z: m(c.z), r: m(c.r), h: m(c.h) }
  : { shape: 'box', x: m(c.x), z: m(c.z), w: m(c.w), d: m(c.d), h: m(c.h), rotY: rad(c.rotY) };

/** Every hex edge between grid hexes of two different districts. */
function districtBorders(): DistrictBorder[] {
  const borders: DistrictBorder[] = [];
  for (const a of HEX_CELLS) {
    for (const b of HEX_CELLS) {
      if (b.id <= a.id || a.district === b.district || axialDistance({ q: a.q - b.q, r: a.r - b.r }) !== 1) continue;
      const ca = axialToWorld(a);
      const cb = axialToWorld(b);
      const [lo, hi] = a.district < b.district ? [a.district, b.district] : [b.district, a.district];
      // The edge runs perpendicular to the line between the two centres.
      borders.push({ a: lo, b: hi, x: m((ca.x + cb.x) / 2), z: m((ca.z + cb.z) / 2), rotY: rad(rotationAlong(-(cb.z - ca.z), cb.x - ca.x)), len: HEX_OUTER_RADIUS });
    }
  }
  return borders;
}

/** Generates the city. Pure: the same output on every call. */
export function generateCityLayout(): CityLayout {
  const builder = new LayoutBuilder(LAYOUT_SEED);
  const segments = mainRoadSegments();
  addMainRoads(builder, segments);
  // A beacon lamp on every hex centre (spec 24).
  for (const cell of HEX_CELLS) {
    const { x, z } = axialToWorld(cell);
    builder.addProp('hex_lamp', x, z, 0);
  }
  const contextOf = (district: number): DistrictContext => ({
    builder, district, cells: HEX_CELLS.filter((c) => c.district === district), roads: segments
  });
  const landmarks = buildMehTelep(contextOf(0));
  GENERATORS.forEach((generate, i) => generate(contextOf(i + 1)));
  addStreetLamps(builder, segments);
  addPuddles(builder, segments);
  const curbs = curbsFor(builder, segments);

  const buildings = builder.buildings.map(roundBuilding);
  const props = builder.props.map(roundProp);
  // Colliders come from the rounded entries, so a client deriving them itself gets the same numbers.
  const colliders = [...buildings.flatMap(buildingColliders), ...props.flatMap(propColliders), ...curbs].map(roundCollider);
  return {
    version: LAYOUT_VERSION,
    heightfield: buildHeightfield(),
    roads: builder.roads.map(roundRoad),
    buildings,
    props,
    colliders,
    surfaces: builder.surfaces.map(roundSurface),
    borders: districtBorders(),
    landmarks: {
      weighbridge: { ...landmarks.weighbridge, x: m(landmarks.weighbridge.x), z: m(landmarks.weighbridge.z), rotY: rad(landmarks.weighbridge.rotY) },
      hopper: { ...landmarks.hopper, x: m(landmarks.hopper.x), z: m(landmarks.hopper.z), rotY: rad(landmarks.hopper.rotY) },
      office: { x: m(landmarks.office.x), z: m(landmarks.office.z), rotY: rad(landmarks.office.rotY) },
      generator: { x: m(landmarks.generator.x), z: m(landmarks.generator.z), rotY: rad(landmarks.generator.rotY) }
    }
  };
}

let cached: CityLayout | null = null;

/** The city layout, generated once per process (treat as read-only). */
export function cityLayout(): CityLayout {
  cached ??= generateCityLayout();
  return cached;
}
