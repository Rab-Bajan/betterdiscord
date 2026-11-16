import path from 'node:path';
import type { LegacyModuleName, ModuleDeps, ModuleFactory, ModuleRegistration } from '../modules/ModuleFactory.ts';
import type * as L from './legacyModules.ts';

type LegacyDefinitions = { [N in LegacyModuleName]: ModuleFactory<N> };

/** Runs a legacy `io.on('connection')` factory behind an adapter. */
function legacy<T>(deps: ModuleDeps, build: (io: ModuleDeps['io']) => T): ModuleRegistration<T> {
  const adapter = deps.createLegacyAdapter();
  return { controller: adapter, api: build(adapter.io) };
}

const appUsers = <T>(id: string) => (deps: ModuleDeps): ModuleRegistration<T> =>
  legacy(deps, (io) => deps.loadLegacy<L.AppUsersFactory<T>>(id)(io, deps.app, deps.usersMap));
const ioUsers = <T>(id: string) => (deps: ModuleDeps): ModuleRegistration<T> =>
  legacy(deps, (io) => deps.loadLegacy<L.UsersFactory<T>>(id)(io, deps.usersMap));
const ioOnly = <T>(id: string) => (deps: ModuleDeps): ModuleRegistration<T> =>
  legacy(deps, (io) => deps.loadLegacy<L.IoFactory<T>>(id)(io));

const withRoomState = <T>(factory: ModuleFactory, event: string, read: (api: T, channelId: string) => unknown) =>
  (deps: ModuleDeps): ModuleRegistration<T> => {
    const reg = factory(deps) as ModuleRegistration<T>;
    return { ...reg, roomStateProvider: { getRoomState: (channelId) => [{ event, payload: read(reg.api, channelId) }] } };
  };

/**
 * The unmodified legacy modules, each with exactly the factory arguments,
 * providers and cross-wiring of legacy server.js.
 */
export const LEGACY_DEFINITIONS: LegacyDefinitions = {
  casino: (deps) => {
    const reg = legacy(deps, (io) =>
      deps.loadLegacy<L.CasinoFactory>('./casinoHandler')(io, deps.app, path.resolve(deps.backendRoot, 'casino')));
    return { ...reg, initialStateProvider: { getInitialState: () => ({ casinoSessions: reg.api.getCasinoSessions() }) } };
  },
  watchParty: (deps) => {
    const reg = appUsers<L.LegacyWatchParty>('./watchPartyHandler')(deps);
    return {
      ...reg,
      initialStateProvider: { getInitialState: () => ({ watchSessions: reg.api.getWatchSessions() }) },
      roomStateProvider: { getRoomState: (id) => [{ event: 'watch:state', payload: reg.api.getWatchSession(id) }] }
    };
  },
  chess: (deps) => {
    const reg = appUsers<L.LegacyChess>('./chessHandler')(deps);
    return { ...reg, initialStateProvider: { getInitialState: () => ({ chessSessions: reg.api.getChessSessions() }) } };
  },
  codeEditor: withRoomState<L.LegacyCodeEditor>(ioUsers('./codeEditorHandler'), 'code:tree-data', (api, id) => api.getProject(id)),
  dm: ioUsers<L.LegacyDm>('./dmHandler'),
  browser: (deps) => {
    const reg = appUsers<L.LegacyBrowser>('./browserHandler')(deps);
    return {
      ...reg,
      initialStateProvider: { getInitialState: () => ({ browserSessions: reg.api.getBrowserSessions() }) },
      roomStateProvider: { getRoomState: (id) => [{ event: 'browser:state', payload: reg.api.getBrowserSession(id) }] }
    };
  },
  call: ioOnly<unknown>('./callHandler'),
  chat: (deps) => {
    const reg = ioOnly<L.LegacyChat>('./chatHandler')(deps);
    return { ...reg, initialStateProvider: { getInitialState: () => ({ channelMessages: reg.api.getChannelMessages() }) } };
  },
  whiteboard: withRoomState<L.LegacyWhiteboard>(ioOnly('./whiteboardHandler'), 'whiteboard:list', (api, id) => api.getBoardList(id)),
  game: withRoomState<L.LegacyGame>(
    (deps) => legacy(deps, (io) => deps.loadLegacy<L.GameFactory>('./game/gameHandler')(io, { users: deps.usersMap })),
    'game:session-updated', (api, channelId) => ({ channelId, state: api.getSession(channelId) })),
  empire: (deps) => {
    const reg = legacy(deps, (io) =>
      deps.loadLegacy<{ setupMiskolcEmpire: L.UsersFactory<L.LegacyEmpire> }>('./miskolcEmpireHandler').setupMiskolcEmpire(io, deps.usersMap));
    return {
      ...reg,
      initialStateProvider: { getInitialState: () => ({ empireSessions: reg.api.getEmpireSessions() }) },
      roomStateProvider: { getRoomState: (channelId) => [{ event: 'empire:session-updated', payload: { channelId, state: reg.api.getSession(channelId) } }] }
    };
  },
  phobia: (deps) => {
    const reg = legacy(deps, (io) =>
      deps.loadLegacy<{ setupMiskolcPhobia: L.UsersFactory<L.LegacyPhobia> }>('./miskolcPhobiaHandler').setupMiskolcPhobia(io, deps.usersMap));
    return {
      ...reg,
      initialStateProvider: { getInitialState: () => ({ phobiaSessions: reg.api.getPhobiaSessions() }) },
      roomStateProvider: { getRoomState: (channelId) => [{ event: 'phobia:session-updated', payload: { channelId, state: reg.api.getSession(channelId) } }] }
    };
  },
  speedTest: ioOnly<unknown>('./speedTestHandler'),
  voice: (deps) => legacy(deps, (io) => deps.loadLegacy<L.VoiceFactory>('./voiceHandler')(
    io,
    (socket, channelId) => deps.socketServer.emitRoomState(socket, channelId),
    (socketId, isSpeaking) => deps.module('phobia').handleUserSpeaking(socketId, isSpeaking)
  )),
  auth: (deps) => legacy(deps, (io) =>
    deps.loadLegacy<L.AuthFactory>('./authHandler')(io, () => deps.socketServer.buildInitialState())),
  admin: (deps) => legacy(deps, (io) => deps.loadLegacy<L.AdminFactory>('./adminHandler')(io, {
    casino: deps.module('casino'), chess: deps.module('chess'), dm: deps.module('dm')
  }))
};
