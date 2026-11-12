/** Stored playback state of one channel's watch party (legacy watchPartyHandler.js). */
export interface WatchState {
  active: true;
  channelId: string;
  service: 'youtube';
  url: string;
  videoId: string;
  title: string;
  isPlaying: boolean;
  /** Position in seconds at `lastUpdated`. */
  currentTime: number;
  lastUpdated: number;
  startedBy: string;
  updatedBy: string;
}

/** State as sent to clients: `currentTime` advanced to now while playing, plus the server clock. */
export interface LiveWatchState extends WatchState {
  serverTime: number;
}

/** `watch:update-media` fields (raw values from the client). */
export interface MediaInput {
  url: unknown;
  videoId: unknown;
  title: unknown;
}

/** `watch:sync-event` payload for the other viewers. */
export interface SyncEvent {
  action: unknown;
  currentTime: number;
  timestamp: number;
  triggeredBy: string;
}

/** What other modules consume (legacy watchPartyHandler return value). */
export interface WatchPartyApi {
  getWatchSessions(): Record<string, LiveWatchState>;
  getWatchSession(channelId: string): LiveWatchState | null;
}
