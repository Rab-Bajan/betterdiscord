const MAX_SDP_LENGTH = 30_000;
const MAX_CANDIDATE_LENGTH = 1000;
const MAX_SDP_MID_LENGTH = 64;
const MAX_MLINE_INDEX = 256;

/** A WebRTC signal the server relays between the two call participants. */
export type CallSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }
  | { type: 'restart-request' }
  | { type: 'media'; muted: boolean };

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Rebuilds a client signal from its known fields only (legacy callHandler.js `sanitizeSignal`); null if invalid. */
export function sanitizeSignal(signal: unknown): CallSignal | null {
  if (!signal || typeof signal !== 'object') return null;
  const type = field(signal, 'type');
  switch (type) {
    case 'offer':
    case 'answer': {
      const sdp = field(signal, 'sdp');
      return typeof sdp === 'string' && sdp.length > 0 && sdp.length <= MAX_SDP_LENGTH ? { type, sdp } : null;
    }
    case 'candidate':
      return sanitizeCandidate(field(signal, 'candidate'));
    case 'restart-request':
      return { type: 'restart-request' };
    case 'media': {
      const muted = field(signal, 'muted');
      return typeof muted === 'boolean' ? { type: 'media', muted } : null;
    }
    default:
      return null;
  }
}

function sanitizeCandidate(c: unknown): CallSignal | null {
  if (c === null) return { type: 'candidate', candidate: null };
  if (!c) return null;
  const candidate = field(c, 'candidate');
  const sdpMid = field(c, 'sdpMid');
  const sdpMLineIndex = field(c, 'sdpMLineIndex');
  if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LENGTH) return null;
  if (sdpMid != null && (typeof sdpMid !== 'string' || sdpMid.length > MAX_SDP_MID_LENGTH)) return null;
  const validIndex = typeof sdpMLineIndex === 'number' && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex < MAX_MLINE_INDEX;
  if (sdpMLineIndex != null && !validIndex) return null;
  return {
    type: 'candidate',
    candidate: {
      candidate,
      sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
      sdpMLineIndex: validIndex ? sdpMLineIndex : null
    }
  };
}
