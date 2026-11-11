import { BaseRepository } from '../BaseRepository.ts';
import type { DmReportRow } from '../types/rows.ts';
import type { NewDmReport } from '../types/models.ts';

const INSERT_SQL = `
      INSERT OR IGNORE INTO dm_reports (id, message_id, dm_key, reporter_username, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `;
const BY_ID_SQL = 'SELECT * FROM dm_reports WHERE id = ?';
const BY_STATUS_SQL = 'SELECT * FROM dm_reports WHERE status = ? ORDER BY created_at DESC LIMIT 100';
const RESOLVE_SQL =
  "UPDATE dm_reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'";

/** DM reports (`dm_reports` table). Rows are returned raw (snake_case), as in legacy. */
export class DmReportRepository extends BaseRepository {
  /** Opens a report. False when this reporter already reported this message (or the id exists). */
  createDmReport({ id, messageId, dmKey, reporterUsername, reason }: NewDmReport): boolean {
    const result = this.statement(INSERT_SQL).run(id, messageId, dmKey, reporterUsername, reason || '', Date.now());
    return result.changes > 0;
  }

  /** Raw report row, or null. */
  getDmReport(id: string): DmReportRow | null {
    return (this.statement(BY_ID_SQL).get(id) as DmReportRow | undefined) || null;
  }

  /** Up to 100 raw report rows with `status`, newest first. */
  listDmReports(status = 'open'): DmReportRow[] {
    return this.statement(BY_STATUS_SQL).all(status) as DmReportRow[];
  }

  /** Resolves an open report. False if it does not exist or is not open. */
  resolveDmReport(id: string, adminUsername: string, resolution?: string | null): boolean {
    return this.statement(RESOLVE_SQL).run(adminUsername, Date.now(), resolution || '', id).changes > 0;
  }
}
