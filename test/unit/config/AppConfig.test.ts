import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { AppConfig, DEFAULT_STUN_URLS, type Env } from '../../../src/config/AppConfig.ts';

const require = createRequire(import.meta.url);
const BACKEND_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Loads a fresh copy of a legacy CJS module with `env` as process.env. */
function withLegacyEnv<T>(file: string, env: Env, use: (mod: T) => void): void {
  const resolved = require.resolve(file);
  const saved = process.env;
  process.env = { ...env };
  try {
    delete require.cache[resolved];
    use(require(resolved) as T);
  } finally {
    process.env = saved;
    delete require.cache[resolved];
  }
}

test('defaults', () => {
  const c = AppConfig.fromEnv({});
  assert.equal(c.port, 5000);
  assert.deepEqual(c.adminUsernames, ['bajan']);
  assert.equal(c.dbPath, path.join(BACKEND_ROOT, 'data', 'sharkvoic.db'));
  assert.equal(c.certsDir, path.resolve(BACKEND_ROOT, '../certs'));
  assert.equal(c.chromePath, null);
  assert.deepEqual(c.stunUrls, DEFAULT_STUN_URLS);
  assert.deepEqual(c.turnUrls, []);
  assert.equal(c.turnSecret, null);
  assert.equal(c.turnTtlSec, 3600);
  assert.equal(c.turnEnabled, false);
  assert.equal(c.phobiaTestHooks, false);
});

test('backend root is resolved from the module, independent of cwd', () => {
  assert.equal(AppConfig.backendRoot, BACKEND_ROOT);
  assert.ok(require.resolve('../../../server.js').startsWith(AppConfig.backendRoot + path.sep));
  const cwd = process.cwd();
  process.chdir(path.parse(cwd).root);
  try {
    assert.equal(AppConfig.fromEnv({}).dbPath, path.join(BACKEND_ROOT, 'data', 'sharkvoic.db'));
  } finally {
    process.chdir(cwd);
  }
});

test('overrides', () => {
  const c = AppConfig.fromEnv({
    PORT: '8443',
    ADMIN_USERNAMES: 'Root, Admin',
    SHARKVOIC_DB_PATH: '/tmp/x.db',
    CHROME_PATH: '/usr/bin/chromium',
    STUN_URLS: 'stun:a:1, stun:b:2',
    TURN_URLS: 'turn:t:3478?transport=udp,turns:t:5349?transport=tcp',
    TURN_SECRET: 'sekret',
    TURN_TTL: '120',
    PHOBIA_TEST_HOOKS: '1'
  });
  assert.equal(c.port, 8443);
  assert.deepEqual(c.adminUsernames, ['root', 'admin']);
  assert.equal(c.dbPath, '/tmp/x.db');
  assert.equal(c.chromePath, '/usr/bin/chromium');
  assert.deepEqual(c.stunUrls, ['stun:a:1', 'stun:b:2']);
  assert.deepEqual(c.turnUrls, ['turn:t:3478?transport=udp', 'turns:t:5349?transport=tcp']);
  assert.equal(c.turnSecret, 'sekret');
  assert.equal(c.turnTtlSec, 120);
  assert.equal(c.turnEnabled, true);
  assert.equal(c.phobiaTestHooks, true);
});

test('empty strings behave like unset (legacy `||` semantics)', () => {
  const c = AppConfig.fromEnv({
    PORT: '',
    ADMIN_USERNAMES: '',
    SHARKVOIC_DB_PATH: '',
    CHROME_PATH: '',
    STUN_URLS: '',
    TURN_SECRET: '',
    TURN_URLS: 'turn:x'
  });
  assert.equal(c.port, 5000);
  assert.deepEqual(c.adminUsernames, ['bajan']);
  assert.equal(c.dbPath, path.join(BACKEND_ROOT, 'data', 'sharkvoic.db'));
  assert.equal(c.chromePath, null);
  assert.deepEqual(c.stunUrls, DEFAULT_STUN_URLS);
  assert.equal(c.turnEnabled, false, 'empty secret disables TURN');
});

test('PORT validation', () => {
  assert.equal(AppConfig.fromEnv({ PORT: '0' }).port, 0);
  assert.equal(AppConfig.fromEnv({ PORT: '65535' }).port, 65535);
  for (const bad of ['abc', '-1', '65536', '80.5', '3000x']) {
    assert.throws(() => AppConfig.fromEnv({ PORT: bad }), RangeError, bad);
  }
});

test('ADMIN_USERNAMES parsing: trims, lowercases, drops empties', () => {
  assert.deepEqual(AppConfig.fromEnv({ ADMIN_USERNAMES: ' A ,,b, ,C' }).adminUsernames, ['a', 'b', 'c']);
  assert.deepEqual(AppConfig.fromEnv({ ADMIN_USERNAMES: ' , ' }).adminUsernames, []);
});

