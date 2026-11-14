import type { Socket } from 'socket.io';
import type { VoiceChannel } from '../../config/channels.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import { InputRateLimiter } from './InputRateLimiter.ts';
import { sweepersRoomOf } from './SweepersBroadcaster.ts';
import { SWEEPERS_ERRORS, SweepersError } from './SweepersError.ts';
import type { PlayerIdentity } from './SweepersPlayer.ts';
import type { SweepersService } from './SweepersService.ts';
import {
  parseBuyUpgrade, parseChannel, parseDeleteStructure, parseLogisticsAction, parsePlaceStructure, parsePlayerAction, parsePlayerInput,
  parseRoomRequest, parseSweepHit, parseTieBag
} from './payloads.ts';
import { SWEEPERS_EVENTS } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';
/** `miskolc:join_room` per socket: 2/s, burst 3. */
const ROOM_REQUESTS_PER_SECOND = 2;
const ROOM_REQUEST_BURST = 3;
/** `miskolc:sweep_hit`: 8/s, burst 8. `miskolc:player_action`: 5/s, burst 5. `miskolc:buy_upgrade`: 2/s, burst 3. */
const SWEEP_RATE = 8;
const ACTION_RATE = 5;
const BUY_RATE = 2;
const BUY_BURST = 3;
/** Phase D: `tie_bag` 2/s burst 2; place + delete share 4/s burst 6; `logistics_action` 4/s burst 4. */
const TIE_RATE = 2;
const BUILD_RATE = 4;
const BUILD_BURST = 6;
const LOGISTICS_RATE = 4;

const rateLimited = (): SweepersError => new SweepersError(SWEEPERS_ERRORS.tooManyRequests, undefined, SweepersError.RATE_LIMITED_CODE);

/** Phase C/D rate limiters (injectable for tests). */
export interface SweepersLimits {
  sweep: InputRateLimiter;
  action: InputRateLimiter;
  buy: InputRateLimiter;
  tie: InputRateLimiter;
  build: InputRateLimiter;
  logistics: InputRateLimiter;
}

/** `miskolc:join_room`, `leave_room`, `player_input`, `sweep_hit`, `player_action`, `buy_upgrade`, the Phase D events and the disconnect. */
export class SweepersController extends SocketController {
  readonly #service: SweepersService;
  readonly #users: UserRegistry;
  readonly #channels: ReadonlySet<string>;
  readonly #inputLimit: InputRateLimiter;
  /**
   * Joins only: every join re-sends the ~115 kB init_state. Leave is never limited (it sends no
   * init_state, and a refused leave would leave a ghost player); join/leave cycling is bounded here.
   */
  readonly #roomLimit: InputRateLimiter;
  readonly #sweepLimit: InputRateLimiter;
  readonly #actionLimit: InputRateLimiter;
  readonly #buyLimit: InputRateLimiter;
  readonly #tieLimit: InputRateLimiter;
  readonly #buildLimit: InputRateLimiter;
  readonly #logisticsLimit: InputRateLimiter;

  constructor(
    service: SweepersService, users: UserRegistry, voiceChannels: readonly VoiceChannel[], logger: Logger,
    inputLimit: InputRateLimiter = new InputRateLimiter(),
    roomLimit: InputRateLimiter = new InputRateLimiter(ROOM_REQUESTS_PER_SECOND, ROOM_REQUEST_BURST),
    limits: Partial<SweepersLimits> = {}
  ) {
    super(logger);
    this.#service = service;
    this.#users = users;
    this.#inputLimit = inputLimit;
    this.#roomLimit = roomLimit;
    this.#sweepLimit = limits.sweep ?? new InputRateLimiter(SWEEP_RATE, SWEEP_RATE);
    this.#actionLimit = limits.action ?? new InputRateLimiter(ACTION_RATE, ACTION_RATE);
    this.#buyLimit = limits.buy ?? new InputRateLimiter(BUY_RATE, BUY_BURST);
    this.#tieLimit = limits.tie ?? new InputRateLimiter(TIE_RATE, TIE_RATE);
    this.#buildLimit = limits.build ?? new InputRateLimiter(BUILD_RATE, BUILD_BURST);
    this.#logisticsLimit = limits.logistics ?? new InputRateLimiter(LOGISTICS_RATE, LOGISTICS_RATE);
    this.#channels = new Set(voiceChannels.map((c) => c.id));
  }

