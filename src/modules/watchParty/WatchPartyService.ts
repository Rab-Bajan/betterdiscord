import type { LiveWatchState, MediaInput, SyncEvent, WatchState } from './types.ts';

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const DEFAULT_TITLE = 'YouTube Videó';
const COUNTDOWN_MS = 3000;

const isValidTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Synchronised YouTube playback per voice channel (legacy watchPartyHandler.js). Positions
 * are stored with their timestamp, so a late joiner gets the live position, not the start.
 */
export class WatchPartyService {
  readonly #sessions = new Map<string, WatchState>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Live state of `channelId`, or null without a session. */
  getSession(channelId: unknown): LiveWatchState | null {
    const state = typeof channelId === 'string' ? this.#sessions.get(channelId) : undefined;
    return state ? this.#live(state) : null;
  }

  /** Every session's live state, keyed by channel id. */
  getSessions(): Record<string, LiveWatchState> {
    return Object.fromEntries([...this.#sessions].map(([id, s]) => [id, this.#live(s)]));
  }

  /** Starts (or replaces) the channel's video; null when `videoId` is not a YouTube id. */
  start(channelId: string, username: string, media: MediaInput): LiveWatchState | null {
    const videoId = media.videoId || '';
    if (typeof videoId !== 'string' || !YOUTUBE_ID_RE.test(videoId)) return null;
    const state: WatchState = {
      active: true,
      channelId,
      service: 'youtube',
      url: typeof media.url === 'string' ? media.url : '',
      videoId,
      title: typeof media.title === 'string' && media.title ? media.title : DEFAULT_TITLE,
      isPlaying: true,
      currentTime: 0,
      lastUpdated: this.#now(),
      startedBy: username,
      updatedBy: username
    };
    this.#sessions.set(channelId, state);
    return this.#live(state);
  }

  /**
   * Play / pause / seek. Without a valid `currentTime` the live position is kept. Returns the
   * sync event for the other viewers and the new live state, or null without a session.
   */
  control(channelId: string, action: unknown, currentTime: unknown, username: string): { sync: SyncEvent; state: LiveWatchState } | null {
    const state = this.#sessions.get(channelId);
    if (!state) return null;
    state.currentTime = isValidTime(currentTime) ? currentTime : this.#position(state, this.#now());
    state.lastUpdated = this.#now();
    if (action === 'play') state.isPlaying = true;
    if (action === 'pause') state.isPlaying = false;
    state.updatedBy = username;
    const sync: SyncEvent = { action, currentTime: state.currentTime, timestamp: this.#now(), triggeredBy: username };
    return { sync, state: this.#live(state) };
  }

  stop(channelId: string): void {
    this.#sessions.delete(channelId);
  }

  /** Start time of a shared 3-2-1 countdown. */
  countdownTarget(): number {
    return this.#now() + COUNTDOWN_MS;
  }

  /** Position at `now`: the stored one plus the time played since. */
  #position(state: WatchState, now: number): number {
    const elapsed = state.isPlaying ? Math.max(0, (now - state.lastUpdated) / 1000) : 0;
    return state.currentTime + elapsed;
  }

  #live(state: WatchState): LiveWatchState {
    const now = this.#now();
    return { ...state, currentTime: this.#position(state, now), serverTime: now };
  }
}
