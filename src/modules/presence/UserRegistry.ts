/** Speed-test result stored on a user (speedTestHandler.js). */
export interface SpeedTestResult {
  ping: number;
  download: number;
  upload: number;
  jitter: number;
  testedAt: number;
}

/**
 * A connected user, keyed by socket.id (shape built by authHandler.js
 * `establishUserSession`). Legacy handlers mutate these objects in place.
 */
export interface PresenceUser {
  id: string;
  accountId: string | null;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
  voiceChannel: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking?: boolean;
  isScreenSharing?: boolean;
  isCameraOn?: boolean;
  authenticated?: boolean;
  isAdmin?: boolean;
  speedTest?: SpeedTestResult | null;
}

/**
 * Typed view over the legacy `state.js` `users` Map. It wraps the very same
 * Map instance (never a copy), so legacy handlers and new code share one
 * source of truth during the migration.
 */
export class UserRegistry {
  readonly #users: Map<string, PresenceUser>;

  /** @param users the shared Map (pass `require('./state').users`). */
  constructor(users: Map<string, PresenceUser>) {
    this.#users = users;
  }

  /** User connected on `socketId`, or `undefined`. */
  get(socketId: string): PresenceUser | undefined {
    return this.#users.get(socketId);
  }

  has(socketId: string): boolean {
    return this.#users.has(socketId);
  }

  set(socketId: string, user: PresenceUser): void {
    this.#users.set(socketId, user);
  }

  /** Removes the user; true if one existed. */
  delete(socketId: string): boolean {
    return this.#users.delete(socketId);
  }

  get size(): number {
    return this.#users.size;
  }

  /** Live iterator in insertion (= connection) order, like the legacy Map. */
  values(): IterableIterator<PresenceUser> {
    return this.#users.values();
  }

  /** Live `[socketId, user]` iterator in insertion order. */
  entries(): IterableIterator<[string, PresenceUser]> {
    return this.#users.entries();
  }
}
