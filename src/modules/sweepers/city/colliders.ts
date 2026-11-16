// Colliders derived from the layout's buildings and props: only real obstacles get one.
import { axisU, axisV } from './rotation.ts';
import type { Building, Collider, Prop, PropKind } from './layoutTypes.ts';

/** Gantry crane leg radius and its inset from the footprint corners. */
const CRANE_LEG_RADIUS = 0.4;
const CRANE_LEG_INSET = 0.6;

/** Colliders of one building, in world space (none for flat pads you walk or drive over). */
export function buildingColliders(b: Building): Collider[] {
  switch (b.kind) {
    case 'playground':
    case 'weighbridge':
      return [];
    case 'chimney':
    case 'tv_tower':
    case 'lookout':
    case 'scrap_pile':
      return [{ shape: 'cyl', x: b.x, z: b.z, r: Math.min(b.w, b.d) / 2, h: b.h }];
    case 'gantry_crane': {
      // Four legs; the span between them stays open (rails and wagons pass under).
      const [ux, uz] = axisU(b.rotY);
      const [vx, vz] = axisV(b.rotY);
      const a = b.w / 2 - CRANE_LEG_INSET;
      const c = b.d / 2 - CRANE_LEG_INSET;
      return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([su = 0, sv = 0]) => ({
        shape: 'cyl', x: b.x + su * a * ux + sv * c * vx, z: b.z + su * a * uz + sv * c * vz, r: CRANE_LEG_RADIUS, h: b.h
      }));
    }
    default:
      return [{ shape: 'box', x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, rotY: b.rotY }];
  }
}

/** Nominal (s = 1) obstacle of a prop kind; kinds missing here block nothing. */
const PROP_OBSTACLES: Partial<Record<PropKind, { shape: 'cyl'; r: number; h: number } | { shape: 'box'; w: number; d: number; h: number }>> = {
  hex_lamp: { shape: 'cyl', r: 0.25, h: 7 },
  street_lamp: { shape: 'cyl', r: 0.12, h: 6 },
  tree: { shape: 'cyl', r: 0.35, h: 7 },
  bin: { shape: 'cyl', r: 0.35, h: 1.1 },
  bench: { shape: 'box', w: 1.8, d: 0.6, h: 0.85 },
  fence: { shape: 'box', w: 2, d: 0.1, h: 1.1 },
  crate: { shape: 'box', w: 0.8, d: 0.8, h: 0.7 }
};

/** Colliders of one prop (scaled by `s`); empty for decor. */
export function propColliders(p: Prop): Collider[] {
  const o = PROP_OBSTACLES[p.kind];
  if (!o) return [];
  if (o.shape === 'cyl') return [{ shape: 'cyl', x: p.x, z: p.z, r: o.r * p.s, h: o.h * p.s }];
  return [{ shape: 'box', x: p.x, z: p.z, w: o.w * p.s, d: o.d * p.s, h: o.h * p.s, rotY: p.rotY }];
}
