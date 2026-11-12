/** A viewer or the controller of a shared browser. */
export interface BrowserPerson {
  id: string;
  username: string;
  color: string;
}

export type ControlMode = 'free' | 'controller';

/** One screencast frame (JPEG, base64) with its CDP metadata. */
export interface BrowserFrame {
  data: string;
  metadata: unknown;
}

/** CDP input event parameters, forwarded as given. */
export type InputParams = Record<string, unknown>;

/** The live page of a shared browser, independent of the automation library. */
export interface RemotePage {
  goto(url: string, timeoutMs?: number): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  url(): string;
  title(): Promise<string>;
  dispatchMouseEvent(params: InputParams): Promise<void>;
  dispatchKeyEvent(params: InputParams): Promise<void>;
  insertText(text: string): Promise<void>;
  /** Stops the screencast and closes the page and the browser; never rejects. */
  close(): Promise<void>;
}

/** Page events a launcher reports to the session that owns the page. */
export interface PageEvents {
  frame(frame: BrowserFrame): void;
  mainFrameNavigated(url: string): void;
  loaded(): void;
  disconnected(): void;
}

/** Starts a headless browser on a page that streams frames (puppeteer in production). */
export interface BrowserLauncher {
  launch(executablePath: string, events: PageEvents): Promise<RemotePage>;
}

/** The shared browser of one voice channel. */
export interface BrowserSession {
  channelId: string;
  page: RemotePage;
  currentUrl: string;
  title: string;
  isLoading: boolean;
  controlMode: ControlMode;
  controller: BrowserPerson | null;
  startedBy: string;
  createdAt: number;
  lastActiveAt: number;
  viewers: Map<string, { username: string; color: string; joinedAt: number }>;
  lastFrame: (BrowserFrame & { timestamp: number }) | null;
  idleTimer: unknown;
  active: boolean;
  destroyed: boolean;
}

/** Client view of a session (`browser:state`, `browser:session-updated`, init `browserSessions`). */
export interface PublicBrowserState {
  channelId: string;
  active: boolean;
  currentUrl: string;
  title: string;
  isLoading: boolean;
  controlMode: ControlMode;
  controller: BrowserPerson | null;
  startedBy: string;
  createdAt: number;
  lastActiveAt: number;
  viewers: BrowserPerson[];
  viewerCount: number;
}

/** What other modules consume (legacy browserHandler return value). */
export interface BrowserApi {
  getBrowserSessions(): Record<string, PublicBrowserState | null>;
  getBrowserSession(channelId: string): PublicBrowserState | null;
  destroySession(channelId: string): Promise<void>;
}
