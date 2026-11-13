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
import { parsePlayerInput, parseRoomRequest } from './payloads.ts';
import { SWEEPERS_EVENTS } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';
/** `miskolc:join_room` per socket: 2/s, burst 3. */
const ROOM_REQUESTS_PER_SECOND = 2;
const ROOM_REQUEST_BURST = 3;

/** `miskolc:join_room`, `miskolc:leave_room`, `miskolc:player_input` and the disconnect. */
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

  constructor(
    service: SweepersService, users: UserRegistry, voiceChannels: readonly VoiceChannel[], logger: Logger,
    inputLimit: InputRateLimiter = new InputRateLimiter(),
    roomLimit: InputRateLimiter = new InputRateLimiter(ROOM_REQUESTS_PER_SECOND, ROOM_REQUEST_BURST)
  ) {
    super(logger);
    this.#service = service;
    this.#users = users;
    this.#inputLimit = inputLimit;
    this.#roomLimit = roomLimit;
    this.#channels = new Set(voiceChannels.map((c) => c.id));
  }

  register(socket: Socket): void {
    this.listen(socket, SWEEPERS_EVENTS.joinRoom, (payload) => {
      if (!this.#roomLimit.take(socket.id)) throw new SweepersError(SWEEPERS_ERRORS.tooManyRequests, undefined, SweepersError.RATE_LIMITED_CODE);
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

    socket.on('disconnect', () => {
      this.#inputLimit.forget(socket.id);
      this.#roomLimit.forget(socket.id);
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
