import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CallService, CONNECT_TIMEOUT_MS, type Scheduler } from '../../../src/modules/call/CallService.ts';
import { InviteRateLimiter } from '../../../src/modules/call/InviteRateLimiter.ts';
import { TurnCredentialService } from '../../../src/modules/call/TurnCredentialService.ts';
import { sanitizeSignal } from '../../../src/modules/call/callSignal.ts';
import { captureLogger } from '../socket/fakes.ts';
import type { CallRecordInput } from '../../../src/infrastructure/database/types/models.ts';

/** Scheduler whose timers run only when the test fires them. */
class ManualScheduler implements Scheduler {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  #next = 0;
  set(callback: () => void, ms: number): unknown {
    this.pending.set(++this.#next, { callback, ms });
    return this.#next;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(ms: number): void {
    for (const [id, t] of [...this.pending]) if (t.ms === ms) { this.pending.delete(id); t.callback(); }
  }
}

const setup = () => {
  let t = 1_000_000;
  let id = 0;
  const saved: CallRecordInput[] = [];
  const scheduler = new ManualScheduler();
  const service = new CallService({
    history: { saveCall: (c) => { saved.push(c); } },
    logger: captureLogger().logger,
    now: () => t,
    scheduler,
    newId: () => `call${++id}`
  });
  return { service, saved, scheduler, advance: (ms: number) => { t += ms; } };
};
const dave = { accountId: 'acc-d', username: 'Dave' };
const erin = { accountId: 'acc-e', username: 'Erin' };

test('a call binds both accounts until it finishes, exactly once', () => {
  const { service, saved, advance } = setup();
  const call = service.create(dave, erin, 'sock-d');
  assert.equal(service.isBusy('acc-d'), true);
  assert.equal(service.getCallOf('acc-e'), call);
  assert.equal(service.roleOf(call, 'acc-e'), 'callee');
  assert.equal(service.roleOf(call, 'acc-x'), null);
  service.accept(call, 'sock-e', () => {});
  service.markConnected(call);
  advance(2600);
  assert.equal(service.elapsedSec(call), 3);
  assert.deepEqual(service.finish(call, 'ended', 'hangup'), { status: 'completed', endReason: 'hangup', durationSec: 3 });
  assert.equal(service.finish(call, 'ended', 'hangup'), null);
  assert.equal(service.isBusy('acc-d'), false);
  assert.equal(service.get('call1'), undefined);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.dmKey, 'dave::erin');
  assert.equal(saved[0]?.answeredAt, 1_000_000);
});

test('ended without audio becomes failed; other statuses are kept', () => {
  const { service } = setup();
  assert.equal(service.finish(service.create(dave, erin, 's'), 'ended', 'connection-lost')?.status, 'failed');
  assert.equal(service.finish(service.create(dave, erin, 's'), 'missed', 'no-answer')?.status, 'missed');
});

test('accept stops the ring timer and starts the connect timeout; finish clears all timers', () => {
  const { service, scheduler } = setup();
  const call = service.create(dave, erin, 's');
  let rang = false;
  service.setTimer(call, 'ring', 45_000, () => { rang = true; });
  let timedOut = false;
  service.accept(call, 'sock-e', () => { timedOut = true; });
  scheduler.fire(45_000);
  assert.equal(rang, false);
  scheduler.fire(CONNECT_TIMEOUT_MS);
  assert.equal(timedOut, true);
  service.setTimer(call, 'grace_caller', 20_000, () => {});
  service.finish(call, 'ended', 'hangup');
  assert.equal(scheduler.pending.size, 0);
});

test('logInstant writes a finished entry without touching live calls', () => {
  const { service, saved } = setup();
  const entry = service.logInstant(dave, erin, 'missed', 'offline');
  assert.deepEqual(entry.result, { status: 'missed', endReason: 'offline', durationSec: 0 });
  assert.equal(service.isBusy('acc-d'), false);
  assert.equal(saved[0]?.endedAt, 1_000_000);
});

test('history save errors are logged, the call still ends', () => {
  const { logger, logs } = captureLogger();
  const service = new CallService({ history: { saveCall: () => { throw new Error('disk'); } }, logger });
  assert.equal(service.finish(service.create(dave, erin, 's'), 'declined', 'declined')?.status, 'declined');
  assert.match(logs[0]?.message ?? '', /Hívásnapló mentési hiba/);
});

test('TurnCredentialService: STUN only without TURN; coturn REST credentials with it', () => {
  const stunOnly = new TurnCredentialService({ stunUrls: ['stun:a'], turnUrls: ['turn:t'], turnSecret: null, turnTtlSec: 3600 });
  assert.deepEqual(stunOnly.getIceServers('acc'), { iceServers: [{ urls: ['stun:a'] }], ttl: 0, turnEnabled: false });
  const turn = new TurnCredentialService({ stunUrls: ['stun:a'], turnUrls: ['turn:t'], turnSecret: 's3cret', turnTtlSec: 600 }, () => 10_000);
  const username = '610:acc_1-x';
  assert.deepEqual(turn.getIceServers('acc_1-x!'), {
    iceServers: [{ urls: ['stun:a'] }, { urls: ['turn:t'], username, credential: createHmac('sha1', 's3cret').update(username).digest('base64') }],
    ttl: 600,
    turnEnabled: true
  });
});

test('sanitizeSignal keeps only known, valid fields', () => {
  assert.deepEqual(sanitizeSignal({ type: 'offer', sdp: 'v=0', x: 1 }), { type: 'offer', sdp: 'v=0' });
  assert.equal(sanitizeSignal({ type: 'answer', sdp: '' }), null);
  assert.equal(sanitizeSignal({ type: 'answer', sdp: 'x'.repeat(30_001) }), null);
  assert.deepEqual(sanitizeSignal({ type: 'candidate', candidate: null }), { type: 'candidate', candidate: null });
  assert.deepEqual(sanitizeSignal({ type: 'candidate', candidate: { candidate: 'c', sdpMid: '0' } }),
    { type: 'candidate', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: null } });
  assert.equal(sanitizeSignal({ type: 'candidate', candidate: { candidate: 'c', sdpMLineIndex: 1.5 } }), null);
  assert.equal(sanitizeSignal({ type: 'candidate', candidate: { candidate: 'c', sdpMid: 5 } }), null);
  assert.equal(sanitizeSignal({ type: 'candidate', candidate: 'c' }), null);
  assert.deepEqual(sanitizeSignal({ type: 'restart-request', x: 1 }), { type: 'restart-request' });
  assert.deepEqual(sanitizeSignal({ type: 'media', muted: false }), { type: 'media', muted: false });
  assert.equal(sanitizeSignal({ type: 'media', muted: 0 }), null);
  assert.equal(sanitizeSignal('offer'), null);
  assert.equal(sanitizeSignal(null), null);
});

test('InviteRateLimiter: 6 attempts per 30 s window', () => {
  const limiter = new InviteRateLimiter();
  for (let i = 0; i < 6; i++) assert.equal(limiter.tryAcquire(i), true);
  assert.equal(limiter.tryAcquire(30_000), false);
  assert.equal(limiter.tryAcquire(30_001), true);
});
