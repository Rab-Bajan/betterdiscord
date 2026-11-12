import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import { PayloadReader } from '../../core/validation/PayloadReader.ts';
import { legacyFields } from '../shared/legacyPayload.ts';
import { DmService } from './DmService.ts';
import type { DmApi, DmReportAck, DmTarget } from './types.ts';

/** A connected socket that can receive events. */
export interface DmEmitTarget {
  readonly id: string;
  emit(event: string, ...args: unknown[]): unknown;
}

/** The socket.io surface the dm module uses (a real `Server` satisfies it). */
export interface DmIo {
  /** `io.sockets.sockets`: connected sockets by id. */
  readonly sockets: { readonly sockets: { get(id: string): DmEmitTarget | undefined } };
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
}

/**
 * Socket events of legacy dmHandler.js: dm:report-message (acked), dm:get-conversations,
 * dm:get-history and dm:send-message. Delivery goes only to the sender and the recipient.
 */
export class DmController extends SocketController {
  readonly #service: DmService;
  readonly #io: DmIo;

  constructor(service: DmService, io: DmIo, logger: Logger) {
    super(logger);
    this.#service = service;
    this.#io = io;
  }

  /** The legacy dmHandler return value, consumed by the admin module. */
  get api(): DmApi {
    return {
      getDmKey: (a, b) => DmService.getDmKey(a, b),
      notifyMessageRemoved: (dmKey, messageId) => this.notifyMessageRemoved(dmKey, messageId)
    };
  }

  /** Tells every online participant of `dmKey` that `messageId` was removed by an admin. */
  notifyMessageRemoved(dmKey: string, messageId: string): void {
    for (const socketId of this.#service.participantSocketIds(dmKey)) {
      this.#io.to(socketId).emit('dm:message-removed', { id: messageId, dmKey });
    }
  }

  register(socket: Socket): void {
    const service = this.#service;

    // Legacy `({ messageId, reason } = {}, ack)`: only `undefined` defaults to {}; null is rejected.
    this.listen(socket, 'dm:report-message', (payload): DmReportAck => {
      const fields = legacyFields(payload === undefined ? {} : payload);
      return service.reportMessage(socket.id, fields['messageId'], fields['reason']);
    });

    this.listen(socket, 'dm:get-conversations', () => {
      const conversations = service.getConversations(socket.id);
      if (conversations) socket.emit('dm:conversations', conversations);
    });

    this.listen(socket, 'dm:get-history', (payload) => {
      const history = service.getHistory(socket.id, readTarget(new PayloadReader(legacyFields(payload))));
      if (history) socket.emit('dm:history', history);
    });

    this.listen(socket, 'dm:send-message', (payload) => {
      const fields = legacyFields(payload);
      const delivery = service.send(socket.id, {
        ...readTarget(new PayloadReader(fields)),
        text: fields['text'],
        attachments: fields['attachments']
      });
      if (!delivery) return;
      socket.emit('dm:new-message', delivery.message);
      const recipientSocket = delivery.recipientSocketId === null ? undefined : this.#io.sockets.sockets.get(delivery.recipientSocketId);
      if (recipientSocket && recipientSocket.id !== socket.id) {
        recipientSocket.emit('dm:new-message', delivery.message);
      }
    });
  }
}

/** Target fields: strings, `''` kept (legacy `targetUserId || targetUsername` fallthrough and echo). */
function readTarget(r: PayloadReader): DmTarget {
  return {
    targetUserId: r.optionalString('targetUserId', { allowEmpty: true }),
    targetUsername: r.optionalString('targetUsername', { allowEmpty: true })
  };
}
