import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppConfig } from '../../../src/config/AppConfig.ts';

test('CERTS_DIR overrides the legacy <backend>/../certs default (resolved to absolute)', () => {
  assert.equal(AppConfig.fromEnv({}).certsDir, path.resolve(AppConfig.backendRoot, '../certs'));
  assert.equal(AppConfig.fromEnv({ CERTS_DIR: '' }).certsDir, path.resolve(AppConfig.backendRoot, '../certs'));
  assert.equal(AppConfig.fromEnv({ CERTS_DIR: 'rel/certs' }).certsDir, path.resolve('rel/certs'));
  assert.equal(AppConfig.fromEnv({ CERTS_DIR: '/etc/x' }).certsDir, '/etc/x');
});
