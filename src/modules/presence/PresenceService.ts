import type { VoiceChannel } from '../../config/channels.ts';
import type { PresenceUser, SpeedTestResult, UserRegistry } from './UserRegistry.ts';

/** Member entry of a voice channel in `voice:states-updated`. */
export interface VoiceMember {
  id: string;
  username: string;
  avatarColor: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isScreenSharing: boolean;
  isCameraOn: boolean;
  speedTest: SpeedTestResult | null;
}

/** Entry of `users:updated` / `init:data.onlineUsers`. */
export interface OnlineUser {
  id: string;
  accountId: string | null;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
  voiceChannel: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  isCameraOn: boolean;
  speedTest: SpeedTestResult | null;
}

/** Anything that can broadcast to every client (a socket.io Server). */
export interface Broadcaster {
  emit(event: string, ...args: unknown[]): unknown;
}

const toVoiceMember = (user: PresenceUser): VoiceMember => ({
  id: user.id,
  username: user.username,
  avatarColor: user.avatarColor,
  isMuted: user.isMuted,
  isDeafened: user.isDeafened,
  isSpeaking: user.isSpeaking || false,
  isScreenSharing: user.isScreenSharing || false,
  isCameraOn: user.isCameraOn || false,
  speedTest: user.speedTest || null
});

const toOnlineUser = (user: PresenceUser): OnlineUser => ({
  id: user.id,
  accountId: user.accountId || null,
  username: user.username,
  avatarColor: user.avatarColor,
  avatarUrl: user.avatarUrl || null,
  voiceChannel: user.voiceChannel,
  isMuted: user.isMuted,
  isDeafened: user.isDeafened,
  isScreenSharing: user.isScreenSharing || false,
  isCameraOn: user.isCameraOn || false,
  speedTest: user.speedTest || null
});

/**
 * Presence views computed from the {@link UserRegistry}; output is identical
 * to state.js `getVoiceChannelState`, `getOnlineUsersList` and `broadcastPresence`.
 */
export class PresenceService {
  readonly #users: UserRegistry;
  readonly #voiceChannels: readonly VoiceChannel[];

  constructor(users: UserRegistry, voiceChannels: readonly VoiceChannel[]) {
    this.#users = users;
    this.#voiceChannels = voiceChannels;
  }

  /** `{ [voiceChannelId]: VoiceMember[] }` for every configured voice channel (unknown channels ignored). */
  getVoiceChannelState(): Record<string, VoiceMember[]> {
    const state = new Map<string, VoiceMember[]>(this.#voiceChannels.map((vc) => [vc.id, []]));
    for (const user of this.#users.values()) {
      if (user.voiceChannel) state.get(user.voiceChannel)?.push(toVoiceMember(user));
    }
    return Object.fromEntries(state);
  }

  /** Every connected user, in connection order. */
  getOnlineUsersList(): OnlineUser[] {
    return Array.from(this.#users.values(), toOnlineUser);
  }

  /** Emits `users:updated` then `voice:states-updated` to everyone. */
  broadcastPresence(io: Broadcaster): void {
    io.emit('users:updated', this.getOnlineUsersList());
    io.emit('voice:states-updated', this.getVoiceChannelState());
  }
}
