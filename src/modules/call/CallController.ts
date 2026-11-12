import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { CallHistoryRepository } from '../../infrastructure/database/repositories/CallHistoryRepository.ts';
import type { AccountRepository } from '../../infrastructure/database/repositories/AccountRepository.ts';
import { DmService } from '../dm/DmService.ts';
import type { PresenceUser, UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import { sanitizeSignal } from './callSignal.ts';
import { CallNotifier, publicProfile } from './CallNotifier.ts';
import { CallService, RECONNECT_GRACE_MS, RING_TIMEOUT_MS } from './CallService.ts';
import { InviteRateLimiter } from './InviteRateLimiter.ts';
import type { TurnCredentialService } from './TurnCredentialService.ts';
import type { Call, CallResult, CallRole } from './types.ts';

/** An authenticated session with an account (the only kind allowed to call). */
type CallUser = PresenceUser & { accountId: string };

/** A live call the caller takes part in, with the caller's side. */
interface OwnCall {
  me: CallUser;
  call: Call;
  role: CallRole;
}

export interface CallControllerDeps {
  service: CallService;
  notifier: CallNotifier;
  turn: TurnCredentialService;
  users: UserRegistry;
  accounts: Pick<AccountRepository, 'getAccountByUsername' | 'getAccountById'>;
  history: Pick<CallHistoryRepository, 'getCallHistory'>;
  logger: Logger;
  now?: () => number;
}

/**
 * Signalling of DM voice calls (legacy callHandler.js). Every event needs an authenticated
 * session; participants are identified by account id, never by knowing a call id. Audio is
 * peer-to-peer (WebRTC); the server only relays sanitized signals.
 */
export class CallController extends SocketController {
  readonly #service: CallService;
  readonly #notifier: CallNotifier;
  readonly #turn: TurnCredentialService;
  readonly #users: UserRegistry;
  readonly #accounts: CallControllerDeps['accounts'];
  readonly #history: CallControllerDeps['history'];
  readonly #now: () => number;

  /** @param deps.logger scoped `Call` so console lines match legacy */
  constructor(deps: CallControllerDeps) {
    super(deps.logger);
    this.#service = deps.service;
    this.#notifier = deps.notifier;
    this.#turn = deps.turn;
    this.#users = deps.users;
    this.#accounts = deps.accounts;
    this.#history = deps.history;
    this.#now = deps.now ?? (() => Date.now());
  }

  register(socket: Socket): void {
    const invites = new InviteRateLimiter();
    this.listen(socket, 'call:invite', (payload) => this.#invite(socket, payload, invites));
    this.listen(socket, 'call:accept', (payload) => this.#accept(socket, payload));
    this.listen(socket, 'call:decline', (payload) => this.#decline(socket, payload));
    this.listen(socket, 'call:end', (payload) => this.#end(socket, payload));
    this.listen(socket, 'call:signal', (payload) => { this.#signal(socket, payload); });
    this.listen(socket, 'call:connected', (payload) => { this.#connected(socket, payload); });
    this.listen(socket, 'call:sync', (payload) => this.#sync(socket, payload));
    this.listen(socket, 'call:get-ice-config', () => {
      const me = this.#authed(socket);
      return me ? { ok: true, ...this.#turn.getIceServers(me.accountId) } : { ok: false, error: 'unauthenticated' };
    });
    this.listen(socket, 'call:history', (payload) => this.#callHistory(socket, payload));
    socket.on('disconnect', () => { this.#disconnected(socket.id); });
  }

  #invite(socket: Socket, payload: unknown, invites: InviteRateLimiter): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const me = this.#authed(socket);
    if (!me) return { ok: false, error: 'unauthenticated' };
    const targetUsername = fields['targetUsername'];
    if (typeof targetUsername !== 'string' || !targetUsername.trim()) return { ok: false, error: 'not-found' };
    const targetAcc = this.#accounts.getAccountByUsername(targetUsername.trim());
    if (!targetAcc) return { ok: false, error: 'not-found' };
    if (targetAcc.id === me.accountId) return { ok: false, error: 'self' };
    if (this.#service.isBusy(me.accountId)) return { ok: false, error: 'already-in-call' };
    // Only attempts that create a call or a history entry count.
    if (!invites.tryAcquire(this.#now())) return { ok: false, error: 'rate-limited' };

    const callerRef = { accountId: me.accountId, username: me.username };
    const calleeRef = { accountId: targetAcc.id, username: targetAcc.username };
    if (this.#service.isBusy(targetAcc.id)) {
      const entry = this.#service.logInstant(callerRef, calleeRef, 'busy', 'busy');
      this.#notifier.postCallMessage(entry, entry.result);
      return { ok: false, error: 'busy', peer: publicProfile(targetAcc) };
    }
    const calleeSockets = this.#notifier.socketsOf(targetAcc.id);
    if (calleeSockets.length === 0) {
      const entry = this.#service.logInstant(callerRef, calleeRef, 'missed', 'offline');
      this.#notifier.postCallMessage(entry, entry.result);
      return { ok: false, error: 'offline', peer: publicProfile(targetAcc) };
    }

    const call = this.#service.create(callerRef, calleeRef, socket.id);
    const callerAcc = this.#accounts.getAccountById(me.accountId);
    this.#notifier.emitTo(calleeSockets, 'call:incoming', {
      callId: call.id,
      caller: publicProfile(callerAcc ?? { id: me.accountId, username: me.username, avatarColor: me.avatarColor, avatarUrl: me.avatarUrl }),
      createdAt: call.createdAt
    });
    this.#service.setTimer(call, 'ring', RING_TIMEOUT_MS, () => { this.#endCall(call, 'missed', 'no-answer'); });
    this.logger.info(`${me.username} hívja: ${targetAcc.username} (${call.id.slice(0, 8)})`);
    return {
      ok: true,
      callId: call.id,
      peer: publicProfile(targetAcc),
      ringingDevices: calleeSockets.length,
      ...this.#turn.getIceServers(me.accountId)
    };
  }

  #accept(socket: Socket, payload: unknown): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const own = this.#ownCall(socket, fields['callId']);
    if (!own || own.role !== 'callee') return { ok: false, error: 'not-found' };
    const { me, call } = own;
    if (call.status !== 'ringing') return { ok: false, error: 'expired' };
    this.#service.accept(call, socket.id, () => { this.#endCall(call, 'failed', 'connect-timeout'); });
    // Stop the ringing on the callee's other devices.
    const otherDevices = this.#notifier.socketsOf(me.accountId).filter((id) => id !== socket.id);
    this.#notifier.emitTo(otherDevices, 'call:handled-elsewhere', { callId: call.id, action: 'accepted' });
    this.#notifier.emitTo([call.callerSocketId], 'call:accepted', { callId: call.id });
    return { ok: true, ...this.#turn.getIceServers(me.accountId) };
  }

  #decline(socket: Socket, payload: unknown): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const own = this.#ownCall(socket, fields['callId']);
    if (!own || own.role !== 'callee' || own.call.status !== 'ringing') return { ok: false, error: 'not-found' };
    this.#endCall(own.call, 'declined', 'declined');
    return { ok: true };
  }

  /** Hang up or cancel (either side, own call only). */
  #end(socket: Socket, payload: unknown): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const own = this.#ownCall(socket, fields['callId']);
    if (!own) return { ok: false, error: 'not-found' };
    const { call, role } = own;
    if (call.status !== 'ringing') this.#endCall(call, 'ended', 'hangup');
    else if (role === 'caller') this.#endCall(call, 'missed', 'cancelled');
    else this.#endCall(call, 'declined', 'declined');
    return { ok: true };
  }

  /** Relays SDP / ICE / media state to the other side; only the device bound to the call may signal. */
  #signal(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const own = fields && this.#ownCall(socket, fields['callId']);
    if (!fields || !own || own.call.status === 'ringing') return;
    const { call, role } = own;
    const boundId = role === 'caller' ? call.callerSocketId : call.calleeSocketId;
    if (boundId !== socket.id) return;
    const signal = sanitizeSignal(fields['signal']);
    if (!signal) return;
    this.#notifier.emitTo([this.#service.otherSocketId(call, role)], 'call:signal', { callId: call.id, signal });
  }

  /** The client reports the audio connection is up (the call time starts). */
  #connected(socket: Socket, payload: unknown): void {
    const fields = legacyDefaultedFields(payload);
    const own = fields && this.#ownCall(socket, fields['callId']);
    if (!own || own.call.status === 'ringing' || own.call.status === 'ended') return;
    this.#service.markConnected(own.call);
  }

  /** Resume after a network drop, or late ringing sync on a new device. */
  #sync(socket: Socket, payload: unknown): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const me = this.#authed(socket);
    if (!me) return { ok: false, error: 'unauthenticated' };
    const callId = fields['callId'];
    const call = this.#service.getCallOf(me.accountId);
    const role = this.#service.roleOf(call, me.accountId);
    const ringingCallee = role === 'callee' && call?.status === 'ringing';

    if (call && role && callId && call.id === callId && !ringingCallee) {
      if (role === 'caller') call.callerSocketId = socket.id;
      else call.calleeSocketId = socket.id;
      this.#service.clearTimer(call, `grace_${role}`);
      this.#notifier.emitTo([this.#service.otherSocketId(call, role)], 'call:peer-reconnected', { callId: call.id });
      return {
        ok: true,
        resumed: true,
        role,
        status: call.status,
        elapsedSec: this.#service.elapsedSec(call),
        ...this.#turn.getIceServers(me.accountId)
      };
    }
    if (call && ringingCallee) {
      const callerAcc = this.#notifier.account(call.callerAccountId);
      if (callerAcc) socket.emit('call:incoming', { callId: call.id, caller: publicProfile(callerAcc), createdAt: call.createdAt });
    }
    return { ok: true, resumed: false, stale: !!callId };
  }

  #callHistory(socket: Socket, payload: unknown): unknown {
    const fields = legacyDefaultedFields(payload);
    if (!fields) return undefined;
    const me = this.#authed(socket);
    const targetUsername = fields['targetUsername'];
    if (!me || typeof targetUsername !== 'string') return { ok: false, error: 'unauthenticated' };
    return { ok: true, calls: this.#history.getCallHistory(DmService.getDmKey(me.username, targetUsername.trim())) };
  }

  /** A side that lost its device gets {@link RECONNECT_GRACE_MS} to come back. */
  #disconnected(socketId: string): void {
    for (const call of [...this.#service.all()]) {
      const role: CallRole | null = call.callerSocketId === socketId ? 'caller' : call.calleeSocketId === socketId ? 'callee' : null;
      if (!role) continue;
      if (role === 'caller') call.callerSocketId = null;
      else call.calleeSocketId = null;
      this.#notifier.emitTo([this.#service.otherSocketId(call, role)], 'call:peer-reconnecting', { callId: call.id });
      this.#service.setTimer(call, `grace_${role}`, RECONNECT_GRACE_MS, () => {
        this.#endCall(call, call.status === 'ringing' ? 'missed' : 'ended', 'connection-lost');
      });
    }
  }

  /** Ends the call once: history, DM system message, `call:ended` to every device of both sides. */
  #endCall(call: Call, status: string, endReason: string): CallResult | null {
    const result = this.#service.finish(call, status, endReason);
    if (!result) return null;
    this.#notifier.postCallMessage(call, result);
    this.#notifier.emitTo(
      [...this.#notifier.socketsOf(call.callerAccountId), ...this.#notifier.socketsOf(call.calleeAccountId)],
      'call:ended',
      { callId: call.id, status: result.status, reason: endReason || null, durationSec: result.durationSec }
    );
    this.logger.info(`${call.callerUsername} -> ${call.calleeUsername}: ${result.status} (${endReason || '-'}, ${result.durationSec}s)`);
    return result;
  }

  /** The caller's authenticated session with an account, or null. */
  #authed(socket: Socket): CallUser | null {
    const u = this.#users.get(socket.id);
    return u && u.authenticated === true && u.accountId ? { ...u, accountId: u.accountId } : null;
  }

  /** The live call `callId` when the caller is one of its parties. */
  #ownCall(socket: Socket, callId: unknown): OwnCall | null {
    const me = this.#authed(socket);
    const call = me && typeof callId === 'string' ? this.#service.get(callId) : undefined;
    const role = call ? this.#service.roleOf(call, me?.accountId) : null;
    return me && call && role ? { me, call, role } : null;
  }
}
