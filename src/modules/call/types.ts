/** Lifecycle of a live call: ringing -> connecting -> connected -> ended. */
export type CallStatus = 'ringing' | 'connecting' | 'connected' | 'ended';

/** Side of a call an account is on. */
export type CallRole = 'caller' | 'callee';

/** Timers a call can have running (one per name). */
export type CallTimer = 'ring' | 'connect' | 'grace_caller' | 'grace_callee';

/** An account taking part in a call. */
export interface CallParty {
  accountId: string;
  username: string;
}

/** A live call (in memory only; finished calls are written to the call history). */
export interface Call {
  readonly id: string;
  readonly callerAccountId: string;
  readonly callerUsername: string;
  readonly calleeAccountId: string;
  readonly calleeUsername: string;
  /** Device bound to each side; null while that side is reconnecting (or before the callee answers). */
  callerSocketId: string | null;
  calleeSocketId: string | null;
  status: CallStatus;
  readonly createdAt: number;
  answeredAt: number | null;
  connectedAt: number | null;
  endedAt: number | null;
}

/** How a call ended, as logged and shown in the DM. */
export interface CallResult {
  status: string;
  endReason: string;
  durationSec: number;
}

/** Minimal description of a finished call, enough for its DM system message. */
export interface CallSummary {
  id: string;
  callerAccountId: string;
  calleeAccountId: string;
}

/** STUN/TURN configuration handed to a participant. */
export interface IceConfig {
  iceServers: Array<{ urls: readonly string[]; username?: string; credential?: string }>;
  ttl: number;
  turnEnabled: boolean;
}

/** Public account fields shown to the other party. */
export interface CallProfile {
  accountId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
}
