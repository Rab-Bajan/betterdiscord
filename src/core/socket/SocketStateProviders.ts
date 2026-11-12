/**
 * Contributes top-level keys to the `init:data` payload sent after login
 * (legacy: the `getExtraInitData` getter passed to authHandler, e.g.
 * `{ chessSessions: { [channelId]: snapshot } }`).
 */
export interface InitialStateProvider {
  getInitialState(): Record<string, unknown>;
}

/** One `socket.emit(event, payload)` to perform. */
export interface RoomStateEmission {
  event: string;
  payload: unknown;
}

/**
 * Supplies the room-bound state a socket must receive when it joins a voice
 * channel (legacy: the `onRoomJoined` callback given to voiceHandler, e.g.
 * `{ event: 'watch:state', payload: getWatchSession(channelId) }`).
 */
export interface RoomStateProvider {
  getRoomState(channelId: string): readonly RoomStateEmission[];
}
