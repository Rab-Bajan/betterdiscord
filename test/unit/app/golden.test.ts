import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { MIGRATED_MODULES } from '../../../src/modules/migratedModules.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const RUNNER = path.join(import.meta.dirname, 'golden', 'runGoldenSession.ts');

type Transcript = Array<[string, unknown]>;
interface Golden { alice: Transcript; bob: Transcript; carol: Transcript; dave: Transcript; erin: Transcript }

/**
 * Runs one scripted session in a fresh process with its own fresh SQLite file. Without
 * `overrides` the app mounts its default module set; with them, exactly those overrides.
 */
function run(mode: 'legacy' | 'app', overrides?: Record<string, string>): Promise<Golden> {
  const env = { ...process.env };
  delete env['SHARKVOIC_DB_PATH'];
  delete env['GOLDEN_OVERRIDES'];
  if (overrides) env['GOLDEN_OVERRIDES'] = Object.entries(overrides).map(([name, file]) => `${name}:${file}`).join(',');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', './test/support/isolatedDb.cjs', RUNNER, mode],
      { cwd: ROOT, env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${mode} run failed: ${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('GOLDEN:'));
        if (!line) return reject(new Error(`${mode} run printed no transcript\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('GOLDEN:'.length)) as Golden);
      });
  });
}

let legacyRun: Promise<Golden> | undefined;
/** The legacy transcript, computed once per file. */
const legacyGolden = (): Promise<Golden> => (legacyRun ??= run('legacy'));
const fixture = (name: string): string => path.join(import.meta.dirname, 'golden', 'fixtures', name);

const assertSameTranscript = (app: Golden, legacy: Golden): void => {
  for (const who of ['alice', 'bob', 'carol', 'dave', 'erin'] as const) {
    assert.deepEqual(app[who].map(([e]) => e), legacy[who].map(([e]) => e), `${who} event order`);
  }
  assert.deepEqual(app, legacy);
};

// Each test runs its child processes independently; a few at a time keeps the file fast without
// starving the settle-based script of CPU.
describe('golden transcripts', { concurrency: 4 }, () => {
  test('the script exercises the wiring of every module it compares', async () => {
    const legacy = await legacyGolden();
    // Equality proves nothing unless these events actually occur.
    const has = (who: keyof Golden, expected: readonly string[]): void => {
      const events = legacy[who].map(([event]) => event);
      for (const e of expected) assert.ok(events.includes(e), `legacy ${who} transcript lacks ${e}`);
    };
    has('alice', [
      'init:data', 'users:updated', 'voice:states-updated', 'chat:new-message', 'voice:joined',
      'game:session-updated', 'whiteboard:list', 'code:tree-data', 'watch:state', 'browser:state',
      'empire:session-updated', 'phobia:session-updated', 'voice:peer-joined', 'voice:user-speaking',
      'ack:admin:casino-list', 'voice:peer-left', 'user:profile-updated', 'dm:new-message', 'dm:message-removed',
      'ack:admin:dm-reports', 'whiteboard:created', 'whiteboard:cleared', 'whiteboard:deleted',
      'watch:state', 'watch:session-updated', 'watch:sync-event', 'watch:reaction-received',
      'ack:call:invite', 'casino:session-updated', 'ack:lobby:join', 'lobby:players', 'lobby:count', 'wallet:balance',
      'player:moved', 'chat:message', 'ack:casino:slot', 'ack:blackjack:start', 'ack:poker:draw'
    ]);
    has('bob', [
      'ack:game:rpc', 'voice:user-screen-sharing', 'voice:user-camera', 'webrtc:signal', 'speedtest:result-announced',
      'speedtest:requested-by', 'dm:conversations', 'dm:history', 'ack:dm:report-message', 'dm:message-removed',
      'whiteboard:data', 'whiteboard:stroke', 'watch:countdown-start', 'code:file-updated'
    ]);
    has('carol', [
      'auth:error', 'auth:success', 'auth:token-invalid', 'user:profile-updated', 'profile:error',
      'ack:admin:dm-report-context', 'ack:admin:dm-remove-message', 'ack:admin:dm-resolve',
      'ack:admin:casino-set-balance', 'ack:admin:chess-set-turn', 'casino:session-updated', 'ack:admin:casino-set-rig'
    ]);
    has('dave', ['call:accepted', 'call:signal', 'call:ended', 'call:incoming', 'ack:call:sync', 'ack:call:history', 'dm:new-message']);
    has('erin', ['call:incoming', 'call:signal', 'call:peer-reconnected', 'call:ended', 'ack:call:accept', 'ack:call:decline']);
  });

  test('the default Application (migrated modules + legacy rest) emits exactly what legacy server.js emits', async () => {
    const [legacy, app] = await Promise.all([legacyGolden(), run('app')]);
    assertSameTranscript(app, legacy);
  });

  test('the Application with only legacy modules emits exactly what legacy server.js emits', async () => {
    const [legacy, app] = await Promise.all([legacyGolden(), run('app', {})]);
    assertSameTranscript(app, legacy);
  });

  test('an override wrapping the legacy chat module through the factory interface matches legacy', async () => {
    const [legacy, app] = await Promise.all([legacyGolden(), run('app', { chat: fixture('legacyChatOverride.ts') })]);
    assert.deepEqual(app, legacy);
  });

  test('a deliberately broken chat override is caught by the golden comparison', async () => {
    const [legacy, app] = await Promise.all([legacyGolden(), run('app', { chat: fixture('brokenChatOverride.ts') })]);
    assert.notDeepEqual(app, legacy);
    const text = (g: Golden): unknown => g.bob.find(([e]) => e === 'chat:new-message')?.[1];
    assert.equal((text(app) as { text: string }).text, 'SZIA');
    assert.equal((text(legacy) as { text: string }).text, 'szia');
  });

  const MODULES = path.join(ROOT, 'src', 'modules');
  const moduleFile = (name: string): string => path.join(MODULES, name, `${name}Module.ts`);

  for (const name of Object.keys(MIGRATED_MODULES)) {
    test(`${name} migration alone reproduces the legacy transcript`, async () => {
      const [legacy, app] = await Promise.all([legacyGolden(), run('app', { [name]: moduleFile(name) })]);
      assertSameTranscript(app, legacy);
    });
  }
});
