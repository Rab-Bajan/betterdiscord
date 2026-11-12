import type { Logger } from '../../core/logging/Logger.ts';
import type { Account, PublicAccount } from '../../infrastructure/database/types/models.ts';
import type { AccountRepository } from '../../infrastructure/database/repositories/AccountRepository.ts';
import type { AuthTokenRepository } from '../../infrastructure/database/repositories/AuthTokenRepository.ts';
import { defaultIdSource, legacyId, type IdSource } from '../shared/legacyId.ts';
import { PasswordHasher } from './PasswordHasher.ts';
import { TokenGenerator } from './TokenGenerator.ts';
import type { AuthResult, LoginInput, ProfileInput, ProfileResult, PublicUser, RegisterInput } from './types.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';
const GUEST_FALLBACK_NAME = 'Felhasználó';
/** Placeholder credentials of accounts created implicitly by a guest's profile update. */
const GUEST_PASSWORD_HASH = 'guest_no_pass';
const GUEST_SALT = 'guest_salt';

/** Client-facing error texts, verbatim from authManager.js. */
export const AUTH_ERRORS = Object.freeze({
  usernameLength: 'A felhasználónév 2 és 24 karakter közötti legyen!',
  passwordLength: 'A jelszó legalább 4 karakter hosszú legyen!',
  usernameTaken: 'Ez a felhasználónév már foglalt!',
  missingCredentials: 'Kérlek add meg a felhasználónevet és jelszót!',
  unknownUser: 'Nem létezik felhasználó ezzel a névvel!',
  wrongPassword: 'Helytelen jelszó!',
  missingToken: 'Hiányzó token!',
  invalidToken: 'Érvénytelen vagy lejárt munkamenet token!',
  profileNameTaken: 'Ez a név már foglalt egy másik felhasználó által!'
});

export interface AuthServiceDeps {
  accounts: AccountRepository;
  tokens: AuthTokenRepository;
  logger: Logger;
  hasher?: PasswordHasher;
  tokenGenerator?: TokenGenerator;
  ids?: IdSource;
}

/** Legacy `sanitizeAccount`: strips credentials and applies avatar defaults. */
export function toPublicUser(account: PublicAccount): PublicUser {
  return {
    id: account.id,
    username: account.username,
    avatarColor: account.avatarColor || DEFAULT_AVATAR_COLOR,
    avatarUrl: account.avatarUrl || null,
    createdAt: account.createdAt
  };
}

/**
 * Account registration, password login, token login, logout and profile updates
 * (legacy authManager.js), with identical rules, messages, hashing and token format.
 */
export class AuthService {
  readonly #accounts: AccountRepository;
  readonly #tokens: AuthTokenRepository;
  readonly #logger: Logger;
  readonly #hasher: PasswordHasher;
  readonly #tokenGenerator: TokenGenerator;
  readonly #ids: IdSource;

  constructor(deps: AuthServiceDeps) {
    this.#accounts = deps.accounts;
    this.#tokens = deps.tokens;
    this.#logger = deps.logger;
    this.#hasher = deps.hasher ?? new PasswordHasher();
    this.#tokenGenerator = deps.tokenGenerator ?? new TokenGenerator();
    this.#ids = deps.ids ?? defaultIdSource;
  }

