import type { Logger } from '../../core/logging/Logger.ts';
import type { BrowserFrame, BrowserLauncher, BrowserPerson, BrowserSession, InputParams, PublicBrowserState } from './types.ts';
import { validateAndSanitizeUrl, type UrlCheck } from './urlSecurity.ts';

export const DEFAULT_URL = 'https://en.wikipedia.org';
/** A session nobody watches is closed after this long. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** A refused browser action; the (Hungarian) message is sent as `browser:error`. */
export class BrowserError extends Error {
  override readonly name = 'BrowserError';
}

/** Where session changes go (socket.io in production). */
export interface BrowserBroadcaster {
  state(channelId: string, state: PublicBrowserState | null): void;
  frame(channelId: string, frame: BrowserFrame): void;
}

/** Timer functions, injectable for tests. */
export interface IdleScheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BrowserServiceDeps {
  chromePath: string | null;
  launcher: BrowserLauncher;
  broadcaster: BrowserBroadcaster;
  /** Scoped `SharedBrowser` so console lines match legacy. */
  logger: Logger;
  validateUrl?: (raw: unknown) => Promise<UrlCheck>;
  scheduler?: IdleScheduler;
  now?: () => number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const ignore = (): void => {};

/**
 * Shared headless browsers, one per voice channel (legacy browserHandler.js). Anyone may
 * steer in `free` mode; in `controller` mode only the current controller. Sessions with no
 * viewers close after {@link IDLE_TIMEOUT_MS}.
 */
export class BrowserService {
  readonly #sessions = new Map<string, BrowserSession>();
  /** Launches in progress, so a concurrent start joins the same browser. */
  readonly #launching = new Map<string, Promise<BrowserSession>>();
  readonly #chromePath: string | null;
  readonly #launcher: BrowserLauncher;
  readonly #broadcaster: BrowserBroadcaster;
  readonly #logger: Logger;
  readonly #validateUrl: (raw: unknown) => Promise<UrlCheck>;
  readonly #scheduler: IdleScheduler;
  readonly #now: () => number;

  constructor(deps: BrowserServiceDeps) {
    this.#chromePath = deps.chromePath;
    this.#launcher = deps.launcher;
    this.#broadcaster = deps.broadcaster;
    this.#logger = deps.logger;
    this.#validateUrl = deps.validateUrl ?? ((raw) => validateAndSanitizeUrl(raw));
    this.#scheduler = deps.scheduler ?? { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.#now = deps.now ?? (() => Date.now());
  }

  /** The startup line legacy printed when the module loaded. */
  logChromeAvailability(): void {
    if (!this.#chromePath) {
      this.#logger.warn('Figyelem: Nem található telepített Google Chrome a gépen! A Shared Browser funkció nem fog tudni elindulni.');
    } else {
      this.#logger.info(`Használt Chrome elérési út: ${this.#chromePath}`);
    }
  }

  get(channelId: unknown): BrowserSession | undefined {
    return typeof channelId === 'string' ? this.#sessions.get(channelId) : undefined;
  }

  publicState(channelId: unknown): PublicBrowserState | null {
    const session = this.get(channelId);
    return session ? toPublicState(session) : null;
  }

