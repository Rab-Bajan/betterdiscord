import { randomBytes } from 'node:crypto';
import type { CallHistoryRepository } from '../../infrastructure/database/repositories/CallHistoryRepository.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import { DmService } from '../dm/DmService.ts';
import type { Call, CallParty, CallResult, CallRole, CallSummary, CallTimer } from './types.ts';

/** How long a call rings before it counts as missed. */
export const RING_TIMEOUT_MS = 45_000;
/** How long a side that lost its connection may take to come back. */
export const RECONNECT_GRACE_MS = 20_000;
/** How long the audio connection may take to come up after the callee accepted. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Timer functions, injectable for tests. */
export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export interface CallServiceDeps {
  history: Pick<CallHistoryRepository, 'saveCall'>;
  logger: Logger;
  now?: () => number;
  scheduler?: Scheduler;
  newId?: () => string;
}

/** A call that never started (busy / offline callee), already written to the history. */
export interface InstantCall extends CallSummary {
  result: CallResult;
}

/**
 * Call state machine (legacy callService.js): every account has at most one live call.
 * Call ids are random, but authorization always goes by account id (see {@link roleOf}).
 */
export class CallService {
  readonly #calls = new Map<string, Call>();
  /** accountId -> callId */
  readonly #userCall = new Map<string, string>();
  readonly #timers = new Map<string, Map<CallTimer, unknown>>();
  readonly #history: CallServiceDeps['history'];
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #scheduler: Scheduler;
  readonly #newId: () => string;

  constructor(deps: CallServiceDeps) {
    this.#history = deps.history;
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => Date.now());
    this.#scheduler = deps.scheduler ?? defaultScheduler;
    this.#newId = deps.newId ?? (() => randomBytes(16).toString('hex'));
  }

  get(callId: string): Call | undefined {
    return this.#calls.get(callId);
  }

  /** Live calls, in creation order. */
  all(): IterableIterator<Call> {
    return this.#calls.values();
  }

  getCallOf(accountId: string): Call | null {
    const id = this.#userCall.get(accountId);
    return id ? this.#calls.get(id) ?? null : null;
  }

  isBusy(accountId: string): boolean {
    return this.#userCall.has(accountId);
  }

  /** Starts ringing a new call from `caller` (on `callerSocketId`) to `callee`. */
  create(caller: CallParty, callee: CallParty, callerSocketId: string): Call {
    const call: Call = {
      id: this.#newId(),
      callerAccountId: caller.accountId,
      callerUsername: caller.username,
      calleeAccountId: callee.accountId,
      calleeUsername: callee.username,
      callerSocketId,
      calleeSocketId: null,
      status: 'ringing',
      createdAt: this.#now(),
      answeredAt: null,
      connectedAt: null,
      endedAt: null
    };
    this.#calls.set(call.id, call);
    this.#userCall.set(call.callerAccountId, call.id);
    this.#userCall.set(call.calleeAccountId, call.id);
    return call;
  }

  /** Logs a call that ended before it began; live calls are not affected. */
  logInstant(caller: CallParty, callee: CallParty, status: string, endReason: string): InstantCall {
    const now = this.#now();
    const id = this.#newId();
    this.#history.saveCall({
      id,
      callerAccountId: caller.accountId,
      callerUsername: caller.username,
      calleeAccountId: callee.accountId,
      calleeUsername: callee.username,
      createdAt: now,
      dmKey: DmService.getDmKey(caller.username, callee.username),
      status,
      endedAt: now,
      endReason
    });
    return { id, callerAccountId: caller.accountId, calleeAccountId: callee.accountId, result: { status, endReason, durationSec: 0 } };
  }

  /** Which side `accountId` is on, or null for a stranger. */
  roleOf(call: Call | null | undefined, accountId: string | null | undefined): CallRole | null {
    if (!call || !accountId) return null;
    if (call.callerAccountId === accountId) return 'caller';
    if (call.calleeAccountId === accountId) return 'callee';
    return null;
  }

  /** Bound device of the other side. */
  otherSocketId(call: Call, role: CallRole): string | null {
    return role === 'caller' ? call.calleeSocketId : call.callerSocketId;
  }

  /** The callee answered on `socketId`: stop ringing, wait for the audio connection. */
  accept(call: Call, socketId: string, onConnectTimeout: () => void): void {
    call.status = 'connecting';
    call.answeredAt = this.#now();
    call.calleeSocketId = socketId;
    this.clearTimer(call, 'ring');
    this.setTimer(call, 'connect', CONNECT_TIMEOUT_MS, onConnectTimeout);
  }

  /** The audio connection is up; the call duration counts from the first report. */
  markConnected(call: Call): void {
    this.clearTimer(call, 'connect');
    if (!call.connectedAt) {
      call.connectedAt = this.#now();
      call.status = 'connected';
    }
  }

  /** Whole seconds since the audio connection came up (0 before). */
  elapsedSec(call: Call): number {
    return call.connectedAt ? Math.round((this.#now() - call.connectedAt) / 1000) : 0;
  }

  clearTimer(call: Call, name: CallTimer): void {
    const timers = this.#timers.get(call.id);
    if (!timers?.has(name)) return;
    this.#scheduler.clear(timers.get(name));
    timers.delete(name);
  }

  setTimer(call: Call, name: CallTimer, ms: number, callback: () => void): void {
    this.clearTimer(call, name);
    let timers = this.#timers.get(call.id);
    if (!timers) {
      timers = new Map();
      this.#timers.set(call.id, timers);
    }
    const own = timers;
    own.set(name, this.#scheduler.set(() => {
      own.delete(name);
      callback();
    }, ms));
  }

  /**
   * Ends `call` exactly once and writes it to the history. A requested `ended` becomes
   * `completed` (audio was connected) or `failed`. Returns null when it had already ended.
   */
  finish(call: Call, status: string, endReason: string): CallResult | null {
    if (call.status === 'ended') return null;
    const wasConnected = call.connectedAt !== null;
    call.status = 'ended';
    const endedAt = this.#now();
    call.endedAt = endedAt;
    for (const name of [...(this.#timers.get(call.id)?.keys() ?? [])]) this.clearTimer(call, name);
    this.#timers.delete(call.id);
    if (this.#userCall.get(call.callerAccountId) === call.id) this.#userCall.delete(call.callerAccountId);
    if (this.#userCall.get(call.calleeAccountId) === call.id) this.#userCall.delete(call.calleeAccountId);
    this.#calls.delete(call.id);

    const durationSec = call.connectedAt !== null ? Math.max(0, Math.round((endedAt - call.connectedAt) / 1000)) : 0;
    const finalStatus = status === 'ended' ? (wasConnected ? 'completed' : 'failed') : status;
    try {
      this.#history.saveCall({
        id: call.id,
        dmKey: DmService.getDmKey(call.callerUsername, call.calleeUsername),
        callerAccountId: call.callerAccountId,
        callerUsername: call.callerUsername,
        calleeAccountId: call.calleeAccountId,
        calleeUsername: call.calleeUsername,
        status: finalStatus,
        createdAt: call.createdAt,
        answeredAt: call.answeredAt,
        endedAt,
        durationSec,
        endReason
      });
    } catch (err) {
      this.#logger.error('Hívásnapló mentési hiba:', err instanceof Error ? err.message : err);
    }
    return { status: finalStatus, endReason, durationSec };
  }
}
