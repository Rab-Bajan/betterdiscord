import type { Server } from 'socket.io';
import { SWEEPERS_EVENTS } from './types.ts';
import type { ClockSync } from './dayClock.ts';
import type { PersonalStatePayload } from './debris/personal.ts';
import type { EconomyUpdate, InspectionPayload } from './economy/Economy.ts';
import type { LogisticsTelemetry, LogisticsUpdate } from './logistics/LogisticsWorld.ts';
import type {
  DebrisChunkUpdate, DistrictUnlockedPayload, InitStatePayload, PlayerSnapshot, ScaleWeighedPayload, StructureSpawnedPayload,
  SweepersKickedPayload, SweepersSessionSummary, SweepersSessionUpdate, TickSyncPayload
} from './types.ts';
import type { VehicleUpdate } from './vehicles/VehicleWorld.ts';
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
  /** `miskolc:debris_chunk_update` to one socket (its interest loads plus the room-wide deltas). */
  debrisUpdate(socketId: string, payload: DebrisChunkUpdate): void;
  /** `miskolc:personal_update` to the owning socket. */
  personalUpdate(socketId: string, payload: PersonalStatePayload): void;
  /** `miskolc:structure_spawned` to the world, at once on a place. */
  structureSpawned(channelId: string, payload: StructureSpawnedPayload): void;
  /** `miskolc:logistics_update` to the world, at most once per tick. */
  logisticsUpdate(channelId: string, payload: LogisticsUpdate): void;
  /** `miskolc:logistics_telemetry` to one subscribed socket (1 Hz). */
  logisticsTelemetry(socketId: string, payload: LogisticsTelemetry): void;
  /** `miskolc:scale_weighed` to the world (Phase E). */
  scaleWeighed(channelId: string, payload: ScaleWeighedPayload): void;
  /** `miskolc:inspection` to the world. */
  inspection(channelId: string, payload: InspectionPayload): void;
  /** `miskolc:economy` to the world, at most once per tick. */
  economy(channelId: string, payload: EconomyUpdate): void;
  /** `miskolc:vehicle_update` to the world, at most once per tick (Phase F). */
  vehicleUpdate(channelId: string, payload: VehicleUpdate): void;
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

  debrisUpdate(socketId: string, payload: DebrisChunkUpdate): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.debrisChunkUpdate, payload);
  }

  personalUpdate(socketId: string, payload: PersonalStatePayload): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.personalUpdate, payload);
  }

  structureSpawned(channelId: string, payload: StructureSpawnedPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.structureSpawned, payload);
  }

  logisticsUpdate(channelId: string, payload: LogisticsUpdate): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.logisticsUpdate, payload);
  }

  logisticsTelemetry(socketId: string, payload: LogisticsTelemetry): void {
    this.#io.to(socketId).emit(SWEEPERS_EVENTS.logisticsTelemetry, payload);
  }

  scaleWeighed(channelId: string, payload: ScaleWeighedPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.scaleWeighed, payload);
  }

  inspection(channelId: string, payload: InspectionPayload): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.inspection, payload);
  }

  economy(channelId: string, payload: EconomyUpdate): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.economy, payload);
  }

  vehicleUpdate(channelId: string, payload: VehicleUpdate): void {
    this.#io.to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.vehicleUpdate, payload);
  }

  /** To the voice channel and the world's players (as phobia does), not the whole server. */
  sessionUpdated(channelId: string, state: SweepersSessionSummary | null): void {
    const update: SweepersSessionUpdate = { channelId, state };
    this.#io.to(channelId).to(sweepersRoomOf(channelId)).emit(SWEEPERS_EVENTS.sessionUpdated, update);
  }
}
