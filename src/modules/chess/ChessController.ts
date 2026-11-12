import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { UserRegistry } from '../presence/UserRegistry.ts';
import { legacyFields } from '../shared/legacyPayload.ts';
import type { ChessBroadcaster } from './ChessBroadcaster.ts';
import { ChessError } from './ChessError.ts';
import type { ChessService } from './ChessService.ts';
import type { ChessPlayer } from './types.ts';

const FALLBACK_NAME = 'Játékos';

/**
 * Socket events of legacy chessHandler.js (`chess:start|join|move|resign|rematch|stop`).
 * Those handlers had no payload default, so a missing payload is rejected (nothing happens).
 */
export class ChessController extends SocketController {
  readonly #broadcaster: ChessBroadcaster;
  readonly #users: UserRegistry;
  readonly #chess: ChessService;
  readonly #log: Logger;

  /** @param logger root logger: legacy logged `[Chess] ...` lines and an unprefixed `[Chess Move Hiba]:` */
  constructor(broadcaster: ChessBroadcaster, users: UserRegistry, chess: ChessService, logger: Logger) {
    super(logger);
    this.#broadcaster = broadcaster;
    this.#users = users;
    this.#chess = chess;
    this.#log = logger.child('Chess');
  }

  register(socket: Socket): void {
    this.listen(socket, 'chess:start', (payload) => {
      const fields = legacyFields(payload);
      const channelId = fields['channelId'];
      if (typeof channelId !== 'string' || !channelId) return;
      const preference = fields['colorPreference'] === undefined ? 'white' : fields['colorPreference'];
      const player = this.#player(socket, '#7655F5');
      if (this.#chess.start(channelId, player, preference)) {
        this.#log.info(`Új sakk parti indítva a(z) ${channelId} szobában (${player.username})`);
      }
      this.#update(channelId);
    });

    this.listen(socket, 'chess:join', (payload) => {
      const session = this.#chess.get(legacyFields(payload)['channelId']);
      if (!session) return;
      const player = this.#player(socket, '#536CFF');
      if (this.#chess.join(session, player)) {
        this.#log.info(`${player.username} csatlakozott a sakkhoz a(z) ${session.channelId} szobában`);
      }
      this.#update(session.channelId);
    });

    this.listen(socket, 'chess:move', (payload) => {
      const fields = legacyFields(payload);
      const session = this.#chess.get(fields['channelId']);
      const promotion = fields['promotion'] === undefined ? 'q' : fields['promotion'];
      try {
        this.#chess.move(session, socket.id, fields['from'], fields['to'], promotion);
      } catch (err) {
        if (err instanceof ChessError) {
          socket.emit('chess:error', { message: err.message });
          return;
        }
        this.logger.error('[Chess Move Hiba]:', err);
        socket.emit('chess:error', { message: 'Nem sikerült a lépés: ' + (err instanceof Error ? err.message : String(err)) });
        return;
      }
      if (session) this.#update(session.channelId);
    });

    this.listen(socket, 'chess:resign', (payload) => {
      const session = this.#chess.get(legacyFields(payload)['channelId']);
      if (!session || !this.#chess.resign(session, socket.id)) return;
      this.#log.info(`Feladás a(z) ${session.channelId} szobában, nyertes: ${session.winner ?? ''}`);
      this.#update(session.channelId);
    });

    this.listen(socket, 'chess:rematch', (payload) => {
      const session = this.#chess.get(legacyFields(payload)['channelId']);
      if (!session) return;
      this.#chess.rematch(session);
      this.#log.info(`Új mérkőzés indítva a(z) ${session.channelId} szobában (${this.#users.get(socket.id)?.username})`);
      this.#update(session.channelId);
    });

    this.listen(socket, 'chess:stop', (payload) => {
      const fields = legacyFields(payload);
      const channelId = fields['channelId'];
      if (typeof channelId !== 'string' || !channelId) return;
      this.#chess.stop(channelId);
      this.#broadcaster.sessionUpdated(channelId, null);
      this.#log.info(`Sakk parti leállítva a(z) ${channelId} szobában`);
    });

    socket.on('disconnect', () => {
      for (const { channelId, closed } of this.#chess.leave(socket.id)) {
        if (closed) this.#broadcaster.sessionClosed(channelId);
        else this.#update(channelId);
      }
    });
  }

  #update(channelId: string): void {
    this.#broadcaster.sessionUpdated(channelId, this.#chess.snapshotOf(channelId));
  }

  #player(socket: Socket, defaultColor: string): ChessPlayer {
    const user = this.#users.get(socket.id);
    return { id: socket.id, username: user?.username || FALLBACK_NAME, avatarColor: user?.avatarColor || defaultColor };
  }
}
