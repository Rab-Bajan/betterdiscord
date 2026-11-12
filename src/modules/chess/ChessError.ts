/** A refused chess action; the (Hungarian) message goes to the player or admin. */
export class ChessError extends Error {
  override readonly name = 'ChessError';
}
