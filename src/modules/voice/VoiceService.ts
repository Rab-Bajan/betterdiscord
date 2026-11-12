import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';

/** Peer entry in `voice:joined` / `voice:peer-joined` (legacy voiceHandler.js `publicPeer`). */
export interface VoicePeer {
  id: string;
  username: string;
  avatarColor: string;
  isMuted: boolean;
  isDeafened: boolean;
}

export const toVoicePeer = (u: PresenceUser): VoicePeer => ({
  id: u.id,
  username: u.username,
  avatarColor: u.avatarColor,
  isMuted: u.isMuted,
  isDeafened: u.isDeafened
});

/** Result of a join: what the controller must announce. */
export interface JoinOutcome {
  user: PresenceUser;
  /** Channel the user was in before (left implicitly), or null. */
  previousChannel: string | null;
  /** Other users already in the channel, in connection order. */
  peers: VoicePeer[];
}

/** Voice-room membership and media flags on the shared users (legacy voiceHandler.js). */
export class VoiceService {
  readonly #users: UserRegistry;

  constructor(users: UserRegistry) {
    this.#users = users;
  }

  /** Moves the user into `channelId` (resetting speaking/camera), or `null` if not logged in. */
  join(socketId: string, channelId: string): JoinOutcome | null {
    const user = this.#users.get(socketId);
    if (!user) return null;
    const previousChannel = user.voiceChannel || null;
    user.voiceChannel = channelId;
    user.isSpeaking = false;
    user.isCameraOn = false;
    const peers: VoicePeer[] = [];
    for (const [id, u] of this.#users.entries()) {
      if (u.voiceChannel === channelId && id !== socketId) peers.push(toVoicePeer(u));
    }
    return { user, previousChannel, peers };
  }

  /** Takes the user out of their channel; returns the channel left, or `null`. */
  leave(socketId: string): { user: PresenceUser; channelId: string } | null {
    const user = this.#users.get(socketId);
    if (!user?.voiceChannel) return null;
    const channelId = user.voiceChannel;
    user.voiceChannel = null;
    user.isSpeaking = false;
    user.isScreenSharing = false;
    user.isCameraOn = false;
    return { user, channelId };
  }

  /** Sets a media flag (`!!value`, as legacy) for a user in a channel; returns the user or `null`. */
  setFlag(socketId: string, flag: 'isSpeaking' | 'isScreenSharing' | 'isCameraOn', value: unknown): PresenceUser | null {
    const user = this.#users.get(socketId);
    if (!user?.voiceChannel) return null;
    user[flag] = !!value;
    return user;
  }

  /** Applies boolean mute/deafen values (others ignored); works outside a channel too. */
  setMuteState(socketId: string, isMuted: unknown, isDeafened: unknown): PresenceUser | null {
    const user = this.#users.get(socketId);
    if (!user) return null;
    if (typeof isMuted === 'boolean') user.isMuted = isMuted;
    if (typeof isDeafened === 'boolean') user.isDeafened = isDeafened;
    return user;
  }

  /** The logged-in user of `socketId`, if any. */
  user(socketId: string): PresenceUser | undefined {
    return this.#users.get(socketId);
  }

  /** True when `peerId` is a connected user's socket id. */
  isConnected(peerId: unknown): boolean {
    return typeof peerId === 'string' && this.#users.has(peerId);
  }
}
