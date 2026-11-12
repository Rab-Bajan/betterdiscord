import type { Logger } from '../../core/logging/Logger.ts';
import type { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import type { DmReportRepository } from '../../infrastructure/database/repositories/DmReportRepository.ts';
import type { Attachment, DmConversation } from '../../infrastructure/database/types/models.ts';
import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import { defaultIdSource, legacyId, type IdSource } from '../shared/legacyId.ts';
import type { DmDelivery, DmHistory, DmReportAck, DmSendInput, DmTarget } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';
const REPORT_REASON_MAX = 300;

/** Client-facing texts of dm:report-message, verbatim from dmHandler.js. */
export const DM_REPORT_ERRORS = Object.freeze({
  notFound: 'Az üzenet nem található.',
  notPartner: 'Csak a beszélgetőpartnered üzenetét jelentheted.',
  alreadyRemoved: 'Ezt az üzenetet már eltávolították.',
  alreadyReported: 'Ezt az üzenetet már jelentetted.'
});

/** Legacy message time label (`HH:MM` in the server locale). */
export const defaultTimeLabel = (): string => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export interface DmServiceDeps {
  users: UserRegistry;
  messages: DirectMessageRepository;
  reports: DmReportRepository;
  logger: Logger;
  ids?: IdSource;
  timeLabel?: () => string;
}

/**
 * Direct-message rules of legacy dmHandler.js. A conversation is identified by the
 * lower-cased, sorted pair of *usernames* (`a::b`).
 *
 * Authorization rules preserved exactly:
 * - every action needs a session on the calling socket; history/conversations are
 *   always those of the caller's own current username;
 * - only a participant of the conversation may report, and only the *other* party's
 *   message, once, and not after an admin removed it.
 */
export class DmService {
  readonly #users: UserRegistry;
  readonly #messages: DirectMessageRepository;
  readonly #reports: DmReportRepository;
  readonly #logger: Logger;
  readonly #ids: IdSource;
  readonly #timeLabel: () => string;

  constructor(deps: DmServiceDeps) {
    this.#users = deps.users;
    this.#messages = deps.messages;
    this.#reports = deps.reports;
    this.#logger = deps.logger;
    this.#ids = deps.ids ?? defaultIdSource;
    this.#timeLabel = deps.timeLabel ?? defaultTimeLabel;
  }

  /** Conversation key of two names/ids: lower-cased (after String()), sorted, joined by `::`. */
  static getDmKey(idA: unknown, idB: unknown): string {
    return [String(idA).toLowerCase(), String(idB).toLowerCase()].sort().join('::');
  }

  /**
   * First online user matching `target` by socket id, user id, account id or
   * case-insensitive username (legacy `findUserObj` / `findSocketByUserIdOrName`).
   */
  findUser(target: string | undefined): [socketId: string, user: PresenceUser] | null {
    if (!target) return null;
    for (const [socketId, u] of this.#users.entries()) {
      if (socketId === target || u.id === target || u.accountId === target || u.username.toLowerCase() === target.toLowerCase()) {
        return [socketId, u];
      }
    }
    return null;
  }

  /** Reports the conversation partner's message `messageId` on behalf of the caller. */
  reportMessage(socketId: string, messageId: unknown, reason: unknown): DmReportAck {
    const me = this.#users.get(socketId);
    const msg = typeof messageId === 'string' ? this.#messages.getDmMessageById(messageId) : null;
    if (!me || !msg) return { ok: false, error: DM_REPORT_ERRORS.notFound };

    const myName = me.username.toLowerCase();
    const isParticipant = msg.dmKey.split('::').includes(myName);
    if (!isParticipant || msg.senderUsername.toLowerCase() === myName) {
      return { ok: false, error: DM_REPORT_ERRORS.notPartner };
    }
    if (msg.removedByAdmin) return { ok: false, error: DM_REPORT_ERRORS.alreadyRemoved };

    const created = this.#reports.createDmReport({
      id: legacyId('rep', 6, this.#ids),
      messageId: msg.id,
      dmKey: msg.dmKey,
      reporterUsername: me.username,
      reason: String(reason || '').trim().slice(0, REPORT_REASON_MAX)
    });
    if (!created) return { ok: false, error: DM_REPORT_ERRORS.alreadyReported };

    this.#logger.info(`[DM Report] ${me.username} jelentette ${msg.senderUsername} üzenetét (${msg.id})`);
    return { ok: true };
  }

  /** The caller's conversation list, or null without a session. */
  getConversations(socketId: string): DmConversation[] | null {
    const self = this.#users.get(socketId);
    if (!self) return null;
    return this.#messages.getUserDmConversations(self.username);
  }

  /** History between the caller and the target, or null (no session / no partner name). */
  getHistory(socketId: string, { targetUserId, targetUsername }: DmTarget): DmHistory | null {
    const self = this.#users.get(socketId);
    if (!self) return null;
    const partner = this.findUser(targetUserId || targetUsername);
    const partnerName = partner ? partner[1].username : targetUsername;
    if (!partnerName) return null;

    const dmKey = DmService.getDmKey(self.username, partnerName);
    return { partnerId: targetUserId, partnerUsername: partnerName, dmKey, messages: this.#messages.getDmMessages(dmKey) };
  }

  /**
   * Stores a DM from the caller and returns what to deliver, or null when nothing happens
   * (no session, empty text without attachments, or no recipient name). The recipient need
   * not be online; offline messages are addressed by the given name.
   */
  send(socketId: string, input: DmSendInput): DmDelivery | null {
    const sender = this.#users.get(socketId);
    if (!sender) return null;

    const cleanText = typeof input.text === 'string' ? input.text.trim() : '';
    const attachments: Attachment[] = Array.isArray(input.attachments) ? input.attachments : [];
    if (!cleanText && attachments.length === 0) return null;

    const match = this.findUser(input.targetUserId || input.targetUsername);
    const recipient = match ? match[1] : null;
    const recipientName = recipient ? recipient.username : input.targetUsername;
    if (!recipientName) return null;

    const dmKey = DmService.getDmKey(sender.username, recipientName);
    const message = {
      id: legacyId('dm', 9, this.#ids),
      dmKey,
      username: sender.username,
      senderId: sender.id,
      senderAccountId: sender.accountId || null,
      senderUsername: sender.username,
      senderAvatarColor: sender.avatarColor || DEFAULT_AVATAR_COLOR,
      senderAvatarUrl: sender.avatarUrl || null,
      recipientId: recipient ? recipient.id : input.targetUserId,
      recipientUsername: recipientName,
      recipientAvatarColor: recipient ? recipient.avatarColor : DEFAULT_AVATAR_COLOR,
      recipientAvatarUrl: recipient ? recipient.avatarUrl : null,
      avatarColor: sender.avatarColor || DEFAULT_AVATAR_COLOR,
      avatarUrl: sender.avatarUrl || null,
      text: cleanText,
      attachments,
      timestamp: this.#timeLabel(),
      createdAt: this.#ids.now(),
      isPrivate: true as const
    };
    this.#messages.saveDmMessage(message);
    this.#logger.info(`[SQLite DM] Privát üzenet elmentve és elküldve: ${sender.username} -> ${recipientName}`);
    return { message, recipientSocketId: match ? match[0] : null };
  }

  /** Socket ids of every online user whose username is part of `dmKey`. */
  participantSocketIds(dmKey: string): string[] {
    const names = dmKey.split('::');
    const ids: string[] = [];
    for (const [socketId, u] of this.#users.entries()) {
      if (names.includes(u.username.toLowerCase())) ids.push(socketId);
    }
    return ids;
  }
}