  register(socket: Socket): void {
    this.listen(socket, SWEEPERS_EVENTS.joinRoom, (payload) => {
      if (!this.#roomLimit.take(socket.id)) throw rateLimited();
      const { channelId } = parseRoomRequest(payload);
      if (!this.#channels.has(channelId)) throw new SweepersError(SWEEPERS_ERRORS.unknownChannel, { channelId });
      const identity = this.#identity(socket.id);
      // Join the socket.io room first, so the player_joined / tick broadcasts that follow reach it.
      void socket.join(sweepersRoomOf(channelId));
      const { leftChannelId } = this.#service.join(channelId, socket.id, identity);
      if (leftChannelId !== null) void socket.leave(sweepersRoomOf(leftChannelId));
      return { ok: true };
    });

    this.listen(socket, SWEEPERS_EVENTS.leaveRoom, (payload) => {
      const { channelId } = parseRoomRequest(payload);
      const left = this.#service.leave(socket.id, channelId);
      void socket.leave(sweepersRoomOf(channelId));
      return { ok: left !== null };
    });

    this.listen(socket, SWEEPERS_EVENTS.playerInput, (payload) => {
      // Over 30 inputs/s (burst 10): dropped silently, no ack, no log.
      if (!this.#inputLimit.take(socket.id)) return undefined;
      this.#service.input(socket.id, parsePlayerInput(payload));
      // Acked so the client can measure round-trip time (F3 debug overlay, spec 14).
      return { ok: true };
    });

    this.listen(socket, SWEEPERS_EVENTS.sweepHit, (payload) => {
      const hit = parseSweepHit(payload);
      // The room is checked first (C.4 order: room, bucket, ...).
      this.#service.assertInRoom(socket.id, hit.channelId);
      if (!this.#sweepLimit.take(socket.id)) throw rateLimited();
      return this.#service.sweepHit(socket.id, hit);
    });

    this.listen(socket, SWEEPERS_EVENTS.playerAction, (payload) => {
      if (!this.#actionLimit.take(socket.id)) throw rateLimited();
      const hopperKg = this.#service.playerAction(socket.id, parsePlayerAction(payload));
      return hopperKg === null ? { ok: true } : { ok: true, hopperKg };
    });

    // Phase D: room → bucket → guard → rules (D.4 order).
    const limited = (limiter: InputRateLimiter, payload: unknown): void => {
      this.#service.assertInRoom(socket.id, parseChannel(payload));
      if (!limiter.take(socket.id)) throw rateLimited();
    };

    this.listen(socket, SWEEPERS_EVENTS.tieBag, (payload) => {
      limited(this.#tieLimit, payload);
      const { channelId, tier } = parseTieBag(payload);
      return this.#service.tieBag(socket.id, channelId, tier);
    });

    this.listen(socket, SWEEPERS_EVENTS.placeStructure, (payload) => {
      limited(this.#buildLimit, payload);
      return { ok: true, id: this.#service.placeStructure(socket.id, parsePlaceStructure(payload)) };
    });

    this.listen(socket, SWEEPERS_EVENTS.deleteStructure, (payload) => {
      limited(this.#buildLimit, payload);
      const { channelId, id } = parseDeleteStructure(payload);
      this.#service.deleteStructure(socket.id, channelId, id);
      return { ok: true };
    });

    this.listen(socket, SWEEPERS_EVENTS.logisticsAction, (payload) => {
      limited(this.#logisticsLimit, payload);
      return this.#service.logisticsAction(socket.id, parseLogisticsAction(payload));
    });

    this.listen(socket, SWEEPERS_EVENTS.buyUpgrade, (payload) => {
      if (!this.#buyLimit.take(socket.id)) throw rateLimited();
      return { ok: true, ...this.#service.buyUpgrade(socket.id, parseBuyUpgrade(payload)) };
    });

    socket.on('disconnect', () => {
      this.#inputLimit.forget(socket.id);
      this.#roomLimit.forget(socket.id);
      this.#sweepLimit.forget(socket.id);
      this.#actionLimit.forget(socket.id);
      this.#buyLimit.forget(socket.id);
      this.#tieLimit.forget(socket.id);
      this.#buildLimit.forget(socket.id);
      this.#logisticsLimit.forget(socket.id);
      this.#service.disconnect(socket.id);
    });
  }

  /**
   * Identity from the presence registry. The reconnection key is the account only for an
   * authenticated session (a guest `user:join` may claim any accountId), else the username.
   */
  #identity(socketId: string): PlayerIdentity {
    const user = this.#users.get(socketId);
    if (!user || !user.username) throw new SweepersError(SWEEPERS_ERRORS.notLoggedIn);
    const accountId = verifiedAccountId(user);
    return {
      key: accountId !== null ? `acc:${accountId}` : `name:${user.username.toLowerCase()}`,
      accountId,
      username: user.username,
      avatarColor: user.avatarColor || DEFAULT_AVATAR_COLOR
    };
  }
}

/** The user's accountId when the session was authenticated (login / token), else null. */
export function verifiedAccountId(user: Pick<PresenceUser, 'accountId' | 'authenticated'>): string | null {
  return user.authenticated === true && user.accountId ? user.accountId : null;
}
