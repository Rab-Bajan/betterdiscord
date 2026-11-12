import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceService } from '../presence/PresenceService.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import type { SpeedTestService } from './SpeedTestService.ts';

/** Speed-test ping, result announcement and peer requests (legacy speedTestHandler.js). */
export class SpeedTestController extends SocketController {
  readonly #io: Server;
  readonly #service: SpeedTestService;
  readonly #presence: PresenceService;

  /** @param logger scoped `SpeedTest` so console lines match legacy */
  constructor(io: Server, service: SpeedTestService, presence: PresenceService, logger: Logger) {
    super(logger);
    this.#io = io;
    this.#service = service;
    this.#presence = presence;
  }

  register(socket: Socket): void {
    this.listen(socket, 'speedtest:ping', (payload) => { this.#onPing(socket, payload); });
    this.listen(socket, 'speedtest:save-result', (payload) => { this.#onSave(socket, payload); });
    this.listen(socket, 'speedtest:request-user', (payload) => { this.#onRequest(socket, payload); });
  }

  #onPing(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return;
    socket.emit('speedtest:pong', { clientTime: fields['clientTime'], serverTime: this.#service.serverTime() });
  }

  #onSave(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const user = fields ? this.#service.saveResult(socket.id, fields) : null;
    const result = user?.speedTest;
    if (!user || !result) return;
    this.#presence.broadcastPresence(this.#io);
    this.#io.emit('speedtest:result-announced', {
      userId: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
      result
    });
    this.logger.info(`${user.username}: Ping ${result.ping}ms, DL ${result.download} Mbps, UL ${result.upload} Mbps`);
  }

  #onRequest(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const pair = fields ? this.#service.resolveRequest(socket.id, fields['targetUserId']) : null;
    if (!pair) return;
    this.#io.to(pair.target.id).emit('speedtest:requested-by', {
      requesterId: pair.sender.id,
      requesterName: pair.sender.username
    });
    this.logger.info(`${pair.sender.username} sebességtesztet kért ${pair.target.username}-től`);
  }
}
