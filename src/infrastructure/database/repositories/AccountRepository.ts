import { BaseRepository } from '../BaseRepository.ts';
import { toAccount } from '../mappers/accountMapper.ts';
import type { AccountRow } from '../types/rows.ts';
import type { Account, AccountUpdate, NewAccount } from '../types/models.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

const INSERT_SQL = `
  INSERT INTO accounts (id, username, password_hash, salt, avatar_color, avatar_url, created_at)
  VALUES (@id, @username, @password_hash, @salt, @avatar_color, @avatar_url, @created_at)
`;
const BY_ID_SQL = `SELECT * FROM accounts WHERE id = ?`;
const BY_USERNAME_SQL = `SELECT * FROM accounts WHERE username = ? COLLATE NOCASE`;
const UPDATE_SQL = `
  UPDATE accounts 
  SET username = @username, avatar_color = @avatar_color, avatar_url = @avatar_url
  WHERE id = @id
`;

/** User accounts (`accounts` table). */
export class AccountRepository extends BaseRepository {
  /**
   * Inserts an account and returns it as stored. Falsy avatarColor defaults to #7655F5,
   * falsy avatarUrl to null, falsy createdAt to Date.now(). Throws on duplicate id/username.
   */
  createAccount({ id, username, passwordHash, salt, avatarColor, avatarUrl, createdAt }: NewAccount): Account | null {
    this.statement(INSERT_SQL).run({
      id,
      username,
      password_hash: passwordHash,
      salt,
      avatar_color: avatarColor || DEFAULT_AVATAR_COLOR,
      avatar_url: avatarUrl || null,
      created_at: createdAt || Date.now()
    });
    return this.getAccountById(id);
  }

  /** Account by id, or null. */
  getAccountById(id: string): Account | null {
    const row = this.statement(BY_ID_SQL).get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  /** Account by case-insensitive username, or null (also for an empty username). */
  getAccountByUsername(username: string | null | undefined): Account | null {
    if (!username) return null;
    const row = this.statement(BY_USERNAME_SQL).get(username) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  /** Overwrites username and avatar fields, then returns the account (null if no such id). */
  updateAccount(id: string, { username, avatarColor, avatarUrl }: AccountUpdate): Account | null {
    this.statement(UPDATE_SQL).run({
      id,
      username,
      avatar_color: avatarColor,
      avatar_url: avatarUrl
    });
    return this.getAccountById(id);
  }
}
