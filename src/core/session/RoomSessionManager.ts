/**
 * Generic per-room session store keyed by channelId (one chess game, watch
 * party, empire match... per voice channel).
 */
export class RoomSessionManager<TSession> {
  readonly #sessions = new Map<string, TSession>();

  /** Session for `channelId`, or `undefined`. */
  get(channelId: string): TSession | undefined {
    return this.#sessions.get(channelId);
  }

  /** Existing session, or the one built by `factory` (stored before returning). */
  getOrCreate(channelId: string, factory: (channelId: string) => TSession): TSession {
    // has() proved the key exists; the cast keeps a stored falsy/undefined TSession instead of rebuilding it.
    if (this.#sessions.has(channelId)) return this.#sessions.get(channelId) as TSession;
    const session = factory(channelId);
    this.#sessions.set(channelId, session);
    return session;
  }

  /** Stores (or replaces) the session for `channelId`. */
  set(channelId: string, session: TSession): void {
    this.#sessions.set(channelId, session);
  }

  has(channelId: string): boolean {
    return this.#sessions.has(channelId);
  }

  /** Removes the session; true if one existed. */
  delete(channelId: string): boolean {
    return this.#sessions.delete(channelId);
  }

  clear(): void {
    this.#sessions.clear();
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Snapshot of `[channelId, session]` pairs (safe to mutate the manager while iterating). */
  entries(): Array<[string, TSession]> {
    return [...this.#sessions.entries()];
  }

  /** Snapshot of all sessions. */
  all(): TSession[] {
    return [...this.#sessions.values()];
  }

  /**
   * Plain object keyed by channelId with each session mapped through
   * `toSnapshot` — the shape legacy `getXSessions()` getters put into `init:data`.
   */
  toRecord<TSnapshot>(toSnapshot: (session: TSession, channelId: string) => TSnapshot): Record<string, TSnapshot> {
    // fromEntries defines own properties, so a channelId like "__proto__" stays a plain key.
    return Object.fromEntries(this.entries().map(([id, session]) => [id, toSnapshot(session, id)]));
  }
}
