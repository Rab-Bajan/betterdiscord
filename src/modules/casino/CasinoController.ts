import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController, type HandlerContext } from '../../core/socket/SocketController.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import { CasinoError } from './CasinoError.ts';
import type { CasinoService } from './CasinoService.ts';
import type { CasinoAccount } from './types.ts';

const UNEXPECTED_ERROR = 'A játék művelete sikertelen.';
const FALLBACK_USERNAME = 'Felhasználó';

type WalletAction = (wallet: { playerId: string; account: CasinoAccount }, fields: Readonly<Record<string, unknown>>) => object;

const lobbyRoom = (channelId: string): string => `casino:${channelId}`;

/**
 * Socket events of legacy casinoHandler.js: voice-channel sessions (`casino:start|stop-session`),
 * the 3D lobby (`lobby:join`, `player:move`, `chat:send`) and the games. Acked actions reply
 * `{ ok: true, ...result }` or `{ ok: false, error }`, and do nothing at all without an ack.
 */
export class CasinoController extends SocketController {
  readonly #io: Server;
  readonly #casino: CasinoService;
  readonly #sessionLog: Logger;

  /** @param logger root logger: legacy logged failures unprefixed and session lines as `[Casino]` */
  constructor(io: Server, casino: CasinoService, logger: Logger) {
    super(logger);
    this.#io = io;
    this.#casino = casino;
    this.#sessionLog = logger.child('Casino');
  }

  register(socket: Socket): void {
    this.listen(socket, 'casino:start-session', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields?.['channelId'];
      if (!fields || typeof channelId !== 'string' || !channelId) return;
      const username = fields['username'];
      const session = this.#casino.startSession(channelId, typeof username === 'string' && username ? username : FALLBACK_USERNAME);
      this.#io.emit('casino:session-updated', { channelId, session });
      this.#sessionLog.info(`Új kaszinó indítva a(z) ${channelId} szobában (${session.startedBy})`);
    });

    this.listen(socket, 'casino:stop-session', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields?.['channelId'];
      if (!fields || typeof channelId !== 'string' || !channelId) return;
      this.#casino.stopSession(channelId);
      this.#io.emit('casino:session-updated', { channelId, session: null });
      this.#sessionLog.info(`Kaszinó leállítva a(z) ${channelId} szobában`);
    });

    this.listen(socket, 'lobby:join', (payload, ctx) => this.#respond(ctx, () => this.#join(socket, payload)));

    this.listen(socket, 'player:move', (payload) => {
      const moved = this.#casino.move(socket.id, payload);
      const player = this.#casino.player(socket.id);
      if (moved && player) socket.to(lobbyRoom(player.channelId)).emit('player:moved', moved);
    });

    this.listen(socket, 'chat:send', (text, ctx) => this.#respond(ctx, () => {
      const { player, message } = this.#casino.chat(socket.id, text);
      this.#io.to(lobbyRoom(player.channelId)).emit('chat:message', message);
      return {};
    }));

    this.#game(socket, 'casino:slot', ({ account }, f) => this.#casino.slot(account, f['bet']));
    this.#game(socket, 'blackjack:start', ({ playerId, account }, f) => this.#casino.blackjackStart(playerId, account, f['bet']));
    this.#game(socket, 'blackjack:hit', ({ playerId, account }) => this.#casino.blackjackHit(playerId, account));
    this.#game(socket, 'blackjack:stand', ({ playerId, account }) => this.#casino.blackjackStand(playerId, account));
    this.#game(socket, 'poker:deal', ({ playerId, account }, f) => this.#casino.pokerDeal(playerId, account, f['bet']));
    this.#game(socket, 'poker:draw', ({ playerId, account }, f) => this.#casino.pokerDraw(playerId, account, f['held']));

    socket.on('disconnect', () => {
      const channelId = this.#casino.leave(socket.id);
      if (channelId !== null) this.#sendLobbySnapshot(channelId);
    });
  }

  #join(socket: Socket, payload: unknown): object {
    const fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const { player, account, others } = this.#casino.join(socket.id, fields['id'], fields['name'], fields['channelId']);
    void socket.join(lobbyRoom(player.channelId));
    socket.emit('lobby:players', others);
    socket.emit('wallet:balance', { balance: account.balance, freeSpins: account.freeSpins });
    this.#sendLobbySnapshot(player.channelId);
    return { id: socket.id, name: player.name, x: player.x, z: player.z, balance: account.balance, freeSpins: account.freeSpins };
  }

  /** A game action of a joined player; a missing payload reads as `{}`. */
  #game(socket: Socket, event: string, action: WalletAction): void {
    this.listen(socket, event, (payload, ctx) => this.#respond(ctx, () => {
      const wallet = this.#casino.walletOf(socket.id);
      return action(wallet, legacyDefaultedFields(payload) ?? {});
    }));
  }

  #sendLobbySnapshot(channelId: string): void {
    this.#io.to(lobbyRoom(channelId)).emit('lobby:players', this.#casino.lobbySnapshot(channelId));
    this.#io.to(lobbyRoom(channelId)).emit('lobby:count', this.#casino.lobbyCount(channelId));
  }

  /** Legacy `respond(ack, handler)`: runs only when the client asked for an ack. */
  #respond(ctx: HandlerContext, action: () => object): unknown {
    if (!ctx.ack) return undefined;
    try {
      return { ok: true, ...action() };
    } catch (err) {
      if (err instanceof CasinoError) return { ok: false, error: err.message };
      this.logger.error('Casino action failed:', err);
      return { ok: false, error: UNEXPECTED_ERROR };
    }
  }
}
