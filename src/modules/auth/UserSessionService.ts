import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import type { PublicUser, SessionData } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

/** Decides whether a username has admin rights (legacy state.js `isAdminUsername`). */
export type AdminNamePolicy = (name: unknown) => boolean;

/**
 * Per-socket user sessions in the shared {@link UserRegistry} (legacy authHandler
 * `establishUserSession` and the profile/logout/disconnect bookkeeping).
 *
 * Authorization rules preserved exactly:
 * - admin only for an *authenticated* (password/token) session whose name is an admin name;
 *   a guest using an admin name never is;
 * - a rename can only drop admin rights, never grant them.
 */
export class UserSessionService {
  readonly #users: UserRegistry;
  readonly #isAdminName: AdminNamePolicy;

  constructor(users: UserRegistry, isAdminName: AdminNamePolicy) {
    this.#users = users;
    this.#isAdminName = isAdminName;
  }

  /** Creates (or replaces) the session of `socketId` and returns the stored, live user object. */
  establish(socketId: string, data: SessionData): PresenceUser {
    const authenticated = data.authenticated === true;
    const user: PresenceUser = {
      id: socketId,
      accountId: data.accountId || null,
      username: data.username,
      avatarColor: data.avatarColor || DEFAULT_AVATAR_COLOR,
      avatarUrl: data.avatarUrl || null,
      voiceChannel: null,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      isScreenSharing: false,
      isCameraOn: false,
      authenticated,
      isAdmin: authenticated && this.#isAdminName(data.username),
      speedTest: null
    };
    this.#users.set(socketId, user);
    return user;
  }

  /** Session of `socketId`, if any. */
  get(socketId: string): PresenceUser | undefined {
    return this.#users.get(socketId);
  }

  /** Applies a successful profile update to the live session object (mutated in place). */
  applyProfile(user: PresenceUser, profile: PublicUser): void {
    user.username = profile.username;
    user.isAdmin = user.isAdmin && this.#isAdminName(profile.username);
    user.avatarColor = profile.avatarColor;
    user.avatarUrl = profile.avatarUrl;
  }

  /** Ends the session of `socketId`; true if there was one. */
  end(socketId: string): boolean {
    return this.#users.delete(socketId);
  }
}
