/** A refused casino action; its message (Hungarian) is sent to the player as `error`. */
export class CasinoError extends Error {
  override readonly name = 'CasinoError';
}
