import { BaseRepository } from '../BaseRepository.ts';
import type { CallRow } from '../types/rows.ts';
import type { CallRecord, CallRecordInput } from '../types/models.ts';

const UPSERT_SQL = `
      INSERT OR REPLACE INTO calls (id, dm_key, caller_account_id, caller_username, callee_account_id, callee_username,
        status, created_at, answered_at, ended_at, duration_sec, end_reason)
      VALUES (@id, @dmKey, @callerAccountId, @callerUsername, @calleeAccountId, @calleeUsername,
        @status, @createdAt, @answeredAt, @endedAt, @durationSec, @endReason)
    `;
const BY_KEY_SQL = 'SELECT * FROM calls WHERE dm_key = ? ORDER BY created_at DESC LIMIT ?';

/** Voice-call metadata log (`calls` table). Audio is never stored. */
export class CallHistoryRepository extends BaseRepository {
  /** Inserts or replaces a call by id. Missing answeredAt/endedAt/endReason → null, durationSec → 0. */
  saveCall(c: CallRecordInput): void {
    this.statement(UPSERT_SQL).run({ answeredAt: null, endedAt: null, durationSec: 0, endReason: null, ...c });
  }

  /** Up to `limit` calls of a conversation, newest first. */
  getCallHistory(dmKey: string, limit = 50): CallRecord[] {
    return (this.statement(BY_KEY_SQL).all(dmKey, limit) as CallRow[]).map((r) => ({
      id: r.id,
      callerUsername: r.caller_username,
      calleeUsername: r.callee_username,
      status: r.status,
      createdAt: r.created_at,
      durationSec: r.duration_sec || 0
    }));
  }
}
