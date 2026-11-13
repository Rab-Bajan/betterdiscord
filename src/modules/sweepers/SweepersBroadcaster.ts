import type { Server } from 'socket.io';
import { SWEEPERS_EVENTS } from './types.ts';
import type { ClockSync } from './dayClock.ts';
import type {
  DistrictUnlockedPayload, InitStatePayload, PlayerSnapshot, SweepersKickedPayload, SweepersSessionSummary, SweepersSessionUpdate,
  TickSyncPayload
} from './types.ts';
import type { WeatherPayload } from './weather.ts';

/** Socket.io room of the players of one channel's world. */
export const sweepersRoomOf = (channelId: string): string => `sweepers:${channelId}`;

/** Everything the sweepers service sends. */
export interface SweepersEvents {
  initState(socketId: string, payload: InitStatePayload): void;
  tickSync(channelId: string, payload: TickSyncPayload): void;
  /** To every player of the world except `exceptSocketId`. */
  playerJoined(channelId: string, player: PlayerSnapshot, exceptSocketId: string): void;
  playerLeft(channelId: string, id: number): void;
  sessionUpdated(channelId: string, state: SweepersSessionSummary | null): void;
  /** To a socket whose player was taken over by another socket; it is also removed from the world room. */
  kicked(socketId: string, channelId: string, payload: SweepersKickedPayload): void;
  districtUnlocked(channelId: string, payload: DistrictUnlockedPayload): void;
  /** `miskolc:clock` to the whole world (periodic). */
  clock(channelId: string, payload: ClockSync): void;
  /** `miskolc:clock` to one socket (on join). */
  clockTo(socketId: string, payload: ClockSync): void;
  weather(channelId: string, payload: WeatherPayload): void;
}

/** {@link SweepersEvents} over socket.io. */
export class SweepersBroadcaster implements SweepersEvents {
  readonly #io: Pick<Server, 'to' | 'in'>;

  constructor(io: Pick<Server, 'to' | 'in'>) {
    this.#io = io;
  }

  initState(socketId: string, payload: InitStatePayload): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.initState, payload);
  }

  tickSync(channelId: string, payload: TickSyncPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.tickSync, payload);
  }

  playerJoined(channelId: string, player: PlayerSnapshot, exceptSocketId: string): void {
    this.#io.to(sweepersRoomOf(channelId)).except(exceptSocketId).emit(SWEEPERS_EVENTS.playerJoined, player);
  }

  playerLeft(channelId: string, id: number): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.playerLeft, { id });
  }

  kicked(socketId: string, channelId: string, payload: SweepersKickedPayload): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.kicked, payload);
    this.#io.in(socketId).socketsLeave(sweepersRoomOf(channelId));
  }

  districtUnlocked(channelId: string, payload: DistrictUnlockedPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.districtUnlocked, payload);
  }

  clock(channelId: string, payload: ClockSync): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.clock, payload);
  }

  clockTo(socketId: string, payload: ClockSync): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.clock, payload);
  }

  weather(channelId: string, payload: WeatherPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.weather, payload);
  }

  /** To the voice channel and the world's players (as phobia does), not the whole server. */
  sessionUpdated(channelId: string, state: SweepersSessionSummary | null): void {
    const update: SweepersSessionUpdate = { channelId, state };
    this.#io.to(channelId).to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.sessionUpdated, update);
  }
}
