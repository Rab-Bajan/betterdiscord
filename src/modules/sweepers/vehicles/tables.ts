// MiskolcSweepers Phase F tables (plan F.1). Protocol order = index: the client hard-codes the same
// tables and the F fixture pins them. Units: metres, kg, litres, ms; forward = local −z.

/** One vehicle type (91–96). Seats are local (x, y, z); seat 0 is the driver / pusher. */
export interface VehicleType {
  key: string;
  name: string;
  capKg: number;
  topKmh: number;
  /** Pushed by hand (no fuel, lights or tank). */
  manual: boolean;
  /** 0 benzin, 1 dízel; null for the carts. */
  fuel: 0 | 1 | null;
  tankL: number;
  lPerKm: number;
  seats: ReadonlyArray<readonly [number, number, number]>;
  len: number;
  wid: number;
  /** Body circle radius (half width). */
  r: number;
  tareKg: number;
  priceFt: number;
  lights: boolean;
  beacon: boolean;
  horn: boolean;
  /** Brush (Multicar) / suction (IFA) width and efficiency. */
  brush: { widthM: number; eff: number } | null;
  /** The bed is at the front (wheelbarrow, nose tip). */
  bedFront: boolean;
}

const cartSeat = (len: number): ReadonlyArray<readonly [number, number, number]> => [[0, 0, len / 2 + 0.5]];

export const VEHICLE_TYPES: readonly VehicleType[] = Object.freeze([
  {
    key: 'handcart', name: 'Kétkerekű Kukás Kézikocsi', capKg: 120, topKmh: 16.2, manual: true, fuel: null, tankL: 0, lPerKm: 0, seats: cartSeat(1.4),
    len: 1.4, wid: 0.8, r: 0.4, tareKg: 45, priceFt: 8_000, lights: false, beacon: false, horn: false, brush: null, bedFront: false
  },
  {
    key: 'wheelbarrow', name: 'Közműves Horganyzott Talicska', capKg: 220, topKmh: 16.2, manual: true, fuel: null, tankL: 0, lPerKm: 0, seats: cartSeat(1.5),
    len: 1.5, wid: 0.7, r: 0.35, tareKg: 30, priceFt: 14_000, lights: false, beacon: false, horn: false, brush: null, bedFront: true
  },
  {
    key: 'simson', name: 'Simson Háromkerekű Riksa', capKg: 450, topKmh: 38, manual: false, fuel: 0, tankL: 5, lPerKm: 0.5, seats: [[0, 0.9, -0.4]],
    len: 2.6, wid: 1.2, r: 0.6, tareKg: 140, priceFt: 85_000, lights: true, beacon: false, horn: false, brush: null, bedFront: false
  },
  {
    key: 'lada', name: 'Platós Lada 1200 Utcaseprő', capKg: 800, topKmh: 65, manual: false, fuel: 0, tankL: 20, lPerKm: 2,
    seats: [[-0.35, 0.8, -0.3], [0.35, 0.8, -0.3]],
    len: 4.1, wid: 1.6, r: 0.8, tareKg: 950, priceFt: 240_000, lights: true, beacon: true, horn: false, brush: null, bedFront: false
  },
  {
    key: 'multicar', name: 'Multicar M25 Kommunális Seprő', capKg: 1_800, topKmh: 40, manual: false, fuel: 1, tankL: 30, lPerKm: 3,
    seats: [[-0.35, 1.2, -1.1], [0.35, 1.2, -1.1]],
    len: 3.5, wid: 1.6, r: 0.8, tareKg: 1_900, priceFt: 550_000, lights: true, beacon: true, horn: false, brush: { widthM: 2.4, eff: 0.8 }, bedFront: false
  },
  {
    key: 'ifa', name: 'IFA W50 Szippantós Seprőgép', capKg: 5_000, topKmh: 55, manual: false, fuel: 1, tankL: 60, lPerKm: 6,
    seats: [[-0.5, 1.6, -2.6], [-1.45, 0.6, 2.8], [1.45, 0.6, 2.8]],
    len: 7, wid: 2.5, r: 1.25, tareKg: 6_500, priceFt: 1_200_000, lights: true, beacon: true, horn: true, brush: { widthM: 3.5, eff: 1 }, bedFront: false
  }
]);
export const VEHICLE_TYPE_COUNT = VEHICLE_TYPES.length;
export const MAX_SEATS = 3;
export const IFA = 5;
export const FUELS = Object.freeze(['benzin', 'dízel'] as const);

