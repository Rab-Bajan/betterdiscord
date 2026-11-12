import crypto from 'node:crypto';

/** Result of {@link PasswordHasher.hash}. Both values are lower-case hex. */
export interface PasswordHash {
  hash: string;
  salt: string;
}

/**
 * PBKDF2 password hashing, bit-identical to legacy authManager.js `hashPassword`:
 * PBKDF2-HMAC-SHA512, 1000 iterations, 64-byte key, hex output; the salt is a
 * 16-byte random value *as a 32-char hex string*, and that hex string (not its bytes)
 * is the PBKDF2 salt. Changing any constant locks every existing account out.
 */
export class PasswordHasher {
  static readonly ITERATIONS = 1000;
  static readonly KEY_LENGTH = 64;
  static readonly DIGEST = 'sha512';
  static readonly SALT_BYTES = 16;

  /** Hashes `password` with `salt`; a missing or empty salt gets a fresh random one (legacy `if (!salt)`). */
  hash(password: string, salt?: string | null): PasswordHash {
    const useSalt = salt ? salt : crypto.randomBytes(PasswordHasher.SALT_BYTES).toString('hex');
    const hash = crypto
      .pbkdf2Sync(password, useSalt, PasswordHasher.ITERATIONS, PasswordHasher.KEY_LENGTH, PasswordHasher.DIGEST)
      .toString('hex');
    return { hash, salt: useSalt };
  }

  /**
   * True when `password` hashed with `salt` equals `expectedHash`. Same outcome as the legacy
   * `hash !== account.passwordHash` check (so an empty salt never verifies, and guest accounts
   * with the placeholder hash `guest_no_pass` never do either), compared in constant time.
   */
  verify(password: string, salt: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(password, salt).hash, 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
}
