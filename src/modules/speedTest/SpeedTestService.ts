import type { PresenceUser, SpeedTestResult, UserRegistry } from '../presence/UserRegistry.ts';

/**
 * `Math.round(v || 0)` from legacy; Math.round coerces like Number().
 * Note: `Number(x)` is exactly the ToNumber step Math.round applies.
 */
const rounded = (value: unknown): number => Math.round(Number(value || 0));

/**
 * `Number((v || 0).toFixed(1))` from legacy. Only numbers have toFixed; legacy
 * threw a TypeError for anything else (so nothing was saved), hence `null`.
 */
const oneDecimal = (value: unknown): number | null => {
  const v = value || 0;
  return typeof v === 'number' ? Number(v.toFixed(1)) : null;
};

/** Speed-test results stored on the user (legacy speedTestHandler.js). */
export class SpeedTestService {
  readonly #users: UserRegistry;
  readonly #now: () => number;

  constructor(users: UserRegistry, now: () => number = () => Date.now()) {
    this.#users = users;
    this.#now = now;
  }

  /** Current server time for `speedtest:pong`. */
  serverTime(): number {
    return this.#now();
  }

  /**
   * Normalises and stores `raw` on the user of `socketId`. Returns the user,
   * or `null` when there is no user or the values are not legacy-compatible
   * (in which case nothing changes, as in legacy).
   */
  saveResult(socketId: string, raw: Readonly<Record<string, unknown>>): PresenceUser | null {
    const user = this.#users.get(socketId);
    if (!user) return null;
    const download = oneDecimal(raw['download']);
    const upload = oneDecimal(raw['upload']);
    if (download === null || upload === null) return null;
    const result: SpeedTestResult = {
      ping: rounded(raw['ping']),
      download,
      upload,
      jitter: rounded(raw['jitter']),
      testedAt: this.#now()
    };
    user.speedTest = result;
    return user;
  }

  /** Sender and target of a `speedtest:request-user`, or `null` if either is not connected. */
  resolveRequest(senderId: string, targetUserId: unknown): { sender: PresenceUser; target: PresenceUser } | null {
    const sender = this.#users.get(senderId);
    const target = typeof targetUserId === 'string' ? this.#users.get(targetUserId) : undefined;
    return sender && target ? { sender, target } : null;
  }
}
