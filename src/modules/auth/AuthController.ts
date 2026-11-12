import type { Socket } from 'socket.io';
import type { TextChannel, VoiceChannel } from '../../config/channels.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import { PayloadReader } from '../../core/validation/PayloadReader.ts';
import type { Broadcaster } from '../presence/PresenceService.ts';
import type { PresenceUser } from '../presence/UserRegistry.ts';
import { legacyFields } from '../shared/legacyPayload.ts';
import type { AuthService } from './AuthService.ts';
import type { AuthResult, ProfileInput, SessionData } from './types.ts';
import type { UserSessionService } from './UserSessionService.ts';

const DEFAULT_AVATAR_COLOR = '#7655F5';

/** Presence views auth needs (satisfied by PresenceService). */
export interface PresenceView {
  getVoiceChannelState(): unknown;
  getOnlineUsersList(): unknown;
  broadcastPresence(io: Broadcaster): void;
}

export interface AuthControllerDeps {
  auth: AuthService;
  sessions: UserSessionService;
  presence: PresenceView;
  /** Broadcast target for presence updates (the socket.io Server). */
  io: Broadcaster;
  /** Extra `init:data` keys from the other modules (SocketServer.buildInitialState). */
  buildInitialState: () => Record<string, unknown>;
  textChannels: readonly TextChannel[];
  voiceChannels: readonly VoiceChannel[];
  /** Receives the legacy console lines verbatim and handler failures. */
  logger: Logger;
}

/**
 * Socket events of legacy authHandler.js: auth:register, auth:login, auth:verify-token,
 * auth:logout, user:join (guest), user:update-profile and disconnect cleanup.
 *
 * Payload rules: a missing/null payload is rejected (legacy destructuring threw);
 * absent or empty string fields count as not given (legacy `x || default`); a field of
 * another type is rejected (legacy either threw or wrote it to SQLite unchecked).
 */
export class AuthController extends SocketController {
  readonly #deps: AuthControllerDeps;

  constructor(deps: AuthControllerDeps) {
    super(deps.logger);
    this.#deps = deps;
  }

  register(socket: Socket): void {
    const { auth, sessions, logger } = this.#deps;
    logger.info(`[Socket HTTPS] Csatlakozott kliens: ${socket.id}`);

    this.listen(socket, 'auth:register', (payload) => {
      const r = new PayloadReader(legacyFields(payload));
      this.#startAuthedSession(socket, auth.register({
        username: r.optionalString('username'),
        password: r.optionalString('password'),
        avatarColor: r.optionalString('avatarColor'),
        avatarUrl: r.optionalString('avatarUrl')
      }));
    });

    this.listen(socket, 'auth:login', (payload) => {
      const r = new PayloadReader(legacyFields(payload));
      this.#startAuthedSession(socket, auth.login({ username: r.optionalString('username'), password: r.optionalString('password') }));
    });

    this.listen(socket, 'auth:verify-token', (payload) => {
      const res = auth.verifyToken(new PayloadReader(legacyFields(payload)).optionalString('token'));
      if (!res.success) {
        socket.emit('auth:token-invalid', { error: res.error });
        return;
      }
      this.#startAuthedSession(socket, res);
    });

    this.listen(socket, 'auth:logout', (payload) => {
      auth.logout(new PayloadReader(legacyFields(payload)).optionalString('token'));
      if (sessions.end(socket.id)) this.#broadcastPresence();
    });

    this.listen(socket, 'user:join', (payload) => {
      const r = new PayloadReader(legacyFields(payload));
      const username = r.optionalString('username');
      const avatarColor = r.optionalString('avatarColor');
      const avatarUrl = r.optionalString('avatarUrl');
      const accountId = r.optionalString('accountId');
      this.#establishUserSession(socket, {
        accountId: accountId || null,
        username: (username || `Felhasználó_${socket.id.substring(0, 4)}`).trim(),
        avatarColor: avatarColor || DEFAULT_AVATAR_COLOR,
        avatarUrl: avatarUrl || null
      });
    });

    this.listen(socket, 'user:update-profile', (payload) => {
      const input = this.#readProfile(payload);
      const user = sessions.get(socket.id);
      if (!user) return;

      const res = auth.updateProfile(user.accountId, input);
      if (!res.success) {
        socket.emit('profile:error', { error: res.error });
        return;
      }
      sessions.applyProfile(user, res.user);
      socket.emit('user:profile-updated', user);
      this.#broadcastPresence();
      logger.info(`[User] Profil módosítva: ${user.username} (${socket.id})`);
    });

    this.listen(socket, 'disconnect', () => {
      const user = sessions.get(socket.id);
      if (!user) return;
      if (user.voiceChannel) {
        socket.to(user.voiceChannel).emit('voice:peer-left', { peerId: socket.id });
      }
      sessions.end(socket.id);
      this.#broadcastPresence();
      logger.info(`[User] Kilépett: ${user.username} (${socket.id})`);
    });
  }

  /** `avatarUrl` keeps the null/'' vs absent distinction legacy relied on. */
  #readProfile(payload: unknown): ProfileInput {
    const fields = legacyFields(payload);
    const r = new PayloadReader(fields);
    const avatarUrl = fields['avatarUrl'] === null ? null : r.optionalString('avatarUrl', { allowEmpty: true });
    return { username: r.optionalString('username'), avatarColor: r.optionalString('avatarColor'), avatarUrl };
  }

  #establishUserSession(socket: Socket, data: SessionData): PresenceUser {
    const { sessions, presence, textChannels, voiceChannels, buildInitialState, logger } = this.#deps;
    const user = sessions.establish(socket.id, data);
    socket.emit('init:data', {
      self: user,
      textChannels,
      voiceChannels,
      voiceStates: presence.getVoiceChannelState(),
      onlineUsers: presence.getOnlineUsersList(),
      ...buildInitialState()
    });
    this.#broadcastPresence();
    logger.info(`[User] Belépett: ${user.username} (${socket.id})`);
    return user;
  }

  #startAuthedSession(socket: Socket, res: AuthResult): void {
    if (!res.success) {
      socket.emit('auth:error', { error: res.error });
      return;
    }
    const sessionUser = this.#establishUserSession(socket, {
      authenticated: true,
      accountId: res.user.id,
      username: res.user.username,
      avatarColor: res.user.avatarColor,
      avatarUrl: res.user.avatarUrl
    });
    socket.emit('auth:success', { user: sessionUser, token: res.token });
  }

  #broadcastPresence(): void {
    this.#deps.presence.broadcastPresence(this.#deps.io);
  }
}
