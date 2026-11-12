import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import type { ChatService } from './ChatService.ts';

/** `chat:message` -> persist -> `chat:new-message` to everyone (legacy chatHandler.js). */
export class ChatController extends SocketController {
  readonly #io: Server;
  readonly #users: UserRegistry;
  readonly #chat: ChatService;

  constructor(io: Server, users: UserRegistry, chat: ChatService, logger: Logger) {
    super(logger);
    this.#io = io;
    this.#users = users;
    this.#chat = chat;
  }

  register(socket: Socket): void {
    this.listen(socket, 'chat:message', (payload) => { this.#onMessage(socket, payload); });
  }

  #onMessage(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const user = this.#users.get(socket.id);
    if (!fields || !user) return;
    const { channelId, text, attachments } = fields;
    // Legacy saved with any channelId; a missing one failed in SQLite before broadcasting.
    // The frontend always sends a string id, so anything else is ignored.
    if (typeof channelId !== 'string') return;
    const message = this.#chat.post(user, { channelId, text, attachments });
    if (message) this.#io.emit('chat:new-message', message);
  }
}
