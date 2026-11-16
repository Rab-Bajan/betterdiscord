// Wire shape of `init_state.layout` (Phase B, layout version 1). Units: metres, rotation radians.
// Rotation convention (three.js `Object3D.rotation.y`): an entry with rotation θ has its local
// x axis (width `w`) along world (cos θ, −sin θ) and its local z axis (depth `d`) along (sin θ, cos θ).

export const BUILDING_KINDS = Object.freeze([
  'panel10', 'kukatarolo', 'playground', 'market_row', 'market_stall', 'factory_hall', 'chimney', 'gantry_crane',
  'ore_wagon', 'bus_shelter', 'bus_platform', 'ticket_kiosk', 'subway_stairs', 'wine_cellar', 'tv_tower', 'lookout',
  'scrap_fence', 'office_container', 'weighbridge', 'hopper', 'led_display', 'generator', 'sorting_shed', 'scrap_pile'
] as const);
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export const PROP_KINDS = Object.freeze([
  'hex_lamp', 'street_lamp', 'bench', 'tree', 'bin', 'fence', 'curb_ramp', 'crate', 'cardboard', 'awning',
  'rail_segment', 'iron_beam', 'satellite_dish', 'laundry', 'hazard_tape', 'stair_flight'
] as const);
export type PropKind = (typeof PROP_KINDS)[number];

export const ROAD_KINDS = Object.freeze(['road', 'sidewalk', 'rail', 'path', 'stairs'] as const);
export type RoadKind = (typeof ROAD_KINDS)[number];

export const SURFACE_KINDS = Object.freeze(['wet', 'mud', 'grease', 'acid'] as const);
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Ground samples, row-major: index = iz * size + ix, world x = origin + ix * cell, z = origin + iz * cell. */
export interface Heightfield {
  origin: number;
  cell: number;
  size: number;
  heightsCm: number[];
}

export interface Road {
  kind: RoadKind;
  width: number;
  points: Array<[number, number]>;
}

export interface Building {
  id: string;
  kind: BuildingKind;
  district: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rotY: number;
}

export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  rotY: number;
  /** Uniform scale, 1 = nominal size. */
  s: number;
}

/** y starts at the ground at (x, z); `h` is the top above the ground. `h <= 0.35` is step-over. */
export interface BoxCollider {
  shape: 'box';
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rotY: number;
}

export interface CylCollider {
  shape: 'cyl';
  x: number;
  z: number;
  r: number;
  h: number;
}

export type Collider = BoxCollider | CylCollider;

export interface Surface {
  kind: SurfaceKind;
  shape: 'circle';
  x: number;
  z: number;
  r: number;
}

/**
 * One hex edge between two grid hexes of different districts (a < b). Hazard tape is shown on it
 * while exactly one of the two districts is unlocked. x/z = edge midpoint, rotY = along the edge.
 */
export interface DistrictBorder {
  a: number;
  b: number;
  x: number;
  z: number;
  rotY: number;
  len: number;
}

export interface Landmarks {
  weighbridge: { x: number; z: number; w: number; d: number; rotY: number };
  hopper: { x: number; z: number; w: number; d: number; rotY: number };
  office: { x: number; z: number; rotY: number };
  generator: { x: number; z: number; rotY: number };
}

export interface CityLayout {
  version: number;
  heightfield: Heightfield;
  roads: Road[];
  buildings: Building[];
  props: Prop[];
  colliders: Collider[];
  surfaces: Surface[];
  borders: DistrictBorder[];
  landmarks: Landmarks;
}
