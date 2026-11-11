import path from 'node:path';

/** Environment variables as read by {@link AppConfig.fromEnv}. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Backend root (the directory holding server.js), resolved from this file, not the cwd. */
const BACKEND_ROOT = path.resolve(import.meta.dirname, '../..');

/** Public STUN servers used when STUN_URLS is empty (turnCredentialService.js). */
export const DEFAULT_STUN_URLS: readonly string[] = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
]);

const DEFAULT_PORT = 5000;
const DEFAULT_ADMIN_USERNAMES = 'bajan';
const DEFAULT_TURN_TTL_SEC = 3600;
const MIN_TURN_TTL_SEC = 60;

/** Settings accepted by the {@link AppConfig} constructor. */
export interface AppConfigOptions {
  port: number;
  adminUsernames: readonly string[];
  dbPath: string;
  certsDir: string;
  chromePath: string | null;
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSecret: string | null;
  turnTtlSec: number;
  phobiaTestHooks: boolean;
}

/** Comma-separated list: split, trim, drop empty (turnCredentialService.js `list`). */
function parseList(value: string | undefined): string[] {
  return String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** ADMIN_USERNAMES parsing from state.js: default 'bajan', lower-cased list. */
function parseAdminUsernames(value: string | undefined): string[] {
  return (value || DEFAULT_ADMIN_USERNAMES)
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

/** TURN_TTL parsing from turnCredentialService.js: parseInt, fallback 3600, floor 60. */
function parseTurnTtl(value: string | undefined): number {
  return Math.max(MIN_TURN_TTL_SEC, parseInt(value ?? '', 10) || DEFAULT_TURN_TTL_SEC);
}

/**
 * PORT: unset/empty gives 5000; otherwise must be an integer in 0..65535.
 * Accepted deviation from legacy server.js:8 (`process.env.PORT || 5000`), which passed any
 * string to listen() (so a non-numeric value acted as a pipe path); this throws RangeError instead.
 */
function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid PORT: ${JSON.stringify(value)}`);
  }
  return port;
}

/** Empty or unset becomes null. */
function optional(value: string | undefined): string | null {
  return value ? value : null;
}

/** Immutable application configuration, read and validated once from the environment. */
export class AppConfig {
  /** HTTPS/Socket.IO listen port (validated numeric; stricter than legacy, see parsePort). */
  readonly port: number;
  /** Lower-cased admin usernames. */
  readonly adminUsernames: readonly string[];
  /** SQLite database file. */
  readonly dbPath: string;
  /** Directory holding key.pem / cert.pem. */
  readonly certsDir: string;
  /** Explicit Chrome executable (existence is checked by the browser feature), or null. */
  readonly chromePath: string | null;
  /** STUN URLs; never empty (falls back to {@link DEFAULT_STUN_URLS}). */
  readonly stunUrls: readonly string[];
  /** TURN URLs (may be empty). */
  readonly turnUrls: readonly string[];
  /** coturn static-auth-secret, or null. Never sent to clients. */
  readonly turnSecret: string | null;
  /** TURN credential lifetime in seconds (applies only when TURN is enabled). */
  readonly turnTtlSec: number;
  /** PHOBIA_TEST_HOOKS === '1': enables MiskolcPhobia test hooks for test_room_* ids. */
  readonly phobiaTestHooks: boolean;

  /** Builds a frozen config from explicit values. Prefer {@link AppConfig.fromEnv}. */
  constructor(options: AppConfigOptions) {
    this.port = options.port;
    this.adminUsernames = Object.freeze([...options.adminUsernames]);
    this.dbPath = options.dbPath;
    this.certsDir = options.certsDir;
    this.chromePath = options.chromePath;
    this.stunUrls = Object.freeze([...(options.stunUrls.length ? options.stunUrls : DEFAULT_STUN_URLS)]);
    this.turnUrls = Object.freeze([...options.turnUrls]);
    this.turnSecret = options.turnSecret;
    this.turnTtlSec = options.turnTtlSec;
    this.phobiaTestHooks = options.phobiaTestHooks;
    Object.freeze(this);
  }

  /**
   * Reads and validates the environment once. Throws RangeError on a PORT that is not an
   * integer in 0..65535 (deliberately stricter than legacy, which accepted pipe paths).
   */
  static fromEnv(env: Env = process.env): AppConfig {
    return new AppConfig({
      port: parsePort(env['PORT']),
      adminUsernames: parseAdminUsernames(env['ADMIN_USERNAMES']),
      dbPath: env['SHARKVOIC_DB_PATH'] || path.join(BACKEND_ROOT, 'data', 'sharkvoic.db'),
      certsDir: path.resolve(BACKEND_ROOT, '../certs'),
      chromePath: optional(env['CHROME_PATH']),
      stunUrls: parseList(env['STUN_URLS']),
      turnUrls: parseList(env['TURN_URLS']),
      turnSecret: optional(env['TURN_SECRET']),
      turnTtlSec: parseTurnTtl(env['TURN_TTL']),
      phobiaTestHooks: env['PHOBIA_TEST_HOOKS'] === '1'
    });
  }

  /** Backend root directory (where server.js lives). */
  static get backendRoot(): string {
    return BACKEND_ROOT;
  }

  /** True when TURN credentials can be issued (URLs and a secret are both set). */
  get turnEnabled(): boolean {
    return this.turnUrls.length > 0 && this.turnSecret !== null;
  }

  /** Case-insensitive admin check, same as state.js `isAdminUsername`. */
  isAdmin(name: unknown): boolean {
    return this.adminUsernames.includes(String(name || '').toLowerCase());
  }
}
