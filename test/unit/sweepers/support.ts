// Fakes for the sweepers service tests: a manual clock and scheduler, an in-memory store and an
// event recorder.
import { Logger } from '../../../src/core/logging/Logger.ts';
import type { SweepersEvents } from '../../../src/modules/sweepers/SweepersBroadcaster.ts';
import type { MoveWorld } from '../../../src/modules/sweepers/motion.ts';
import type { PlayerIdentity } from '../../../src/modules/sweepers/SweepersPlayer.ts';
import type { PlayerStatsRecord, RoomRecord, SweepersStore } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { SweepersService } from '../../../src/modules/sweepers/SweepersService.ts';
import type { SweepersServiceOptions } from '../../../src/modules/sweepers/SweepersService.ts';
import type { PersonalStats } from '../../../src/modules/sweepers/types.ts';

export class ManualClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

/** Records scheduled loops; never fires them on its own. */
export class ManualScheduler {
  readonly loops: Array<{ intervalMs: number; task: () => void; cancelled: boolean }> = [];
  readonly schedule = (intervalMs: number, task: () => void): (() => void) => {
    const loop = { intervalMs, task, cancelled: false };
    this.loops.push(loop);
    return () => { loop.cancelled = true; };
  };

  get active(): number {
    return this.loops.filter((l) => !l.cancelled).length;
  }
}

export class MemoryStore implements SweepersStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly stats = new Map<string, PersonalStats>();
  saves = 0;

  loadRoom(roomId: string): RoomRecord | null {
    return this.rooms.get(roomId) ?? null;
  }

  loadPlayerStats(userId: string, roomId: string): PersonalStats | null {
    return this.stats.get(`${userId}|${roomId}`) ?? null;
  }

  saveRoom(room: RoomRecord, players: readonly PlayerStatsRecord[]): void {
    this.saves++;
    this.rooms.set(room.roomId, structuredClone(room));
    for (const p of players) this.savePlayerStats(p);
  }

  savePlayerStats({ userId, roomId, stats }: PlayerStatsRecord): void {
    this.stats.set(`${userId}|${roomId}`, { ...stats });
  }
}

export type Recorded = [string, ...unknown[]];

export class RecordingEvents implements SweepersEvents {
  readonly log: Recorded[] = [];
  initState(...args: Parameters<SweepersEvents['initState']>): void { this.log.push(['initState', ...args]); }
  tickSync(...args: Parameters<SweepersEvents['tickSync']>): void { this.log.push(['tickSync', ...args]); }
  playerJoined(...args: Parameters<SweepersEvents['playerJoined']>): void { this.log.push(['playerJoined', ...args]); }
  playerLeft(...args: Parameters<SweepersEvents['playerLeft']>): void { this.log.push(['playerLeft', ...args]); }
  sessionUpdated(...args: Parameters<SweepersEvents['sessionUpdated']>): void { this.log.push(['sessionUpdated', ...args]); }
  kicked(...args: Parameters<SweepersEvents['kicked']>): void { this.log.push(['kicked', ...args]); }
  districtUnlocked(...args: Parameters<SweepersEvents['districtUnlocked']>): void { this.log.push(['districtUnlocked', ...args]); }
  clock(...args: Parameters<SweepersEvents['clock']>): void { this.log.push(['clock', ...args]); }
  clockTo(...args: Parameters<SweepersEvents['clockTo']>): void { this.log.push(['clockTo', ...args]); }
  weather(...args: Parameters<SweepersEvents['weather']>): void { this.log.push(['weather', ...args]); }

  /** Recorded calls of `name`, removing nothing. */
  of(name: string): unknown[][] {
    return this.log.filter(([n]) => n === name).map(([, ...args]) => args);
  }

  clear(): void {
    this.log.length = 0;
  }
}

/** Flat ground at 0, no colliders, every district open. */
export const OPEN_WORLD: MoveWorld = {
  ground: () => 0,
  isOpen: () => true,
  sweep: (_fromX, _fromZ, toX, toZ) => ({ x: toX, z: toZ, hit: false })
};

export const guest = (username: string): PlayerIdentity => ({ key: `name:${username.toLowerCase()}`, accountId: null, username, avatarColor: '#123456' });
export const account = (accountId: string, username: string): PlayerIdentity => ({ key: `acc:${accountId}`, accountId, username, avatarColor: '#654321' });

export function makeService(overrides: Partial<SweepersServiceOptions> = {}) {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler();
  const store = new MemoryStore();
  const events = new RecordingEvents();
  const service = new SweepersService({
    store, events, clock, scheduler: scheduler.schedule, logger: new Logger({ minLevel: 'error', sink: () => undefined }), ...overrides
  });
  return { service, clock, scheduler, store, events };
}
