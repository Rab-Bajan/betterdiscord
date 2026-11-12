import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import type { CodeEditorService } from './CodeEditorService.ts';

/** A caller who is in the voice channel the payload names. */
interface Member {
  user: PresenceUser;
  channelId: string;
  fields: Readonly<Record<string, unknown>>;
}

/** Socket events of legacy codeEditorHandler.js (`code:*`). Only channel members may read or edit. */
export class CodeEditorController extends SocketController {
  readonly #io: Server;
  readonly #users: UserRegistry;
  readonly #code: CodeEditorService;

  /** @param logger scoped `CodeEditor` so console lines match legacy */
  constructor(io: Server, users: UserRegistry, code: CodeEditorService, logger: Logger) {
    super(logger);
    this.#io = io;
    this.#users = users;
    this.#code = code;
  }

  register(socket: Socket): void {
    this.listen(socket, 'code:get-tree', (payload) => {
      const member = this.#member(socket, payload);
      if (member) socket.emit('code:tree-data', this.#code.getProject(member.channelId));
    });

    this.listen(socket, 'code:create-node', (payload) => {
      const member = this.#member(socket, payload);
      if (!member) return;
      const { fields, channelId, user } = member;
      const node = this.#code.createNode(channelId, fields['parentId'], fields['name'], fields['type']);
      if (!node) return;
      this.#emitTree(channelId);
      this.logger.info(`Új ${node.type} létrehozva: "${node.name}" (${user.username})`);
    });

    this.listen(socket, 'code:delete-node', (payload) => {
      const member = this.#member(socket, payload);
      if (!member || !this.#code.deleteNode(member.channelId, member.fields['nodeId'])) return;
      this.#emitTree(member.channelId);
      this.logger.info(`Elem törölve: ${String(member.fields['nodeId'])} (${member.user.username})`);
    });

    this.listen(socket, 'code:rename-node', (payload) => {
      const member = this.#member(socket, payload);
      const name = member && this.#code.renameNode(member.channelId, member.fields['nodeId'], member.fields['newName']);
      if (!member || !name) return;
      this.#emitTree(member.channelId);
      this.logger.info(`Elem átnevezve: "${name}" (${member.user.username})`);
    });

    this.listen(socket, 'code:file-change', (payload) => {
      const member = this.#member(socket, payload);
      if (!member) return;
      const { fileId, content } = member.fields;
      if (!this.#code.changeFile(member.channelId, fileId, content)) return;
      socket.to(member.channelId).emit('code:file-updated', { fileId, content, senderName: member.user.username });
    });
  }

  #emitTree(channelId: string): void {
    this.#io.to(channelId).emit('code:tree-data', this.#code.getProject(channelId));
  }

  /** The caller and the payload, when the caller is in the (non-empty) channel it names. */
  #member(socket: Socket, payload: unknown): Member | null {
    const fields = legacyDefaultedFields(payload);
    const user = this.#users.get(socket.id);
    const channelId = fields?.['channelId'];
    if (!fields || !user || typeof channelId !== 'string' || !channelId || user.voiceChannel !== channelId) return null;
    return { user, channelId, fields };
  }
}
