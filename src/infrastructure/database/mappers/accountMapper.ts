import type { AccountRow } from '../types/rows.ts';
import type { Account, PublicAccount } from '../types/models.ts';

/** Maps an `accounts` row to an {@link Account} (with credentials). */
export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    salt: row.salt,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at
  };
}

/** Maps an `accounts` row to a {@link PublicAccount} (no credentials). */
export function toPublicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    username: row.username,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at
  };
}
