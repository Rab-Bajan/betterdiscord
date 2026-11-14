// Helpers for the Phase F vehicle tests: a joined world with team money, buying at the workbench,
// entering, driving in 50 ms steps and teleporting a vehicle.
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import type { VehicleAction } from '../../../src/modules/sweepers/payloads.ts';
import type { Vehicle } from '../../../src/modules/sweepers/vehicles/VehicleWorld.ts';
import { normaliseAngle } from '../../../src/modules/sweepers/motion.ts';
import { ROOM, world } from './logisticsSupport.ts';

type Body<A> = A extends unknown ? Omit<A, 'channelId'> : never;
export const OFFICE = cityLayout().landmarks.office;
/** Headings: +x, −x, +z, −z. */
export const EAST = -Math.PI / 2;
export const WEST = Math.PI / 2;
export const SOUTH = Math.PI;
export const NORTH = 0;

export function vworld(open = true) {
  const w = world(open);
  w.room.teamFunds = 10_000_000;
  const vehicles = w.room.vehicles;
  const of = (type: number): Vehicle => {
    const v = [...vehicles.vehicles.values()].find((x) => x.type === type);
    assert.ok(v, `vehicle type ${type}`);
    return v;
  };
  /** Buys `type` at the workbench (the player walks back to where it was). */
  const buy = (type: number, socket = 's1'): Vehicle => {
    const p = w.room.bySocket(socket);
    assert.ok(p);
    const pose = p.pose;
    p.pose = { ...pose, x: OFFICE.x - 5, z: OFFICE.z + 2.6 };
    w.service.buyUpgrade(socket, { channelId: ROOM, item: 'vehicle', tier: type });
    p.pose = pose;
    return of(type);
  };
  /** Walks next to the vehicle (1 m beside it) and enters `seat`. */
  const enter = (v: Vehicle, seat = 0, socket = 's1'): number => {
    const p = w.room.bySocket(socket);
    assert.ok(p);
    p.pose = { ...p.pose, x: v.x, z: v.z + 1, y: 0 };
    return w.service.vehicleEnter(socket, { channelId: ROOM, id: v.id, seat });
  };
  let seq = 0;
  /** One `vehicle_drive` after `dtMs`. */
  const drive = (x: number, z: number, rotY: number, dtMs = 50, socket = 's1'): void => {
    w.clock.ms += dtMs;
    w.service.vehicleDrive(socket, { channelId: ROOM, seq: ++seq, x, y: 0, z, rotY });
  };
  /** Drives `steps` × 50 ms at `speed` m/s along `rotY`; returns how many were not accepted as sent. */
  const cruise = (v: Vehicle, speed: number, steps: number, rotY: number): number => {
    let refused = 0;
    for (let i = 0; i < steps; i++) {
      const x = v.x - Math.sin(rotY) * speed * 0.05;
      const z = v.z - Math.cos(rotY) * speed * 0.05;
      drive(x, z, rotY);
      if (Math.abs(v.x - x) > 1e-9 || Math.abs(v.z - z) > 1e-9) refused++;
    }
    return refused;
  };
  const park = (v: Vehicle, x: number, z: number, rotY: number): void => {
    v.x = x;
    v.z = z;
    v.rotY = normaliseAngle(rotY);
  };
  const vact = (action: Body<VehicleAction>, socket = 's1') => w.service.vehicleAction(socket, { channelId: ROOM, ...action } as VehicleAction);
  return { ...w, vehicles, of, buy, enter, drive, cruise, park, vact };
}
