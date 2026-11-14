/** Token bucket per socket: `ratePerSecond` refill, at most `burst` tokens banked. */
export class InputRateLimiter {
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(ratePerSecond = 30, burst = 10, now: () => number = Date.now) {
    this.#ratePerSecond = ratePerSecond;
    this.#burst = burst;
    this.#now = now;
  }

  /** Takes one token for `socketId`; false when the socket is over its rate. */
  take(socketId: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(socketId) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * this.#ratePerSecond);
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(socketId, bucket);
    return allowed;
  }

  forget(socketId: string): void {
    this.#buckets.delete(socketId);
  }
}
