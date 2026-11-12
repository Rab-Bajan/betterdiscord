import { BaseRepository } from '../BaseRepository.ts';
import { formatMessageRow } from '../mappers/messageMappers.ts';
import type { ChannelMessageRow } from '../types/rows.ts';
import type { ChannelMessage, NewChannelMessage } from '../types/models.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

const INSERT_SQL = `
  INSERT INTO channel_messages (id, channel_id, sender_id, username, avatar_color, avatar_url, text, attachments, timestamp, created_at)
  VALUES (@id, @channel_id, @sender_id, @username, @avatar_color, @avatar_url, @text, @attachments, @timestamp, @created_at)
`;
const BY_CHANNEL_SQL = `
  SELECT * FROM channel_messages 
  WHERE channel_id = ? 
  ORDER BY created_at ASC 
  LIMIT 200
`;

/** Text-channel messages (`channel_messages` table). */
export class ChannelMessageRepository extends BaseRepository {
  /**
   * Stores a message and returns the very same input object. Defaults on insert: avatarColor
   * #7655F5, avatarUrl null, text '', attachments [], createdAt Date.now().
   */
  saveChannelMessage<T extends NewChannelMessage>(msg: T): T {
    this.statement(INSERT_SQL).run({
      id: msg.id,
      channel_id: msg.channelId,
      sender_id: msg.senderId,
      username: msg.username,
      avatar_color: msg.avatarColor || DEFAULT_AVATAR_COLOR,
      avatar_url: msg.avatarUrl || null,
      text: msg.text || '',
      attachments: JSON.stringify(msg.attachments || []),
      timestamp: msg.timestamp,
      created_at: msg.createdAt || Date.now()
    });
    return msg;
  }

  /** The oldest 200 messages of a channel, oldest first. */
  getChannelMessages(channelId: string): ChannelMessage[] {
    const rows = this.statement(BY_CHANNEL_SQL).all(channelId) as ChannelMessageRow[];
    return rows.map(formatMessageRow);
  }

  /** {@link getChannelMessages} for each id, keyed by channel id. */
  loadAllChannelMessages(channelIds: Iterable<string>): Record<string, ChannelMessage[]> {
    const result: Record<string, ChannelMessage[]> = {};
    for (const cid of channelIds) {
      result[cid] = this.getChannelMessages(cid);
    }
    return result;
  }
}
