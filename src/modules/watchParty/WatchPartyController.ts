import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import type { WatchPartyService } from './WatchPartyService.ts';
import type { LiveWatchState } from './types.ts';

const FALLBACK_USERNAME = 'Felhasználó';
const DEFAULT_REACTION = '🍿';
const MAX_REACTION_LENGTH = 8;

/** Socket events of legacy watchPartyHandler.js (`watch:*`). Only channel members may act. */
export class WatchPartyController extends SocketController {
  readonly #io: Server;
  readonly #users: UserRegistry;
  readonly #watch: WatchPartyService;
  readonly #random: () => number;

  /** @param logger scoped `WatchParty` so console lines match legacy */
  constructor(io: Server, users: UserRegistry, watch: WatchPartyService, logger: Logger, random: () => number = Math.random) {
    super(logger);
    this.#io = io;
    this.#users = users;
    this.#watch = watch;
    this.#random = random;
  }

  register(socket: Socket): void {
    this.listen(socket, 'watch:update-media', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields && this.#memberChannel(socket, fields['channelId']);
      if (!fields || !channelId) return;
      const state = this.#watch.start(channelId, this.#username(socket), {
        url: fields['url'], videoId: fields['videoId'], title: fields['title']
      });
      if (!state) return;
      this.#broadcast(channelId, state);
      this.logger.info(`Videó indítva a(z) ${channelId} szobában (${state.startedBy}): ${state.videoId}`);
    });

    this.listen(socket, 'watch:playback-control', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields && this.#memberChannel(socket, fields['channelId']);
      if (!fields || !channelId) return;
      const result = this.#watch.control(channelId, fields['action'], fields['currentTime'], this.#username(socket));
      if (!result) return;
      socket.to(channelId).emit('watch:sync-event', result.sync);
      this.#io.emit('watch:session-updated', { channelId, state: result.state });
    });

    this.listen(socket, 'watch:get-state', (payload) => {
      const fields = legacyDefaultedFields(payload);
      if (!fields || !fields['channelId']) return;
      socket.emit('watch:state', this.#watch.getSession(fields['channelId']));
    });

    this.listen(socket, 'watch:countdown', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields && this.#memberChannel(socket, fields['channelId']);
      if (!channelId) return;
      this.#io.to(channelId).emit('watch:countdown-start', { timestamp: this.#watch.countdownTarget(), triggeredBy: this.#username(socket) });
    });

    this.listen(socket, 'watch:reaction', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields && this.#memberChannel(socket, fields['channelId']);
      if (!fields || !channelId) return;
      this.#io.to(channelId).emit('watch:reaction-received', {
        emoji: String(fields['emoji'] || DEFAULT_REACTION).slice(0, MAX_REACTION_LENGTH),
        username: this.#username(socket),
        id: this.#random().toString(36).substring(2, 9)
      });
    });

    this.listen(socket, 'watch:stop', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields && this.#memberChannel(socket, fields['channelId']);
      if (!channelId) return;
      this.#watch.stop(channelId);
      this.#io.to(channelId).emit('watch:state', null);
      this.#io.emit('watch:session-updated', { channelId, state: null });
      this.logger.info(`Leállítva a(z) ${channelId} szobában`);
    });
  }

  /** Room state to the channel, session snapshot to everyone. */
  #broadcast(channelId: string, state: LiveWatchState): void {
    this.#io.to(channelId).emit('watch:state', state);
    this.#io.emit('watch:session-updated', { channelId, state });
  }

  /** `channelId` when it is non-empty and the caller is in that voice channel, else null. */
  #memberChannel(socket: Socket, channelId: unknown): string | null {
    const user = this.#users.get(socket.id);
    return typeof channelId === 'string' && channelId && user?.voiceChannel === channelId ? channelId : null;
  }

  #username(socket: Socket): string {
    return this.#users.get(socket.id)?.username || FALLBACK_USERNAME;
  }
}
