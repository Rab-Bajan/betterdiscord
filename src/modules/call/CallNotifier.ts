import type { Server } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import type { AccountRepository } from '../../infrastructure/database/repositories/AccountRepository.ts';
import type { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import type { Account } from '../../infrastructure/database/types/models.ts';
import { DmService } from '../dm/DmService.ts';
import type { UserRegistry } from '../presence/UserRegistry.ts';
import { defaultIdSource, type IdSource } from '../shared/legacyId.ts';
import type { CallProfile, CallResult, CallSummary } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

/** Profile fields of an account (or of the caller's session when the account is gone). */
export interface ProfileSource {
  id: string;
  username: string;
  avatarColor: string | null;
  avatarUrl: string | null;
}

export const publicProfile = (acc: ProfileSource): CallProfile => ({
  accountId: acc.id,
  username: acc.username,
  displayName: acc.username,
  avatarColor: acc.avatarColor || DEFAULT_AVATAR_COLOR,
  avatarUrl: acc.avatarUrl || null
});

export interface CallNotifierDeps {
  io: Pick<Server, 'to'>;
  users: UserRegistry;
  accounts: Pick<AccountRepository, 'getAccountById'>;
  messages: Pick<DirectMessageRepository, 'saveDmMessage'>;
  logger: Logger;
  ids?: IdSource;
  timeLabel?: (now: number) => string;
}

/**
 * Delivers call events to every device of an account and records each call's outcome as a
 * DM system message (legacy callHandler.js `socketsOf` / `emitTo` / `postCallMessage`).
 */
export class CallNotifier {
  readonly #io: CallNotifierDeps['io'];
  readonly #users: UserRegistry;
  readonly #accounts: CallNotifierDeps['accounts'];
  readonly #messages: CallNotifierDeps['messages'];
  readonly #logger: Logger;
  readonly #ids: IdSource;
  readonly #timeLabel: (now: number) => string;

  constructor(deps: CallNotifierDeps) {
    this.#io = deps.io;
    this.#users = deps.users;
    this.#accounts = deps.accounts;
    this.#messages = deps.messages;
    this.#logger = deps.logger;
    this.#ids = deps.ids ?? defaultIdSource;
    this.#timeLabel = deps.timeLabel ?? ((now) => new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }

  /** Sockets of every authenticated session of `accountId`, in connection order. */
  socketsOf(accountId: string): string[] {
    const ids: string[] = [];
    for (const [socketId, u] of this.#users.entries()) {
      if (u.authenticated === true && u.accountId === accountId) ids.push(socketId);
    }
    return ids;
  }

  /** Emits to each non-empty socket id. */
  emitTo(socketIds: ReadonlyArray<string | null>, event: string, payload: unknown): void {
    for (const id of socketIds) if (id) this.#io.to(id).emit(event, payload);
  }

  account(accountId: string): Account | null {
    return this.#accounts.getAccountById(accountId);
  }

  /** Stores the outcome as a DM between the two parties and sends it to all their devices. */
  postCallMessage(call: CallSummary, result: CallResult): void {
    const callerAcc = this.#accounts.getAccountById(call.callerAccountId);
    const calleeAcc = this.#accounts.getAccountById(call.calleeAccountId);
    if (!callerAcc || !calleeAcc) return;
    const now = this.#ids.now();
    const callerSockets = this.socketsOf(call.callerAccountId);
    const calleeSockets = this.socketsOf(call.calleeAccountId);
    const callerColor = callerAcc.avatarColor || DEFAULT_AVATAR_COLOR;
    const message = {
      id: `dm_${now}_${this.#ids.random().toString(36).slice(2, 11)}`,
      dmKey: DmService.getDmKey(callerAcc.username, calleeAcc.username),
      username: callerAcc.username,
      senderId: callerSockets[0] || callerAcc.id,
      senderAccountId: callerAcc.id,
      senderUsername: callerAcc.username,
      senderAvatarColor: callerColor,
      senderAvatarUrl: callerAcc.avatarUrl || null,
      recipientId: calleeSockets[0] || calleeAcc.id,
      recipientUsername: calleeAcc.username,
      recipientAvatarColor: calleeAcc.avatarColor || DEFAULT_AVATAR_COLOR,
      recipientAvatarUrl: calleeAcc.avatarUrl || null,
      avatarColor: callerColor,
      avatarUrl: callerAcc.avatarUrl || null,
      text: '',
      attachments: [],
      timestamp: this.#timeLabel(now),
      createdAt: now,
      isPrivate: true,
      callEvent: {
        callId: call.id,
        status: result.status,
        endReason: result.endReason || null,
        durationSec: result.durationSec || 0,
        callerUsername: callerAcc.username,
        calleeUsername: calleeAcc.username
      }
    };
    try {
      this.#messages.saveDmMessage(message);
    } catch (err) {
      this.#logger.error('DM rendszerüzenet mentési hiba:', err instanceof Error ? err.message : err);
      return;
    }
    this.emitTo([...callerSockets, ...calleeSockets], 'dm:new-message', message);
  }
}
