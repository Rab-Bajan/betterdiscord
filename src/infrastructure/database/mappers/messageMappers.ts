import type { ChannelMessageRow, DirectMessageRow } from '../types/rows.ts';
import type { Attachment, CallEvent, ChannelMessage, DirectMessage, SavedDirectMessage } from '../types/models.ts';

/** Row-shaped object with any subset of `direct_messages` columns (saveDmMessage echo). */
export type DirectMessageRowLike = { [K in keyof DirectMessageRow]?: DirectMessageRow[K] | undefined };

/** Parses a stored attachments JSON string; empty/NULL becomes []. */
function parseAttachments(raw: string | null | undefined): Attachment[] {
  return raw ? (JSON.parse(raw) as Attachment[]) : [];
}

/** Legacy `formatMessageRow`: `channel_messages` row to {@link ChannelMessage}. */
export function formatMessageRow(row: ChannelMessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    username: row.username,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    timestamp: row.timestamp,
    createdAt: row.created_at
  };
}

/** Legacy `formatDmRow`: `direct_messages` row to {@link DirectMessage}; missing row gives null. */
export function formatDmRow(row: DirectMessageRow): DirectMessage;
export function formatDmRow(row: DirectMessageRow | undefined): DirectMessage | null;
export function formatDmRow(row: DirectMessageRowLike): SavedDirectMessage;
export function formatDmRow(row: DirectMessageRowLike | undefined): SavedDirectMessage | null {
  if (!row) return null;
  return {
    id: row.id,
    dmKey: row.dm_key,
    username: row.sender_username,
    senderId: row.sender_id,
    senderAccountId: row.sender_account_id,
    senderUsername: row.sender_username,
    senderAvatarColor: row.sender_avatar_color,
    senderAvatarUrl: row.sender_avatar_url,
    recipientId: row.recipient_id,
    recipientUsername: row.recipient_username,
    recipientAvatarColor: row.recipient_avatar_color,
    recipientAvatarUrl: row.recipient_avatar_url,
    avatarColor: row.sender_avatar_color,
    avatarUrl: row.sender_avatar_url,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    timestamp: row.timestamp,
    createdAt: row.created_at,
    removedByAdmin: !!row.removed_by_admin,
    callEvent: row.call_event ? (JSON.parse(row.call_event) as CallEvent) : null,
    isPrivate: true
  };
}
