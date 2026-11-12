import type { ModuleOverrides } from '../app/modules/ModuleFactory.ts';
import { adminModule } from './admin/adminModule.ts';
import { authModule } from './auth/authModule.ts';
import { browserModule } from './browser/browserModule.ts';
import { callModule } from './call/callModule.ts';
import { casinoModule } from './casino/casinoModule.ts';
import { chatModule } from './chat/chatModule.ts';
import { chessModule } from './chess/chessModule.ts';
import { codeEditorModule } from './codeEditor/codeEditorModule.ts';
import { dmModule } from './dm/dmModule.ts';
import { speedTestModule } from './speedTest/speedTestModule.ts';
import { voiceModule } from './voice/voiceModule.ts';
import { watchPartyModule } from './watchParty/watchPartyModule.ts';
import { whiteboardModule } from './whiteboard/whiteboardModule.ts';

/**
 * Modules rewritten in TypeScript, each proven against the legacy handler by the golden
 * test. The Application mounts these by default; every module not listed here still runs
 * its legacy handler behind a LegacyModuleAdapter.
 */
export const MIGRATED_MODULES: ModuleOverrides = Object.freeze({
  casino: casinoModule,
  watchParty: watchPartyModule,
  chess: chessModule,
  codeEditor: codeEditorModule,
  dm: dmModule,
  browser: browserModule,
  call: callModule,
  chat: chatModule,
  whiteboard: whiteboardModule,
  speedTest: speedTestModule,
  voice: voiceModule,
  auth: authModule,
  admin: adminModule
});
