import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import https from 'node:https';
import { HttpsServerFactory, createExpressApp, JSON_BODY_LIMIT } from '../../../src/infrastructure/http/index.ts';
import { Logger } from '../../../src/core/logging/index.ts';
import type { LogRecord } from '../../../src/core/logging/index.ts';
import { createTestCerts } from '../support/TestApp.ts';

let certsDir = '';
before(async () => { certsDir = await createTestCerts(); });

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) { super(`exit(${code})`); this.code = code; }
}
const throwingExit = (code: number): never => { throw new ExitCalled(code); };

test('missing certificates: legacy log line on console.error, then exit(1)', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-certs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const factory = new HttpsServerFactory(dir, new Logger().child('SSL'), throwingExit);
  assert.throws(() => factory.loadCredentials(), (err: unknown) => err instanceof ExitCalled && err.code === 1);
  const args = error.mock.calls[0]?.arguments ?? [];
  assert.equal(args[0], `[SSL] Hiba a tanúsítványok betöltésekor (${dir}/key.pem, cert.pem):`);
  assert.match(String(args[1]), /^ENOENT: no such file or directory, open '.*key\.pem'$/);
});

test('missing cert.pem only is also fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'half-certs-'));
  fs.copyFileSync(path.join(certsDir, 'key.pem'), path.join(dir, 'key.pem'));
  const logs: LogRecord[] = [];
  const factory = new HttpsServerFactory(dir, new Logger({ sink: (r) => { logs.push(r); } }), throwingExit);
  assert.throws(() => factory.loadCredentials(), ExitCalled);
  assert.match(String(logs[0]?.args[0]), /cert\.pem/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('valid certificates: HTTPS server serving the Express app with cors + json limit', async (t) => {
  const app = createExpressApp();
  app.post('/echo', (req, res) => { res.json({ got: req.body as unknown }); });
  const server = new HttpsServerFactory(certsDir, new Logger(), throwingExit).create(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  const post = (body: string): Promise<{ status: number; cors: string | undefined; body: string }> =>
    new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, path: '/echo', method: 'POST', rejectUnauthorized: false,
        headers: { 'content-type': 'application/json', origin: 'https://x.test' } }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cors: res.headers['access-control-allow-origin'] as string | undefined, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const ok = await post('{"a":1}');
  assert.equal(ok.status, 200);
  assert.equal(ok.cors, '*');
  assert.deepEqual(JSON.parse(ok.body), { got: { a: 1 } });
  assert.equal(JSON_BODY_LIMIT, '512kb');
  const tooBig = await post(JSON.stringify({ s: 'x'.repeat(600 * 1024) }));
  assert.equal(tooBig.status, 413);
});
