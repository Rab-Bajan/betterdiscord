import { BaseRepository } from '../BaseRepository.ts';
import { toPublicAccount } from '../mappers/accountMapper.ts';
import type { AccountRow } from '../types/rows.ts';
import type { PublicAccount } from '../types/models.ts';

const INSERT_SQL = `
  INSERT INTO auth_tokens (token, account_id, created_at)
  VALUES (?, ?, ?)
`;
const ACCOUNT_BY_TOKEN_SQL = `
  SELECT a.* FROM accounts a
  INNER JOIN auth_tokens t ON a.id = t.account_id
  WHERE t.token = ?
`;
const DELETE_SQL = `
  DELETE FROM auth_tokens WHERE token = ?
`;
const DELETE_FOR_ACCOUNT_SQL = `
  DELETE FROM auth_tokens WHERE account_id = ?
`;

/** Auto-login session tokens (`auth_tokens` table). */
export class AuthTokenRepository extends BaseRepository {
  /** Stores a token for an account. Throws if the token already exists. */
  saveAuthToken(token: string, accountId: string): void {
    this.statement(INSERT_SQL).run(token, accountId, Date.now());
  }

  /** Account (without credentials) owning `token`, or null (also for an empty token). */
  getAccountByToken(token: string | null | undefined): PublicAccount | null {
    if (!token) return null;
    const row = this.statement(ACCOUNT_BY_TOKEN_SQL).get(token) as AccountRow | undefined;
    return row ? toPublicAccount(row) : null;
  }

  /** Deletes one token; no-op for an empty token. */
  deleteAuthToken(token: string | null | undefined): void {
    if (!token) return;
    this.statement(DELETE_SQL).run(token);
  }

  /** Deletes every token of an account; no-op for an empty id. */
  deleteAccountTokens(accountId: string | null | undefined): void {
    if (!accountId) return;
    this.statement(DELETE_FOR_ACCOUNT_SQL).run(accountId);
  }
}