  publicStates(): Record<string, PublicBrowserState | null> {
    return Object.fromEntries([...this.#sessions].map(([id, s]) => [id, toPublicState(s)]));
  }

  broadcast(channelId: string): void {
    this.#broadcaster.state(channelId, this.publicState(channelId));
  }

  canInteract(session: BrowserSession, socketId: string): boolean {
    if (!session.active) return false;
    return session.controlMode === 'free' || session.controller?.id === socketId;
  }

  /** Opens the channel's browser (if needed) and adds `viewer`. Throws BrowserError on failure. */
  async start(channelId: string, viewer: BrowserPerson, initialUrl: unknown): Promise<void> {
    const session = this.#sessions.get(channelId) ?? await this.#createOnce(channelId, viewer, initialUrl);
    this.addViewer(session, viewer);
  }

  addViewer(session: BrowserSession, viewer: BrowserPerson): void {
    session.viewers.set(viewer.id, { username: viewer.username, color: viewer.color, joinedAt: this.#now() });
    this.#resetIdleTimer(session);
    this.broadcast(session.channelId);
  }

  /** Removes a viewer; false when the socket was not watching. */
  removeViewer(session: BrowserSession, socketId: string): boolean {
    if (!session.viewers.delete(socketId)) return false;
    this.#resetIdleTimer(session);
    this.broadcast(session.channelId);
    return true;
  }

  /** Navigates to a checked URL; the error message for the client when refused. */
  async navigate(session: BrowserSession, url: unknown): Promise<void> {
    const check = await this.#validateUrl(url);
    if (!check.valid) throw new BrowserError(check.reason || 'Érvénytelen URL cím!');
    session.isLoading = true;
    session.lastActiveAt = this.#now();
    this.broadcast(session.channelId);
    try {
      await session.page.goto(check.url);
    } catch (err) {
      this.#logger.warn(`Navigációs figyelmeztetés (${check.url}):`, errorMessage(err));
    } finally {
      session.isLoading = false;
      session.currentUrl = session.page.url();
      await this.#refreshTitle(session);
      this.broadcast(session.channelId);
    }
  }

  async goBack(session: BrowserSession): Promise<void> {
    await session.page.goBack().catch(ignore);
  }

  async goForward(session: BrowserSession): Promise<void> {
    await session.page.goForward().catch(ignore);
  }

  async reload(session: BrowserSession): Promise<void> {
    await this.#whileLoading(session, () => session.page.reload());
  }

  /** Back to the default start page. */
  async reset(session: BrowserSession): Promise<void> {
    await this.#whileLoading(session, () => session.page.goto(DEFAULT_URL));
  }

  /** Forwards a CDP input event, marking activity unless it is a plain mouse move. */
  async input(session: BrowserSession, kind: 'mouse' | 'key', params: InputParams, active = true): Promise<void> {
    if (active) session.lastActiveAt = this.#now();
    const send = kind === 'mouse' ? session.page.dispatchMouseEvent(params) : session.page.dispatchKeyEvent(params);
    await send.catch(ignore);
  }

  async insertText(session: BrowserSession, text: string): Promise<void> {
    session.lastActiveAt = this.#now();
    await session.page.insertText(text).catch(ignore);
  }

  /** Switches the control mode; entering `controller` mode with no controller makes `person` it. */
  setMode(session: BrowserSession, mode: 'free' | 'controller', person: BrowserPerson): void {
    session.controlMode = mode;
    if (mode === 'controller' && !session.controller) session.controller = person;
    this.broadcast(session.channelId);
  }

  takeControl(session: BrowserSession, person: BrowserPerson): void {
    session.controller = person;
    this.broadcast(session.channelId);
  }

  releaseControl(session: BrowserSession, socketId: string): void {
    if (session.controller?.id !== socketId) return;
    session.controller = null;
    this.broadcast(session.channelId);
  }

  /** Drops the socket from every session it watches or controls. */
  disconnect(socketId: string): void {
    for (const [channelId, session] of this.#sessions) {
      let changed = false;
      if (session.viewers.delete(socketId)) {
        this.#resetIdleTimer(session);
        changed = true;
      }
      if (session.controller?.id === socketId) {
        session.controller = null;
        changed = true;
      }
      if (changed) this.broadcast(channelId);
    }
  }

  /** Closes the channel's browser and tells everyone it is gone. */
  async destroy(channelId: string): Promise<void> {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    session.destroyed = true;
    session.active = false;
    this.#clearIdleTimer(session);
    this.#sessions.delete(channelId);
    await session.page.close();
    this.#broadcaster.state(channelId, null);
    this.#logger.info(`Munkamenet sikeresen leállítva a(z) ${channelId} szobában.`);
  }

  #createOnce(channelId: string, starter: BrowserPerson, initialUrl: unknown): Promise<BrowserSession> {
    let pending = this.#launching.get(channelId);
    if (!pending) {
      pending = this.#create(channelId, starter, initialUrl).finally(() => this.#launching.delete(channelId));
      this.#launching.set(channelId, pending);
    }
    return pending;
  }

  async #create(channelId: string, starter: BrowserPerson, initialUrl: unknown): Promise<BrowserSession> {
    if (!this.#chromePath) throw new BrowserError('A szerveren nem található futtatható Google Chrome böngésző.');
    const check = await this.#validateUrl(initialUrl || DEFAULT_URL);
    if (!check.valid) throw new BrowserError(check.reason || 'Érvénytelen kezdőoldal URL cím.');
    const startingUrl = check.url;
    this.#logger.info(`Böngésző indítása a(z) ${channelId} szobához... Kezdőoldal: ${startingUrl}`);

    let session: BrowserSession | undefined;
    const page = await this.#launcher.launch(this.#chromePath, {
      frame: (frame) => {
        if (!session || session.destroyed) return;
        session.lastFrame = { ...frame, timestamp: this.#now() };
        this.#broadcaster.frame(channelId, frame);
      },
      mainFrameNavigated: (url) => {
        if (!session) return;
        const own = session;
        own.currentUrl = url;
        void this.#refreshTitle(own).then(() => this.broadcast(channelId));
      },
      loaded: () => {
        if (!session) return;
        const own = session;
        own.isLoading = false;
        own.currentUrl = own.page.url();
        void this.#refreshTitle(own).then(() => this.broadcast(channelId));
      },
      disconnected: () => {
        if (session && !session.destroyed) void this.destroy(channelId);
      }
    });
    const now = this.#now();
    session = {
      channelId,
      page,
      currentUrl: startingUrl,
      title: 'Böngésző betöltése...',
      isLoading: true,
      controlMode: 'free',
      controller: null,
      startedBy: starter.username,
      createdAt: now,
      lastActiveAt: now,
      viewers: new Map(),
      lastFrame: null,
      idleTimer: null,
      active: true,
      destroyed: false
    };
    this.#sessions.set(channelId, session);
    const own = session;
    page.goto(startingUrl).catch((err: unknown) => {
      this.#logger.warn(`Betöltési hiba (${startingUrl}):`, errorMessage(err));
      own.isLoading = false;
      this.broadcast(channelId);
    });
    this.#resetIdleTimer(session);
    this.broadcast(channelId);
    return session;
  }

  async #whileLoading(session: BrowserSession, action: () => Promise<void>): Promise<void> {
    session.isLoading = true;
    this.broadcast(session.channelId);
    await action().catch(ignore);
    session.isLoading = false;
    this.broadcast(session.channelId);
  }

  async #refreshTitle(session: BrowserSession): Promise<void> {
    try {
      session.title = await session.page.title();
    } catch {
      // Keep the previous title (page busy or closed).
    }
  }

  #clearIdleTimer(session: BrowserSession): void {
    if (session.idleTimer === null) return;
    this.#scheduler.clear(session.idleTimer);
    session.idleTimer = null;
  }

  #resetIdleTimer(session: BrowserSession): void {
    this.#clearIdleTimer(session);
    if (session.viewers.size > 0) return;
    session.idleTimer = this.#scheduler.set(() => {
      this.#logger.info(`Inaktivitási időkorlát lejárt a(z) ${session.channelId} szobában, böngésző leállítása...`);
      void this.destroy(session.channelId);
    }, IDLE_TIMEOUT_MS);
  }
}

function toPublicState(session: BrowserSession): PublicBrowserState {
  const viewers = Array.from(session.viewers, ([id, info]) => ({ id, username: info.username, color: info.color }));
  return {
    channelId: session.channelId,
    active: session.active,
    currentUrl: session.currentUrl,
    title: session.title,
    isLoading: session.isLoading,
    controlMode: session.controlMode,
    controller: session.controller,
    startedBy: session.startedBy,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    viewers,
    viewerCount: viewers.length
  };
}
