import { BaseRepository } from '../BaseRepository.ts';
import { formatDmRow } from '../mappers/messageMappers.ts';
import type { DirectMessageRow } from '../types/rows.ts';
import type { DirectMessage, DmConversation, NewDirectMessage, SavedDirectMessage } from '../types/models.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

const INSERT_SQL = `
  INSERT INTO direct_messages (
    id, dm_key, sender_id, sender_account_id, sender_username, sender_avatar_color, sender_avatar_url,
    recipient_id, recipient_username, recipient_avatar_color, recipient_avatar_url,
    text, attachments, timestamp, created_at, call_event
  ) VALUES (
    @id, @dm_key, @sender_id, @sender_account_id, @sender_username, @sender_avatar_color, @sender_avatar_url,
    @recipient_id, @recipient_username, @recipient_avatar_color, @recipient_avatar_url,
    @text, @attachments, @timestamp, @created_at, @call_event
  )
`;
const BY_KEY_SQL = `
  SELECT * FROM direct_messages 
  WHERE dm_key = ? 
  ORDER BY created_at ASC 
  LIMIT 250
`;
const BY_USER_SQL = `
  SELECT * FROM direct_messages 
  WHERE sender_username = ? COLLATE NOCASE OR recipient_username = ? COLLATE NOCASE
  ORDER BY created_at DESC
`;
const BY_ID_SQL = 'SELECT * FROM direct_messages WHERE id = ?';
const OLDER_SQL = 'SELECT * FROM direct_messages WHERE dm_key = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?';
const NEWER_SQL = 'SELECT * FROM direct_messages WHERE dm_key = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?';
const REMOVE_SQL = "UPDATE direct_messages SET text = '', attachments = '[]', removed_by_admin = 1 WHERE id = ?";

/** Private messages (`direct_messages` table). */
export class DirectMessageRepository extends BaseRepository {
  /**
   * Stores a DM. Insert defaults: avatar colours #7655F5, avatar urls / senderAccountId null,
   * text '', attachments [], createdAt Date.now().
   *
   * The return value is built from the input, not the stored row (legacy behaviour):
   * senderId / senderAccountId / recipientId are undefined, removedByAdmin is false and none of
   * the insert defaults except attachments are applied.
   */
  saveDmMessage(msg: NewDirectMessage): SavedDirectMessage {
    const callEvent = msg.callEvent ? JSON.stringify(msg.callEvent) : null;
    this.statement(INSERT_SQL).run({
      id: msg.id,
      dm_key: msg.dmKey,
      sender_id: msg.senderId,
      sender_account_id: msg.senderAccountId || null,
      sender_username: msg.senderUsername,
      sender_avatar_color: msg.senderAvatarColor || DEFAULT_AVATAR_COLOR,
      sender_avatar_url: msg.senderAvatarUrl || null,
      recipient_id: msg.recipientId,
      recipient_username: msg.recipientUsername,
      recipient_avatar_color: msg.recipientAvatarColor || DEFAULT_AVATAR_COLOR,
      recipient_avatar_url: msg.recipientAvatarUrl || null,
      text: msg.text || '',
      attachments: JSON.stringify(msg.attachments || []),
      timestamp: msg.timestamp,
      created_at: msg.createdAt || Date.now(),
      call_event: callEvent
    });
    return formatDmRow({
      ...msg,
      call_event: callEvent,
      dm_key: msg.dmKey,
      sender_username: msg.senderUsername,
      sender_avatar_color: msg.senderAvatarColor,
      sender_avatar_url: msg.senderAvatarUrl,
      recipient_username: msg.recipientUsername,
      recipient_avatar_color: msg.recipientAvatarColor,
      recipient_avatar_url: msg.recipientAvatarUrl,
      attachments: JSON.stringify(msg.attachments || []),
      created_at: msg.createdAt
    });
  }

  /** DM by id, or null. */
  getDmMessageById(id: string): DirectMessage | null {
    return formatDmRow(this.statement(BY_ID_SQL).get(id) as DirectMessageRow | undefined);
  }

  /**
   * Report context: up to `before + 1` messages at or before `createdAt` (so the reported
   * message itself is included) and up to `after` messages after it, oldest first. A NULL
   * `createdAt` matches nothing (SQL comparison with NULL), as in legacy.
   */
  getDmContext(dmKey: string, createdAt: number | null, before = 10, after = 10): DirectMessage[] {
    const older = (this.statement(OLDER_SQL).all(dmKey, createdAt, before + 1) as DirectMessageRow[]).reverse();
    const newer = this.statement(NEWER_SQL).all(dmKey, createdAt, after) as DirectMessageRow[];
    return [...older, ...newer].map((row) => formatDmRow(row));
  }

  /** Blanks a DM's content and flags it as removed by an admin. True if a row changed. */
  removeDmMessage(id: string): boolean {
    return this.statement(REMOVE_SQL).run(id).changes > 0;
  }

  /** The oldest 250 messages of a conversation, oldest first. */
  getDmMessages(dmKey: string): DirectMessage[] {
    const rows = this.statement(BY_KEY_SQL).all(dmKey) as DirectMessageRow[];
    return rows.map((row) => formatDmRow(row));
  }

  /**
   * Conversation partners of `username` (case-insensitive), most recent conversation first,
   * one entry per partner (keyed by lower-cased partner name). Empty username gives [].
   */
  getUserDmConversations(username: string | null | undefined): DmConversation[] {
    if (!username) return [];
    const rows = this.statement(BY_USER_SQL).all(username, username) as DirectMessageRow[];
    const partners = new Map<string, DmConversation>();

    for (const r of rows) {
      const isSender = r.sender_username.toLowerCase() === username.toLowerCase();
      const partnerName = isSender ? r.recipient_username : r.sender_username;
      const partnerColor = isSender ? r.recipient_avatar_color : r.sender_avatar_color;
      const partnerUrl = isSender ? r.recipient_avatar_url : r.sender_avatar_url;
      const partnerId = isSender ? r.recipient_id : r.sender_id;
      const partnerKey = partnerName.toLowerCase();

      if (!partners.has(partnerKey)) {
        partners.set(partnerKey, {
          id: partnerId || partnerName,
          username: partnerName,
          avatarColor: partnerColor || DEFAULT_AVATAR_COLOR,
          avatarUrl: partnerUrl || null,
          lastMessage: r.call_event ? 'Hanghívás' : (r.text || 'Fájl csatolmány'),
          lastTimestamp: r.timestamp
        });
      }
    }
    return Array.from(partners.values());
  }
}
