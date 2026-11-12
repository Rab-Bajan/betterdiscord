import { createHmac } from 'node:crypto';
import type { AppConfig } from '../../config/AppConfig.ts';
import type { IceConfig } from './types.ts';

/** The AppConfig settings the TURN service reads. */
export type IceSettings = Pick<AppConfig, 'stunUrls' | 'turnUrls' | 'turnSecret' | 'turnTtlSec'>;

/**
 * ICE servers for a call (legacy turnCredentialService.js). TURN credentials are short-lived
 * (coturn `use-auth-secret` / TURN REST API): username = `<expiry>:<account>`, credential =
 * base64 HMAC-SHA1(secret, username). The secret itself never leaves the server.
 */
export class TurnCredentialService {
  readonly #settings: IceSettings;
  readonly #now: () => number;

  constructor(settings: IceSettings, now: () => number = () => Date.now()) {
    this.#settings = settings;
    this.#now = now;
  }

  getIceServers(accountId: string): IceConfig {
    const { stunUrls, turnUrls, turnSecret, turnTtlSec } = this.#settings;
    const iceServers: IceConfig['iceServers'] = [{ urls: [...stunUrls] }];
    if (turnUrls.length === 0 || !turnSecret) return { iceServers, ttl: 0, turnEnabled: false };
    const username = `${Math.floor(this.#now() / 1000) + turnTtlSec}:${accountId.replace(/[^\w-]/g, '')}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    iceServers.push({ urls: [...turnUrls], username, credential });
    return { iceServers, ttl: turnTtlSec, turnEnabled: true };
  }
}