  /** Creates a password account (name 2-24 chars after trim, password ≥ 4) and issues a token. */
  register({ username, password, avatarColor, avatarUrl }: RegisterInput): AuthResult {
    const cleanUsername = (username || '').trim();
    if (!cleanUsername || cleanUsername.length < 2 || cleanUsername.length > 24) {
      return { success: false, error: AUTH_ERRORS.usernameLength };
    }
    if (!password || password.length < 4) {
      return { success: false, error: AUTH_ERRORS.passwordLength };
    }
    if (this.#accounts.getAccountByUsername(cleanUsername)) {
      return { success: false, error: AUTH_ERRORS.usernameTaken };
    }

    const { hash, salt } = this.#hasher.hash(password);
    const created = this.#mustExist(this.#accounts.createAccount({
      id: legacyId('acc', 6, this.#ids),
      username: cleanUsername,
      passwordHash: hash,
      salt,
      avatarColor: avatarColor || DEFAULT_AVATAR_COLOR,
      avatarUrl: avatarUrl || null,
      createdAt: this.#ids.now()
    }));
    const token = this.#issueToken(created.id);
    this.#logger.info(`[SQLite Auth] Új fiók regisztrálva: ${created.username} (${created.id})`);
    return { success: true, user: toPublicUser(created), token };
  }

  /** Verifies username (case-insensitive, trimmed) + password and issues a new token. */
  login({ username, password }: LoginInput): AuthResult {
    const cleanUsername = (username || '').trim();
    if (!cleanUsername || !password) {
      return { success: false, error: AUTH_ERRORS.missingCredentials };
    }
    const account = this.#accounts.getAccountByUsername(cleanUsername);
    if (!account) {
      return { success: false, error: AUTH_ERRORS.unknownUser };
    }
    if (!this.#hasher.verify(password, account.salt, account.passwordHash)) {
      return { success: false, error: AUTH_ERRORS.wrongPassword };
    }
    const token = this.#issueToken(account.id);
    this.#logger.info(`[SQLite Auth] Sikeres bejelentkezés: ${account.username} (${account.id})`);
    return { success: true, user: toPublicUser(account), token };
  }

  /** Resolves a stored session token to its account; the same token is returned (no rotation). */
  verifyToken(token: string | undefined): AuthResult {
    if (!token) return { success: false, error: AUTH_ERRORS.missingToken };
    const account = this.#tokens.getAccountByToken(token);
    if (!account) {
      return { success: false, error: AUTH_ERRORS.invalidToken };
    }
    this.#logger.info(`[SQLite Auth] Token sikeresen hitelesítve: ${account.username} (${account.id})`);
    return { success: true, user: toPublicUser(account), token };
  }

  /** Deletes the given token (no-op when empty). */
  logout(token: string | undefined): void {
    if (token) this.#tokens.deleteAuthToken(token);
  }

  /**
   * Legacy `updateProfile`. The account is found by `accountId`, else by the *requested*
   * username; when neither exists a placeholder (guest) account is created. A rename is refused
   * only if another account already has the new name (case-insensitive). No length rule applies.
   */
  updateProfile(accountId: string | null, { username, avatarColor, avatarUrl }: ProfileInput): ProfileResult {
    let account = accountId ? this.#accounts.getAccountById(accountId) : null;
    if (!account && username) {
      account = this.#accounts.getAccountByUsername(username);
    }

    if (!account) {
      const created = this.#mustExist(this.#accounts.createAccount({
        id: accountId || legacyId('acc', 6, this.#ids),
        username: username || GUEST_FALLBACK_NAME,
        passwordHash: GUEST_PASSWORD_HASH,
        salt: GUEST_SALT,
        avatarColor: avatarColor || DEFAULT_AVATAR_COLOR,
        avatarUrl: avatarUrl || null,
        createdAt: this.#ids.now()
      }));
      return { success: true, user: toPublicUser(created) };
    }

    const cleanNewName = username ? username.trim() : account.username;
    if (cleanNewName.toLowerCase() !== account.username.toLowerCase()) {
      const conflict = this.#accounts.getAccountByUsername(cleanNewName);
      if (conflict && conflict.id !== account.id) {
        return { success: false, error: AUTH_ERRORS.profileNameTaken };
      }
    }

    const updated = this.#mustExist(this.#accounts.updateAccount(account.id, {
      username: cleanNewName,
      avatarColor: avatarColor || account.avatarColor,
      avatarUrl: avatarUrl !== undefined ? avatarUrl : account.avatarUrl
    }));
    this.#logger.info(`[SQLite Auth] Profil frissítve: ${updated.username}`);
    return { success: true, user: toPublicUser(updated) };
  }

  /** Public view of an account, or null. */
  getAccount(accountId: string): PublicUser | null {
    const account = this.#accounts.getAccountById(accountId);
    return account ? toPublicUser(account) : null;
  }

  #issueToken(accountId: string): string {
    const token = this.#tokenGenerator.generate();
    this.#tokens.saveAuthToken(token, accountId);
    return token;
  }

  /** The row was just written, so a miss means the database changed underneath us. */
  #mustExist(account: Account | null): Account {
    if (!account) throw new Error('Account row missing right after write');
    return account;
  }
}
