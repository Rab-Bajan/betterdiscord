import type { Attachment, DirectMessage, DmConversation } from '../../infrastructure/database/types/models.ts';

/** `dm:history` payload. */
export interface DmHistory {
  partnerId: string | undefined;
  partnerUsername: string;
  dmKey: string;
  messages: DirectMessage[];
}

/** Message object emitted as `dm:new-message` (and stored; extra keys are ignored by the repository). */
export interface DmOutgoingMessage {
  id: string;
  dmKey: string;
  username: string;
  senderId: string;
  senderAccountId: string | null;
  senderUsername: string;
  senderAvatarColor: string;
  senderAvatarUrl: string | null;
  recipientId: string | undefined;
  recipientUsername: string;
  recipientAvatarColor: string;
  recipientAvatarUrl: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  text: string;
  attachments: Attachment[];
  timestamp: string;
  createdAt: number;
  isPrivate: true;
}

/** Result of a send: what to emit and to which other socket (if online). */
export interface DmDelivery {
  message: DmOutgoingMessage;
  /** Socket id of the online recipient; null when offline. May equal the sender's socket. */
  recipientSocketId: string | null;
}

/** Ack of `dm:report-message`. */
export type DmReportAck = { ok: true } | { ok: false; error: string };

/** dm:get-history / dm:send-message target (absent → undefined, `''` kept). */
export interface DmTarget {
  targetUserId: string | undefined;
  targetUsername: string | undefined;
}

/** dm:send-message input: `text` / `attachments` are raw and coerced like legacy. */
export interface DmSendInput extends DmTarget {
  text: unknown;
  attachments: unknown;
}

export type { DmConversation };

/** What other modules consume from the dm module (legacy dmHandler return value). */
export interface DmApi {
  getDmKey(idA: unknown, idB: unknown): string;
  notifyMessageRemoved(dmKey: string, messageId: string): void;
}
