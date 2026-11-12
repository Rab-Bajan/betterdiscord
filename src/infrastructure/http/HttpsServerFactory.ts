import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import type { Logger } from '../../core/logging/Logger.ts';

/** PEM key + certificate for the HTTPS server. */
export interface TlsCredentials {
  key: Buffer;
  cert: Buffer;
}

/** Called when the certificates cannot be loaded; production exits the process. */
export type FatalExit = (code: number) => never;

/**
 * Creates the HTTPS server from `<certsDir>/key.pem` and `cert.pem`, with the
 * failure behaviour of legacy server.js: log
 * `[SSL] Hiba a tanúsítványok betöltésekor (<dir>/key.pem, cert.pem): <message>`
 * on console.error and exit with code 1.
 */
export class HttpsServerFactory {
  readonly #certsDir: string;
  readonly #logger: Logger;
  readonly #exit: FatalExit;

  /**
   * @param logger scoped `SSL` by the caller, so the console line matches legacy exactly
   * @param exit defaults to `process.exit`; tests inject a throwing stub
   */
  constructor(certsDir: string, logger: Logger, exit: FatalExit = (code) => process.exit(code)) {
    this.#certsDir = certsDir;
    this.#logger = logger;
    this.#exit = exit;
  }

  /** Reads key.pem and cert.pem synchronously, or logs and exits. */
  loadCredentials(): TlsCredentials {
    try {
      return {
        key: fs.readFileSync(path.join(this.#certsDir, 'key.pem')),
        cert: fs.readFileSync(path.join(this.#certsDir, 'cert.pem'))
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.error(`Hiba a tanúsítványok betöltésekor (${this.#certsDir}/key.pem, cert.pem):`, message);
      return this.#exit(1);
    }
  }

  /** HTTPS server serving `handler` (not listening yet). */
  create(handler: RequestListener): https.Server {
    return https.createServer(this.loadCredentials(), handler);
  }
}
