import type { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import type { DmReportRepository } from '../../infrastructure/database/repositories/DmReportRepository.ts';
import type { DirectMessage } from '../../infrastructure/database/types/models.ts';
import type { DmReportRow } from '../../infrastructure/database/types/rows.ts';
import type { AdminFields, AdminModules, DmReportContext, DmReportSummary } from './types.ts';

/** Messages shown around a reported message, before and after it. */
export const CONTEXT_SIZE = 10;
const RESOLUTION_MAX = 200;

/** Admin action failures; the message is sent to the admin as `error`. */
export class AdminActionError extends Error {
  override readonly name = 'AdminActionError';
}

/** Client-facing texts, verbatim from adminHandler.js. */
export const ADMIN_ERRORS = Object.freeze({
  messageGone: 'A jelentett üzenet már nem létezik.',
  unknownReport: 'Ismeretlen jelentés.',
  reportClosed: 'Ez a jelentés már le van zárva.',
  outsideContext: 'Csak a jelentett üzenet környezetében lévő üzenet távolítható el.'
});

export interface AdminServiceDeps extends AdminModules {
  messages: DirectMessageRepository;
  reports: DmReportRepository;
}

/**
 * The admin actions of legacy adminHandler.js. Callers must have checked admin rights
 * (AdminController does). Field coercions are the legacy ones (`String(playerId)`,
 * `switchTurn !== false`, `piece ?? null`, ...); casino/chess validate the rest themselves.
 *
 * DM moderation is limited exactly as in legacy: only conversations with a report, only
 * the messages within {@link CONTEXT_SIZE} of the reported one, removal only while the
 * report is open.
 */
export class AdminService {
  readonly #deps: AdminServiceDeps;

  constructor(deps: AdminServiceDeps) {
    this.#deps = deps;
  }

  casinoList(): { players: unknown } {
    return { players: this.#deps.casino.admin.listAccounts() };
  }

  casinoSetBalance(f: AdminFields): unknown {
    return this.#deps.casino.admin.setBalance(String(f['playerId']), f['balance'], f['freeSpins']);
  }

  casinoSetRig(f: AdminFields): unknown {
    return this.#deps.casino.admin.setRig(String(f['playerId']), f['rig']);
  }

  /** Open reports, newest first (max 100). */
  dmReports(): { reports: DmReportSummary[] } {
    return {
      reports: this.#deps.reports.listDmReports('open').map((r) => {
        const msg = this.#deps.messages.getDmMessageById(r.message_id);
        return { id: r.id, reporter: r.reporter_username, reportedUser: msg?.senderUsername || '?', reason: r.reason, createdAt: r.created_at };
      })
    };
  }

  dmReportContext(f: AdminFields): DmReportContext {
    const report = this.#getReport(f['reportId']);
    const { msg, messages } = this.#reportContext(report);
    return {
      report: { id: report.id, reporter: report.reporter_username, reason: report.reason, status: report.status, reportedMessageId: msg.id },
      messages
    };
  }

  dmRemoveMessage(f: AdminFields): { removed: string } {
    const report = this.#getReport(f['reportId']);
    if (report.status !== 'open') throw new AdminActionError(ADMIN_ERRORS.reportClosed);
    const { messages } = this.#reportContext(report);
    const target = messages.find((m) => m.id === f['messageId']);
    if (!target) throw new AdminActionError(ADMIN_ERRORS.outsideContext);
    this.#deps.messages.removeDmMessage(target.id);
    this.#deps.dm.notifyMessageRemoved(report.dm_key, target.id);
    return { removed: target.id };
  }

  dmResolve(f: AdminFields, adminUsername: string): Record<string, never> {
    const report = this.#getReport(f['reportId']);
    const done = this.#deps.reports.resolveDmReport(report.id, adminUsername, String(f['resolution'] || '').slice(0, RESOLUTION_MAX));
    if (!done) throw new AdminActionError(ADMIN_ERRORS.reportClosed);
    return {};
  }

  chessForceMove(f: AdminFields): unknown {
    return this.#deps.chess.admin.forceMove(f['channelId'], f['from'], f['to'], f['switchTurn'] !== false);
  }

  chessPut(f: AdminFields): unknown {
    return this.#deps.chess.admin.putPiece(f['channelId'], f['square'], f['piece'] ?? null);
  }

  chessSetTurn(f: AdminFields): unknown {
    return this.#deps.chess.admin.setTurn(f['channelId'], f['turn']);
  }

  #getReport(reportId: unknown): DmReportRow {
    const report = this.#deps.reports.getDmReport(String(reportId));
    if (!report) throw new AdminActionError(ADMIN_ERRORS.unknownReport);
    return report;
  }

  #reportContext(report: DmReportRow): { msg: DirectMessage; messages: DirectMessage[] } {
    const msg = this.#deps.messages.getDmMessageById(report.message_id);
    if (!msg) throw new AdminActionError(ADMIN_ERRORS.messageGone);
    return { msg, messages: this.#deps.messages.getDmContext(report.dm_key, msg.createdAt, CONTEXT_SIZE, CONTEXT_SIZE) };
  }
}
