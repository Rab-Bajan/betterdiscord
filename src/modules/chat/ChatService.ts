import type { Attachment, ChannelMessage, NewChannelMessage } from '../../infrastructure/database/types/models.ts';
import type { PresenceUser } from '../presence/UserRegistry.ts';

/** Messages kept in memory per channel (older ones stay in SQLite only). */
export const MAX_MESSAGES_PER_CHANNEL = 150;

/** A message as broadcast in `chat:new-message` and stored in the cache. */
export interface ChatMessage extends NewChannelMessage {
  senderId: string;
  avatarColor: string;
  avatarUrl: string | null;
  text: string;
  attachments: Attachment[];
  timestamp: string;
}

/** Persistence used by the service (ChannelMessageRepository satisfies it). */
export interface ChannelMessageStore {
  saveChannelMessage(msg: ChatMessage): unknown;
  loadAllChannelMessages(channelIds: Iterable<string>): Record<string, ChannelMessage[]>;
}

/** Clock and randomness for ids/timestamps, injectable for tests. */
export interface ChatClock {
  now(): number;
  random(): number;
  /** `HH:MM` display time (legacy `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`). */
  displayTime(): string;
}

export const defaultChatClock: ChatClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  displayTime: () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
};

/** Raw `chat:message` fields after legacy coercion. */
export interface PostInput {
  channelId: string;
  text: unknown;
  attachments: unknown;
}

const WELCOME_TEXT = 'Üdvözlünk a SharkVoic prémium kommunikációs szerveren! 🔒🎉 Válassz egy hangcsatornát vagy csevegj a szobákban.';

/**
 * Text-channel messages (legacy chatHandler.js): loads every text channel's
 * history once, seeds the welcome bot message, persists and caches new ones.
 */
export class ChatService {
  readonly #store: ChannelMessageStore;
  readonly #clock: ChatClock;
  /** The live object put into `init:data.channelMessages` (same identity on every call, like legacy). */
  readonly #messages: Record<string, unknown[]>;

  constructor(store: ChannelMessageStore, textChannelIds: readonly string[], clock: ChatClock = defaultChatClock) {
    this.#store = store;
    this.#clock = clock;
    this.#messages = store.loadAllChannelMessages(textChannelIds);
    if (!this.#messages['altalanos'] || this.#messages['altalanos'].length === 0) {
      this.#messages['altalanos'] = [this.#welcome()];
    }
  }

  /** Channel id -> cached messages (oldest first). */
  getChannelMessages(): Record<string, unknown[]> {
    return this.#messages;
  }

  /**
   * Builds, persists and caches a message from `user`. Returns `null` when
   * there is nothing to send (blank text and no attachments).
   */
  post(user: PresenceUser, input: PostInput): ChatMessage | null {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    // Attachments are passed through unchecked, as legacy did (frontend upload results).
    const attachments = (Array.isArray(input.attachments) ? input.attachments : []) as Attachment[];
    if (!text && attachments.length === 0) return null;
    const message = this.#build(user, input.channelId, text, attachments);
    this.#store.saveChannelMessage(message);
    this.#append(input.channelId, message);
    return message;
  }

  #build(user: PresenceUser, channelId: string, text: string, attachments: Attachment[]): ChatMessage {
    return {
      id: `${this.#clock.now()}-${this.#clock.random().toString(36).substring(2, 11)}`,
      senderId: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl || null,
      text,
      attachments,
      timestamp: this.#clock.displayTime(),
      channelId
    };
  }

  #append(channelId: string, message: ChatMessage): void {
    if (!Object.hasOwn(this.#messages, channelId)) {
      // defineProperty keeps a "__proto__" channel id an own key instead of replacing the prototype.
      Object.defineProperty(this.#messages, channelId, { value: [], enumerable: true, writable: true, configurable: true });
    }
    const list = this.#messages[channelId] ?? [];
    list.push(message);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.shift();
  }

  #welcome(): Record<string, unknown> {
    return {
      id: 'welcome-1',
      senderId: 'system',
      username: 'Rendszer Bot',
      avatarColor: '#7655F5',
      text: WELCOME_TEXT,
      timestamp: this.#clock.displayTime(),
      isSystem: true
    };
  }
}
