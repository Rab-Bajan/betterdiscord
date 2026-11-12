// Typed surface of the legacy CommonJS modules, as far as the composition root uses it.
// Each interface lists only the members server.js touches; the objects carry more.

import type { Express } from 'express';
import type { Server, Socket } from 'socket.io';
import type { PresenceUser } from '../../modules/presence/UserRegistry.ts';

export type UsersMap = Map<string, PresenceUser>;

/** state.js */
export interface LegacyState {
  users: UsersMap;
}

/** Object returned by a factory; opaque except for the members listed per module. */
export interface LegacyChat { getChannelMessages(): unknown }
export interface LegacyCasino { getCasinoSessions(): unknown; admin: LegacyCasinoAdmin }
/** `casino.admin` (casinoHandler.js), used by the admin module; results are passed through to the ack. */
export interface LegacyCasinoAdmin {
  listAccounts(): unknown;
  setBalance(playerId: string, balance: unknown, freeSpins: unknown): unknown;
  setRig(playerId: string, rig: unknown): unknown;
}
export interface LegacyWatchParty { getWatchSessions(): unknown; getWatchSession(channelId: string): unknown }
export interface LegacyChess { getChessSessions(): unknown; admin: LegacyChessAdmin }
/** `chess.admin` (chessHandler.js), used by the admin module; results are passed through to the ack. */
export interface LegacyChessAdmin {
  forceMove(channelId: unknown, from: unknown, to: unknown, switchTurn: boolean): unknown;
  putPiece(channelId: unknown, square: unknown, piece: unknown): unknown;
  setTurn(channelId: unknown, turn: unknown): unknown;
}
export interface LegacyCodeEditor { getProject(channelId: string): unknown }
/** dmHandler.js return value; admin uses `notifyMessageRemoved`. */
export interface LegacyDm {
  getDmKey(idA: unknown, idB: unknown): string;
  notifyMessageRemoved(dmKey: string, messageId: string): void;
}
export interface LegacyBrowser { getBrowserSessions(): unknown; getBrowserSession(channelId: string): unknown }
export interface LegacyWhiteboard { getBoardList(channelId: string): unknown }
export interface LegacyGame { getSession(channelId: string): unknown }
export interface LegacyEmpire { getSession(channelId: string): unknown; getEmpireSessions(): unknown }
export interface LegacyPhobia {
  getSession(channelId: string): unknown;
  getPhobiaSessions(): unknown;
  handleUserSpeaking(socketId: string, isSpeaking: boolean): void;
  /** The 12 Hz tick loop; not unref'd, so it must be cleared on shutdown. */
  tickInterval: NodeJS.Timeout;
}

/** Factory signatures, exactly as server.js calls them. */
export type CasinoFactory = (io: Server, app: Express, casinoDir: string) => LegacyCasino;
export type AppUsersFactory<T> = (io: Server, app: Express, users: UsersMap) => T;
export type UsersFactory<T> = (io: Server, users: UsersMap) => T;
export type IoFactory<T> = (io: Server) => T;
export type GameFactory = (io: Server, options: { users: UsersMap }) => LegacyGame;
export type VoiceFactory = (
  io: Server,
  onRoomJoined: (socket: Socket, channelId: string) => void,
  onUserSpeaking: (socketId: string, isSpeaking: boolean) => void
) => void;
export type AuthFactory = (io: Server, getExtraInitData: () => Record<string, unknown>) => void;
export type AdminFactory = (io: Server, modules: { casino: LegacyCasino; chess: LegacyChess; dm: LegacyDm }) => void;

/** httpRoutes.js */
export interface LegacyHttpRoutes {
  setupApiRoutes(app: Express): void;
  serveFrontend(app: Express): void;
}

/** analysis/routes.js */
export interface LegacyAnalysisRoutes {
  setupAnalysisRoutes(app: Express): void;
}

/** Modules whose getters feed the room-state and init-data providers. */
export interface LegacyStateSources {
  chat: LegacyChat;
  casino: LegacyCasino;
  watchParty: LegacyWatchParty;
  chess: LegacyChess;
  codeEditor: LegacyCodeEditor;
  browser: LegacyBrowser;
  whiteboard: LegacyWhiteboard;
  game: LegacyGame;
  empire: LegacyEmpire;
  phobia: LegacyPhobia;
}
