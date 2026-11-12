import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import type { WhiteboardService } from './WhiteboardService.ts';
import type { Board } from './types.ts';

/** Socket events of legacy whiteboardHandler.js (`whiteboard:create|get|draw|clear|delete`). */
export class WhiteboardController extends SocketController {
  readonly #io: Server;
  readonly #users: UserRegistry;
  readonly #boards: WhiteboardService;

  /** @param logger scoped `Whiteboard` so console lines match legacy */
  constructor(io: Server, users: UserRegistry, boards: WhiteboardService, logger: Logger) {
    super(logger);
    this.#io = io;
    this.#users = users;
    this.#boards = boards;
  }

  register(socket: Socket): void {
    this.listen(socket, 'whiteboard:create', (payload) => { this.#onCreate(socket, payload); });
    this.listen(socket, 'whiteboard:get', (payload) => { this.#onGet(socket, payload); });
    this.listen(socket, 'whiteboard:draw', (payload) => { this.#onDraw(socket, payload); });
    this.listen(socket, 'whiteboard:clear', (payload) => { this.#onClear(socket, payload); });
    this.listen(socket, 'whiteboard:delete', (payload) => { this.#onDelete(socket, payload); });
  }

  #onCreate(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return;
    const user = this.#users.get(socket.id);
    const board = this.#boards.create(user, fields['channelId'], fields['title']);
    if (!user || !board || typeof fields['channelId'] !== 'string') return;
    const channelId = fields['channelId'];
    this.#io.to(channelId).emit('whiteboard:list', this.#boards.getBoardList(channelId));
    this.#io.to(channelId).emit('whiteboard:created', { board });
    this.logger.info(`Új tábla a(z) ${channelId} szobában: "${board.title}" (${user.username})`);
  }

  #onGet(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const board = fields ? this.#boards.find(fields['channelId'], fields['boardId']) : undefined;
    if (board) socket.emit('whiteboard:data', { boardId: board.id, title: board.title, strokes: board.strokes });
  }

  #onDraw(socket: Socket, payload: unknown): void {
    const target = this.#editable(socket, payload);
    if (!target) return;
    const stroke = target.fields['stroke'];
    this.#boards.draw(target.board, stroke);
    socket.to(target.channelId).emit('whiteboard:stroke', {
      boardId: target.board.id,
      stroke,
      senderId: socket.id,
      senderName: target.user.username
    });
  }

  #onClear(socket: Socket, payload: unknown): void {
    const target = this.#editable(socket, payload);
    if (!target) return;
    this.#boards.clear(target.board);
    this.#io.to(target.channelId).emit('whiteboard:cleared', { boardId: target.board.id, clearedBy: target.user.username });
    this.logger.info(`Tábla letisztítva: ${target.board.id} (${target.user.username})`);
  }

  #onDelete(socket: Socket, payload: unknown): void {
    const target = this.#editable(socket, payload);
    if (!target) return;
    const { channelId, board, user } = target;
    this.#boards.delete(channelId, board.id);
    this.#io.to(channelId).emit('whiteboard:deleted', { boardId: board.id });
    this.#io.to(channelId).emit('whiteboard:list', this.#boards.getBoardList(channelId));
    this.logger.info(`Tábla törölve: ${board.id} (${user.username})`);
  }

  /** Board addressed by the payload, when the caller is in its channel. */
  #editable(socket: Socket, payload: unknown): EditTarget | null {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return null;
    const user = this.#users.get(socket.id);
    const channelId = fields['channelId'];
    const board = this.#boards.findEditable(user, channelId, fields['boardId']);
    if (!user || !board || typeof channelId !== 'string') return null;
    return { fields, user, board, channelId };
  }
}

/** A board the calling user may modify, with the payload it was addressed by. */
interface EditTarget {
  fields: Readonly<Record<string, unknown>>;
  user: PresenceUser;
  board: Board;
  channelId: string;
}