export const vehicleType = (type: number): VehicleType => VEHICLE_TYPES[type] ?? VEHICLE_TYPES[0] ?? {
  key: '', name: '', capKg: 0, topKmh: 0, manual: true, fuel: null, tankL: 0, lPerKm: 0, seats: [], len: 1, wid: 1, r: 0.5, tareKg: 1, priceFt: 0,
  lights: false, beacon: false, horn: false, brush: null, bedFront: false
};

/** Top speed, m/s. */
export const topMps = (type: number): number => vehicleType(type).topKmh / 3.6;

/** Local (x, z) of the bed point: 0.3 m behind the rear (wheelbarrow: ahead of the nose). */
export function bedLocal(type: number): [number, number] {
  const t = vehicleType(type);
  return [0, t.bedFront ? -t.len / 2 - 0.3 : t.len / 2 + 0.3];
}

/** Local (x, z) of the filler neck. */
export function fillerLocal(type: number): [number, number] {
  const t = vehicleType(type);
  return [-t.wid / 2 - 0.3, t.len / 4];
}

/** Local z of the two end circles (same r as the body). */
export function endOffsets(type: number): [number, number] {
  const t = vehicleType(type);
  const e = Math.max(0, t.len / 2 - t.r);
  return [-e, e];
}

/** Local (lx, lz) → world offset for heading rotY (three.js rotation about y). */
export function toWorld(rotY: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [lx * c + lz * s, -lx * s + lz * c];
}

/** Spawn slot of a type: (−8 + 4·type, −10), heading +x. */
export const spawnSlot = (type: number): { x: number; z: number; rotY: number } => ({ x: -8 + 4 * type, z: -10, rotY: -Math.PI / 2 });

/** Rules constants (F.1). */
export const VEHICLE_CAP = 6;
/** Enter / repair reach beyond the body radius, m. */
export const ENTER_REACH_EXTRA_M = 1.5;
/** Load / dump / refuel reach from the bed point / filler neck, m. */
export const BED_REACH_M = 1.5;
export const STOPPED_MPS = 0.5;
export const TIP_MS = 3_000;
export const BED_BAGS = 12;
/** 35 km/h (spec 103). */
export const CURB_MPS = 9.72;
export const PUNCTURE_CHANCE = 0.35;
export const ALIGN_MAX = 4;
export const CURB_COOLDOWN_MS = 1_000;
export const PUNCT_SPEED = 0.6;
export const HORN_COOLDOWN_MS = 1_500;
export const IDLE_STOP_MS = 500;
/** A drive may move the nose / tail circles this much (resolution rounding) before it is refused. */
export const END_TOLERANCE_M = 0.01;
/** Exit point: local (−W/2 − 0.6, 0). */
export const EXIT_SIDE_M = 0.6;
export const REPAIR_FT = 3_000;
export const JERRYCAN = Object.freeze({ ft: 4_000, l: 10, name: 'Benzineskanna 10 L' });
/** Garage refuel (105): 2 L/s at 400 Ft/L from the team funds, stepped once a second. */
export const GARAGE = Object.freeze({ lPerS: 2, ftPerL: 400, stepMs: 1_000 });

/** `VehicleRow[7]` flag bits. */
export const VFLAG = Object.freeze({ lightsMask: 0b11, beacon: 1 << 2, tipping: 1 << 3, punct: 1 << 4, stalled: 1 << 5, corr: 1 << 6, garage: 1 << 7, alignShift: 8 });
