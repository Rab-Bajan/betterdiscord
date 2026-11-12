// Domain objects returned by the repositories (camelCase), plus their input shapes.
// Shapes and null/undefined semantics mirror the legacy database.js exactly.

/** Account including credentials (getAccountById / getAccountByUsername). */
export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  avatarColor: string | null;
  avatarUrl: string | null;
  createdAt: number | null;
}

/** Account without credentials (getAccountByToken). */
export type PublicAccount = Omit<Account, 'passwordHash' | 'salt'>;

/** Input of createAccount. Falsy avatarColor/avatarUrl/createdAt fall back to defaults. */
export interface NewAccount {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  avatarColor?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  createdAt?: number | null | undefined;
}

/** Input of updateAccount. All three fields are bound, so all must be present. */
export interface AccountUpdate {
  username: string;
  avatarColor: string | null;
  avatarUrl: string | null;
}

/** Attachment payloads are opaque JSON stored and returned unchanged. */
export type Attachment = unknown;

/** Channel message as returned by getChannelMessages. */
export interface ChannelMessage {
  id: string;
  channelId: string;
  senderId: string | null;
  username: string;
  avatarColor: string | null;
  avatarUrl: string | null;
  text: string | null;
  attachments: Attachment[];
  timestamp: string | null;
  createdAt: number | null;
}

/** Input of saveChannelMessage (returned unchanged by it). */
export interface NewChannelMessage {
  id: string;
  channelId: string;
  senderId?: string | null | undefined;
  username: string;
  avatarColor?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  text?: string | null | undefined;
  attachments?: Attachment[] | null | undefined;
  timestamp?: string | null | undefined;
  createdAt?: number | null | undefined;
}

/** Call event embedded in a DM system message: { callId, status, durationSec, callerUsername }. */
export type CallEvent = Record<string, unknown>;

/** Direct message as read back from the database. */
export interface DirectMessage {
  id: string;
  dmKey: string;
  /** Same as senderUsername (ChatArea compatibility). */
  username: string;
  senderId: string | null;
  senderAccountId: string | null;
  senderUsername: string;
  senderAvatarColor: string | null;
  senderAvatarUrl: string | null;
  recipientId: string | null;
  recipientUsername: string;
  recipientAvatarColor: string | null;
  recipientAvatarUrl: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  text: string | null;
  attachments: Attachment[];
  timestamp: string | null;
  createdAt: number | null;
  removedByAdmin: boolean;
  callEvent: CallEvent | null;
  isPrivate: true;
}

/**
 * Value returned by saveDmMessage. Legacy builds it from the *input* rather than the stored
 * row, so id-like fields (senderId, senderAccountId, recipientId) are always undefined and
 * defaults applied on insert are not reflected.
 */
export type SavedDirectMessage = {
  [K in keyof DirectMessage]: DirectMessage[K] | undefined;
} & { removedByAdmin: boolean; attachments: Attachment[]; isPrivate: true };

/** Input of saveDmMessage. */
export interface NewDirectMessage {
  id: string;
  dmKey: string;
  senderId?: string | null | undefined;
  senderAccountId?: string | null | undefined;
  senderUsername: string;
  senderAvatarColor?: string | null | undefined;
  senderAvatarUrl?: string | null | undefined;
  recipientId?: string | null | undefined;
  recipientUsername: string;
  recipientAvatarColor?: string | null | undefined;
  recipientAvatarUrl?: string | null | undefined;
  text?: string | null | undefined;
  attachments?: Attachment[] | null | undefined;
  timestamp?: string | null | undefined;
  createdAt?: number | null | undefined;
  callEvent?: CallEvent | null | undefined;
}

/** One entry of getUserDmConversations. */
export interface DmConversation {
  id: string;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
  lastMessage: string;
  lastTimestamp: string | null;
}

/** Input of createDmReport. */
export interface NewDmReport {
  id: string;
  messageId: string;
  dmKey: string;
  reporterUsername: string;
  reason?: string | null | undefined;
}

/** Input of saveCall (INSERT OR REPLACE). Omitted optional fields get the legacy defaults. */
export interface CallRecordInput {
  id: string;
  dmKey: string;
  callerAccountId: string;
  callerUsername: string;
  calleeAccountId: string;
  calleeUsername: string;
  status: string;
  createdAt: number;
  answeredAt?: number | null;
  endedAt?: number | null;
  durationSec?: number;
  endReason?: string | null;
}

/** One entry of getCallHistory. */
export interface CallRecord {
  id: string;
  callerUsername: string;
  calleeUsername: string;
  status: string;
  createdAt: number;
  durationSec: number;
}
