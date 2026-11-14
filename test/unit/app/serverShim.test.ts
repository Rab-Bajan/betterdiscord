import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { createTestCerts } from '../support/TestApp.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

const getStatus = (port: number): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: '/api/status', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });

test('`node server.js` boots the new Application (PORT and CERTS_DIR from env)', { timeout: 30_000 }, async (t) => {
  const certsDir = await createTestCerts();
  const child = spawn(process.execPath,
    ['--import', './test/support/isolatedDb.cjs', '--require', './test/support/loopbackListen.cjs', 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: '0', CERTS_DIR: certsDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no startup line\n${out}\n${stderr}`)), 20_000);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      const match = /^>>> Discord VoIP & Chat Backend \(HTTPS\) fut: https:\/\/localhost:(\d+)$/m.exec(out);
      if (match?.[1]) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', (code) => reject(new Error(`server.js exited early (${code})\n${out}\n${stderr}`)));
  });
  assert.ok(port > 0);
  const res = await getStatus(port);
  assert.equal(res.status, 200);
  assert.equal((JSON.parse(res.body) as { status: string }).status, 'online');

  // SIGTERM (systemd stop) exits 0 quickly, even with a connected socket.io client.
  const client = connect(`https://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, rejectUnauthorized: false, reconnection: false });
  t.after(() => { client.close(); });
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  const started = Date.now();
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started < 5000, 'within the shutdown timeout');
});

test('`node server.js` with no certificates logs the legacy [SSL] line and exits 1', { timeout: 20_000 }, async (t) => {
  const missing = path.join(ROOT, 'test', 'support', 'no-such-certs-dir');
  const child = spawn(process.execPath, ['--import', './test/support/isolatedDb.cjs', 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: '0', CERTS_DIR: missing }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`\\[SSL\\] Hiba a tanúsítványok betöltésekor \\(${missing.replace(/[/.]/g, '\\$&')}/key\\.pem, cert\\.pem\\): ENOENT`));
});

test('`node server.js` with an invalid PORT exits 1 (not 0)', { timeout: 20_000 }, async (t) => {
  const child = spawn(process.execPath, ['--import', './test/support/isolatedDb.cjs', 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: 'abc' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /Startup failed: RangeError: Invalid PORT: "abc"/);
});
