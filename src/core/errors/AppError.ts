/**
 * Base class for every expected, domain-level failure.
 *
 * The `message` of an AppError is considered safe to show to the client
 * (it is what socket acks carry back as `error`). Unexpected failures should
 * stay plain `Error`s so their internals are logged, never exposed.
 */
export class AppError extends Error {
  /** Stable, machine-readable error code (e.g. `VALIDATION_ERROR`). */
  readonly code: string;
  /** Optional structured context for logs or clients. */
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * Opt-in extra fields that are safe to send to the client; socket failure
   * acks spread them after `ok`/`error`/`code` (e.g. `{ needsLogin: true }`).
   * `details`, by contrast, is log-only.
   */
  readonly clientFields: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    clientFields?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.clientFields = clientFields;
  }
}
