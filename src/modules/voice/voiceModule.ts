import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { VoiceController } from './VoiceController.ts';
import { VoiceService } from './VoiceService.ts';

/** Override for the legacy `voice` module (voiceHandler.js plus its server.js callbacks). */
export const voiceModule: ModuleFactory<'voice'> = (deps) => ({
  controller: new VoiceController(deps.io, new VoiceService(deps.users), deps.presence, {
    onRoomJoined: (socket, channelId) => deps.socketServer.emitRoomState(socket, channelId),
    onUserSpeaking: (socketId, isSpeaking) => deps.module('phobia').handleUserSpeaking(socketId, isSpeaking)
  }, {
    voice: deps.logger.child('Voice'),
    webrtc: deps.logger.child('WebRTC Relay'),
    screenShare: deps.logger.child('ScreenShare')
  }),
  api: undefined
});

export default voiceModule;
