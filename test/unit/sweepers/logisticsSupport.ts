// Helpers for the Phase D logistics tests: a joined world with every district open, pose control,
// placement through the service, refusal codes and loads.
import assert from 'node:assert/strict';
import { emptyLoad } from '../../../src/modules/sweepers/debris/personal.ts';
import type { Load } from '../../../src/modules/sweepers/debris/personal.ts';
import { parsePlaceStructure } from '../../../src/modules/sweepers/payloads.ts';
import type { LogisticsAction } from '../../../src/modules/sweepers/payloads.ts';
import { SweepersError } from '../../../src/modules/sweepers/SweepersError.ts';
import { guest, makeService } from './support.ts';

export const ROOM = 'hang-chill';
type Body<A> = A extends unknown ? Omit<A, 'channelId'> : never;
export const TICK_MS = 84;

/** `ok`, or `<code>:<reason>` of a refusal (the D.8 key), or the error code. */
export function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SweepersError) {
      const reason = (err.details as { reason?: string } | undefined)?.reason;
      return reason ?? err.code;
    }
    if (err instanceof Error && 'code' in err) return String((err as { code: unknown }).code);
    throw err;
  }
  return 'ok';
}

/** A load of the given kg (dust, iron, copper) plus cans and jackpots. */
export function load(kg: { dust?: number; iron?: number; copper?: number; cans?: number; jackpots?: number[] }): Load {
  return { ...emptyLoad(), dustG: (kg.dust ?? 0) * 1000, ironG: (kg.iron ?? 0) * 1000, copperG: (kg.copper ?? 0) * 1000, cans: kg.cans ?? 0, jackpots: kg.jackpots ?? [] };
}

/** One joined player in `hang-chill`; `open` unlocks every district first. */
export function world(open = true, overrides: Parameters<typeof makeService>[0] = {}) {
  const t = makeService(overrides);
  t.service.join(ROOM, 's1', guest('Builder'));
  const room = t.service.room(ROOM);
  const player = room?.bySocket('s1');
  assert.ok(room && player);
  if (open) t.service.addRevenue(ROOM, 1e12);
  const logistics = room.logistics;
  const at = (x: number, z: number, rotY = 0): void => { player.pose = { ...player.pose, x, y: 0, z, rotY }; };
  const tick = (ms = TICK_MS): void => { t.clock.ms += ms; t.service.tick(); };
  const ticks = (n: number, ms = TICK_MS): void => { for (let i = 0; i < n; i++) tick(ms); };
  const place = (type: number, x: number, z: number, rot = 0, lvl = 0): number =>
    t.service.placeStructure('s1', parsePlaceStructure({ channelId: ROOM, type, x, z, rot, lvl }));
  const tryPlace = (type: number, x: number, z: number, rot = 0, lvl = 0): string => code(() => place(type, x, z, rot, lvl));
  const act = (action: Body<LogisticsAction>) => t.service.logisticsAction('s1', { channelId: ROOM, ...action } as LogisticsAction);
  const tie = (tier: number) => t.service.tieBag('s1', ROOM, tier);
  /** Ties a fresh bag of `kg` dust in front of (x, z), past the tie cadence. */
  const tieAt = (x: number, z: number, kg: Parameters<typeof load>[0], tier = 0, rotY = 0) => {
    at(x, z, rotY);
    t.clock.ms += 2_000;
    player.personal.pack = load(kg);
    return tie(tier);
  };
  return { ...t, room, player, logistics, at, tick, ticks, place, tryPlace, act, tie, tieAt };
}
