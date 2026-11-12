import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceUser } from '../presence/UserRegistry.ts';
import { legacyFields } from '../shared/legacyPayload.ts';
import type { AdminService } from './AdminService.ts';
import type { AdminFields } from './types.ts';

/** Ack text when the caller has no admin session (verbatim from adminHandler.js). */
export const ADMIN_FORBIDDEN = 'Nincs jogosultságod ehhez.';
const ADMIN_FALLBACK_ERROR = 'A művelet sikertelen.';
/** Read-only events that are not written to the admin log. */
const UNLOGGED_EVENTS: ReadonlySet<string> = new Set(['admin:casino-list', 'admin:dm-reports']);

/** Looks up the session of a socket (satisfied by UserRegistry). */
export interface SessionLookup {
  get(socketId: string): PresenceUser | undefined;
}

/** Ack shapes of every admin event. */
export type AdminAck = { ok: false; error: string } | ({ ok: true } & Record<string, unknown>);

type AdminHandler = (fields: AdminFields, me: PresenceUser) => unknown;

/**
 * Socket events of legacy adminHandler.js. Every event re-checks on the server, per call,
 * that the socket's session has `isAdmin === true` (set only for authenticated admin names),
 * before any payload is looked at. Successful mutating actions are logged as
 * `[Admin] <name>: <event> <payload JSON>`.
 *
 * Acks: `{ ok: true, ...result }` or `{ ok: false, error }` where `error` is the thrown
 * message (also for errors raised inside casino/chess), falling back to a generic text.
 */
export class AdminController extends SocketController {
  readonly #service: AdminService;
  readonly #sessions: SessionLookup;

  constructor(service: AdminService, sessions: SessionLookup, logger: Logger) {
    super(logger);
    this.#service = service;
    this.#sessions = sessions;
  }

  register(socket: Socket): void {
    const s = this.#service;
    this.#action(socket, 'admin:casino-list', () => s.casinoList());
    this.#action(socket, 'admin:casino-set-balance', (f) => s.casinoSetBalance(f));
    this.#action(socket, 'admin:casino-set-rig', (f) => s.casinoSetRig(f));
    this.#action(socket, 'admin:dm-reports', () => s.dmReports());
    this.#action(socket, 'admin:dm-report-context', (f) => s.dmReportContext(f));
    this.#action(socket, 'admin:dm-remove-message', (f) => s.dmRemoveMessage(f));
    this.#action(socket, 'admin:dm-resolve', (f, me) => s.dmResolve(f, me.username));
    this.#action(socket, 'admin:chess-force-move', (f) => s.chessForceMove(f));
    this.#action(socket, 'admin:chess-put', (f) => s.chessPut(f));
    this.#action(socket, 'admin:chess-set-turn', (f) => s.chessSetTurn(f));
  }

  /** Legacy `adminAction`: authorization, then the handler; errors become `{ ok: false }` acks. */
  #action(socket: Socket, event: string, handler: AdminHandler): void {
    this.listen(socket, event, (payload): AdminAck => {
      const me = this.#sessions.get(socket.id);
      if (!me || me.isAdmin !== true) return { ok: false, error: ADMIN_FORBIDDEN };
      const body = payload || {};
      try {
        const result = handler(legacyFields(body), me);
        if (!UNLOGGED_EVENTS.has(event)) {
          this.logger.info(`[Admin] ${me.username}: ${event} ${JSON.stringify(body)}`);
        }
        // Spread exactly like legacy `{ ok: true, ...result }` (a result may even override `ok`).
        return { ok: true, ...(result as Record<string, unknown>) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) || ADMIN_FALLBACK_ERROR };
      }
    });
  }
}

/** Legacy `err.message`, tolerant of non-Error throwables. */
function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message || '');
  return '';
}