test('isAdmin matches state.js isAdminUsername for the same env', () => {
  const names: unknown[] = ['bajan', 'BAJAN', 'Bajan ', 'root', 'Root', 'x', '', null, undefined, 0, 42];
  for (const ADMIN_USERNAMES of [undefined, '', 'Root, x', ' , ', '42']) {
    const env: Env = ADMIN_USERNAMES === undefined ? {} : { ADMIN_USERNAMES };
    const config = AppConfig.fromEnv(env);
    withLegacyEnv<{ isAdminUsername: (n: unknown) => boolean }>('../../../state.js', env, (state) => {
      for (const n of names) assert.equal(config.isAdmin(n), state.isAdminUsername(n), `${String(ADMIN_USERNAMES)} / ${String(n)}`);
    });
  }
});

test('TURN_TTL parsing: parseInt, fallback 3600, floor 60', () => {
  const ttl = (TURN_TTL: string | undefined) => AppConfig.fromEnv(TURN_TTL === undefined ? {} : { TURN_TTL }).turnTtlSec;
  assert.equal(ttl(undefined), 3600);
  assert.equal(ttl(''), 3600);
  assert.equal(ttl('abc'), 3600);
  assert.equal(ttl('0'), 3600);
  assert.equal(ttl('10'), 60);
  assert.equal(ttl('-500'), 60);
  assert.equal(ttl('90s'), 90);
  assert.equal(ttl('7200'), 7200);
});

test('ICE parsing matches turnCredentialService.js for the same env', (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000);
  const envs: Env[] = [
    {},
    { STUN_URLS: ' stun:a , ,stun:b' },
    { TURN_URLS: 'turn:x', TURN_SECRET: 's' },
    { TURN_URLS: 'turn:x,turns:y', TURN_SECRET: 's', TURN_TTL: '30' },
    { TURN_URLS: 'turn:x', TURN_SECRET: 's', TURN_TTL: 'junk' },
    { TURN_URLS: 'turn:x', TURN_SECRET: '' },
    { TURN_URLS: ' , ', TURN_SECRET: 's' },
    { TURN_SECRET: 's', TURN_TTL: '500' }
  ];
  for (const env of envs) {
    const c = AppConfig.fromEnv(env);
    withLegacyEnv<{ getIceServers: (id: string) => { iceServers: unknown[]; ttl: number; turnEnabled: boolean } }>(
      '../../../turnCredentialService.js',
      env,
      (svc) => {
        const legacy = svc.getIceServers('acc-1');
        const label = JSON.stringify(env);
        assert.equal(c.turnEnabled, legacy.turnEnabled, label);
        assert.equal(c.turnEnabled ? c.turnTtlSec : 0, legacy.ttl, label);
        const iceServers: unknown[] = [{ urls: [...c.stunUrls] }];
        if (c.turnEnabled && c.turnSecret !== null) {
          const username = `${Math.floor(Date.now() / 1000) + c.turnTtlSec}:acc-1`;
          const credential = crypto.createHmac('sha1', c.turnSecret).update(username).digest('base64');
          iceServers.push({ urls: [...c.turnUrls], username, credential });
        }
        assert.deepEqual(iceServers, legacy.iceServers, label);
      }
    );
  }
});

test('PHOBIA_TEST_HOOKS is enabled only by exactly "1"', () => {
  for (const v of ['true', 'yes', ' 1', '01', '0', '']) {
    assert.equal(AppConfig.fromEnv({ PHOBIA_TEST_HOOKS: v }).phobiaTestHooks, false, v);
  }
  assert.equal(AppConfig.fromEnv({ PHOBIA_TEST_HOOKS: '1' }).phobiaTestHooks, true);
});

test('fromEnv defaults to process.env', () => {
  assert.equal(AppConfig.fromEnv().dbPath, process.env['SHARKVOIC_DB_PATH']);
});

test('config is immutable', () => {
  const c = AppConfig.fromEnv({ ADMIN_USERNAMES: 'a', TURN_URLS: 'turn:x' });
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.adminUsernames));
  assert.ok(Object.isFrozen(c.stunUrls));
  assert.ok(Object.isFrozen(c.turnUrls));
  assert.throws(() => {
    (c as { port: number }).port = 1;
  }, TypeError);
  assert.throws(() => (c.adminUsernames as string[]).push('evil'), TypeError);
});

test('constructor copies its input arrays', () => {
  const admins = ['a'];
  const c = new AppConfig({
    port: 1,
    adminUsernames: admins,
    dbPath: ':memory:',
    certsDir: '/c',
    chromePath: null,
    stunUrls: [],
    turnUrls: [],
    turnSecret: null,
    turnTtlSec: 3600,
    phobiaTestHooks: false
  });
  admins.push('b');
  assert.deepEqual(c.adminUsernames, ['a']);
  assert.deepEqual(c.stunUrls, DEFAULT_STUN_URLS);
});
