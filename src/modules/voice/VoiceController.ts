import type { Server, Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { PresenceService } from '../presence/PresenceService.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import { toVoicePeer } from './VoiceService.ts';
import type { VoiceService } from './VoiceService.ts';

/** Cross-module hooks (legacy server.js voiceHandler callbacks). */
export interface VoiceHooks {
  /** Sends the room-bound module states to a socket that joined `channelId`. */
  onRoomJoined(socket: Socket, channelId: string): void;
  /** Speaking changes (feeds MiskolcPhobia). */
  onUserSpeaking(socketId: string, isSpeaking: boolean): void;
}

/** Loggers with the legacy console prefixes. */
export interface VoiceLoggers {
  voice: Logger;
  webrtc: Logger;
  screenShare: Logger;
}

/** Voice rooms: join/leave, WebRTC relay, speaking, screen share, camera, mute (legacy voiceHandler.js). */
export class VoiceController extends SocketController {
  readonly #io: Server;
  readonly #voice: VoiceService;
  readonly #presence: PresenceService;
  readonly #hooks: VoiceHooks;
  readonly #log: VoiceLoggers;

  constructor(io: Server, voice: VoiceService, presence: PresenceService, hooks: VoiceHooks, loggers: VoiceLoggers) {
    super(loggers.voice);
    this.#io = io;
    this.#voice = voice;
    this.#presence = presence;
    this.#hooks = hooks;
    this.#log = loggers;
  }

  register(socket: Socket): void {
    const on = (event: string, handler: (fields: Readonly<Record<string, unknown>>) => void): void => {
      this.listen(socket, event, (payload) => {
        const fields = legacyDefaultedFields(payload);
        if (fields) handler(fields);
      });
    };
    on('voice:join', (f) => { this.#join(socket, f['channelId']); });
    on('voice:leave', () => { this.#leave(socket); });
    on('webrtc:signal', (f) => { this.#relay(socket, f['targetPeerId'], f['signal']); });
    on('voice:speaking', (f) => { this.#speaking(socket, f['isSpeaking']); });
    on('voice:screen-share', (f) => { this.#screenShare(socket, f['isSharing']); });
    on('voice:camera', (f) => { this.#camera(socket, f['isOn']); });
    on('voice:state-change', (f) => { this.#stateChange(socket, f['isMuted'], f['isDeafened']); });
  }

  #broadcastStates(): void {
    this.#io.emit('voice:states-updated', this.#presence.getVoiceChannelState());
  }

  #join(socket: Socket, channelId: unknown): void {
    // Legacy only checked truthiness; the frontend always sends a string id.
    if (typeof channelId !== 'string' || !channelId || !this.#voice.user(socket.id)) return;
    const previous = this.#voice.user(socket.id)?.voiceChannel;
    if (previous) {
      socket.leave(previous);
      socket.to(previous).emit('voice:peer-left', { peerId: socket.id });
    }
    const outcome = this.#voice.join(socket.id, channelId);
    if (!outcome) return;
    socket.join(channelId);
    socket.emit('voice:joined', { channelId, peers: outcome.peers });
    this.#hooks.onRoomJoined(socket, channelId);
    socket.to(channelId).emit('voice:peer-joined', { peerId: socket.id, user: toVoicePeer(outcome.user) });
    this.#broadcastStates();
    this.#log.voice.info(`${outcome.user.username} csatlakozott a(z) ${channelId} csatornához`);
  }

  #leave(socket: Socket): void {
    const left = this.#voice.leave(socket.id);
    if (!left) return;
    socket.leave(left.channelId);
    socket.to(left.channelId).emit('voice:peer-left', { peerId: socket.id });
    this.#broadcastStates();
    this.#log.voice.info(`${left.user.username} kilépett a(z) ${left.channelId} csatornából`);
  }

  #relay(socket: Socket, targetPeerId: unknown, signal: unknown): void {
    const sender = this.#voice.user(socket.id);
    if (!sender || !targetPeerId || !signal) return;
    if (!this.#voice.isConnected(targetPeerId)) {
      this.#log.webrtc.warn(`Célpont nem található: ${String(targetPeerId)} (feladó: ${sender.username})`);
      return;
    }
    this.#io.to(targetPeerId as string).emit('webrtc:signal', { senderPeerId: socket.id, signal });
  }

  #speaking(socket: Socket, value: unknown): void {
    const user = this.#voice.setFlag(socket.id, 'isSpeaking', value);
    if (!user?.voiceChannel) return;
    const isSpeaking = user.isSpeaking === true;
    this.#hooks.onUserSpeaking(socket.id, isSpeaking);
    this.#io.to(user.voiceChannel).emit('voice:user-speaking', { userId: socket.id, isSpeaking });
  }

  #screenShare(socket: Socket, value: unknown): void {
    const user = this.#voice.setFlag(socket.id, 'isScreenSharing', value);
    if (!user?.voiceChannel) return;
    const isSharing = user.isScreenSharing === true;
    this.#broadcastStates();
    this.#io.to(user.voiceChannel).emit('voice:user-screen-sharing', { userId: socket.id, isSharing });
    this.#log.screenShare.info(`${user.username} képernyőmegosztás: ${isSharing ? 'BE' : 'KI'}`);
  }

  #camera(socket: Socket, value: unknown): void {
    const user = this.#voice.setFlag(socket.id, 'isCameraOn', value);
    if (!user?.voiceChannel) return;
    this.#broadcastStates();
    this.#io.to(user.voiceChannel).emit('voice:user-camera', { userId: socket.id, isOn: user.isCameraOn === true });
  }

  #stateChange(socket: Socket, isMuted: unknown, isDeafened: unknown): void {
    const user = this.#voice.setMuteState(socket.id, isMuted, isDeafened);
    if (!user) return;
    this.#broadcastStates();
    if (user.voiceChannel) {
      this.#io.to(user.voiceChannel).emit('voice:peer-state-changed', {
        userId: user.id, isMuted: user.isMuted, isDeafened: user.isDeafened
      });
    }
  }
}
