/** Sliding-window limit on call invites, per socket (legacy callHandler.js `INVITE_LIMIT`). */
export class InviteRateLimiter {
  readonly #times: number[] = [];
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max = 6, windowMs = 30_000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** Records an attempt at `now`; false (and nothing recorded) when the window is full. */
  tryAcquire(now: number): boolean {
    while (this.#times.length > 0 && now - (this.#times[0] ?? now) > this.#windowMs) this.#times.shift();
    if (this.#times.length >= this.#max) return false;
    this.#times.push(now);
    return true;
  }
}
