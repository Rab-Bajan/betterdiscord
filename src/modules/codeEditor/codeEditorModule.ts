import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { CodeEditorController } from './CodeEditorController.ts';
import { CodeEditorService } from './CodeEditorService.ts';

/** Replaces legacy `codeEditorHandler(io, users)`; room state `code:tree-data` on voice join. */
export const codeEditorModule: ModuleFactory<'codeEditor'> = (deps) => {
  const code = new CodeEditorService();
  return {
    controller: new CodeEditorController(deps.io, deps.users, code, deps.logger.child('CodeEditor')),
    roomStateProvider: { getRoomState: (channelId) => [{ event: 'code:tree-data', payload: code.getProject(channelId) }] },
    api: { getProject: (channelId) => code.getProject(channelId) }
  };
};

export default codeEditorModule;
