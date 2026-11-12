// Reusable end-to-end harness: boots the full Application on 127.0.0.1:<ephemeral> with a
// throwaway self-signed certificate and the per-run SQLite file from test/support/isolatedDb.cjs.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { io as connect } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { Application } from '../../../src/app/Application.ts';
import { AppConfig } from '../../../src/config/AppConfig.ts';
import { Logger } from '../../../src/core/logging/Logger.ts';
import type { LogRecord } from '../../../src/core/logging/Logger.ts';
import type { ModuleOverrides } from '../../../src/app/modules/ModuleFactory.ts';

/** Creates key.pem + cert.pem for localhost in a fresh tmp dir (removed on process exit). */
export async function createTestCerts(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharkvoic-certs-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 });
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  return dir;
}

/**
 * Resolves with the next `event` payload on `socket` that satisfies `accept`
 * (default: any), or rejects after `timeoutMs`.
 */
export function waitFor<T = unknown>(
  socket: ClientSocket,
  event: string,
  accept: (payload: T) => boolean = () => true,
  timeoutMs = 3000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    const onEvent = (payload: T): void => {
      if (!accept(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    socket.on(event, onEvent);
  });
}

/** Simple HTTPS GET against the app (self-signed cert accepted). */
export interface HttpResult { status: number; body: string }

/**
 * One booted Application plus helpers. Legacy modules keep module-level
 * state, so use one TestApp per test file (each file runs in its own process).
 */
export class TestApp {
  readonly app: Application;
  readonly port: number;
  /** Records logged through the Application logger (legacy console output is not captured). */
  readonly logs: LogRecord[];
  readonly #clients: ClientSocket[] = [];

  private constructor(app: Application, port: number, logs: LogRecord[]) {
    this.app = app;
    this.port = port;
    this.logs = logs;
  }

  /** Boots the Application on 127.0.0.1 with an ephemeral port and fresh certs. */
  static async start(options: { moduleOverrides?: ModuleOverrides } = {}): Promise<TestApp> {
    const certsDir = await createTestCerts();
    const config = new AppConfig({ ...AppConfig.fromEnv(), port: 0, certsDir });
    const logs: LogRecord[] = [];
    const logger = new Logger({ minLevel: 'debug', sink: (record) => { logs.push(record); } });
    const exit = (code: number): never => { throw new Error(`Application requested exit(${code})`); };
    const app = new Application({ config, logger, host: '127.0.0.1', exit, ...options });
    const { port } = await app.start();
    return new TestApp(app, port, logs);
  }

  get url(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  /** Connected socket.io client (websocket transport, self-signed cert accepted). */
  async connectClient(): Promise<ClientSocket> {
    const client = connect(this.url, { transports: ['websocket'], forceNew: true, rejectUnauthorized: false, reconnection: false });
    this.#clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  }

  /** Connects and logs in as a guest; resolves with the client and its `init:data`. */
  async joinAsGuest(username: string): Promise<{ client: ClientSocket; init: Record<string, unknown> }> {
    const client = await this.connectClient();
    const init = waitFor<Record<string, unknown>>(client, 'init:data');
    client.emit('user:join', { username });
    return { client, init: await init };
  }

  /** HTTPS GET `pathname`. */
  get(pathname: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      https.get(`${this.url}${pathname}`, { rejectUnauthorized: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
  }

  /** Disconnects every client and stops the Application. */
  async stop(): Promise<void> {
    for (const client of this.#clients) client.close();
    await this.app.stop();
  }
}
