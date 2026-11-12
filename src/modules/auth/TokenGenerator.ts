import crypto from 'node:crypto';

/** Session token format of legacy authManager.js: 32 random bytes as 64 lower-case hex chars. */
export class TokenGenerator {
  static readonly TOKEN_BYTES = 32;

  /** A fresh random session token. */
  generate(): string {
    return crypto.randomBytes(TokenGenerator.TOKEN_BYTES).toString('hex');
  }
}
