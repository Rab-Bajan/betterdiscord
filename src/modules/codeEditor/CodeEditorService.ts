import { defaultIdSource, type IdSource } from '../shared/legacyId.ts';
import { createDefaultProject } from './defaultProject.ts';
import { addToFolder, removeNode, renameNode, setFileContent } from './ProjectTree.ts';
import type { FolderNode, ProjectNode } from './types.ts';

/** Largest file content accepted, in UTF-16 units (legacy `content.length`). */
export const MAX_FILE_SIZE = 1024 * 1024;
const MAX_NAME_LENGTH = 100;

/** `name` without slashes, trimmed and capped; `fallback` when nothing is left. */
export function sanitizeName(name: unknown, fallback: string): string {
  const clean = String(name || '').replace(/[\\/]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * One shared in-memory project tree per voice channel (legacy codeEditorHandler.js).
 * Membership is checked by the controller; every mutation reports whether it applied.
 */
export class CodeEditorService {
  readonly #projects = new Map<string, FolderNode>();
  readonly #ids: IdSource;

  constructor(ids: IdSource = defaultIdSource) {
    this.#ids = ids;
  }

  /** The channel's project, created from the starter project on first access. */
  getProject(channelId: string): FolderNode {
    let project = this.#projects.get(channelId);
    if (!project) {
      project = createDefaultProject();
      this.#projects.set(channelId, project);
    }
    return project;
  }

  /** Creates a file or folder under `parentId`; returns it, or null when nothing was added. */
  createNode(channelId: string, parentId: unknown, name: unknown, type: unknown): ProjectNode | null {
    if (type !== 'file' && type !== 'folder') return null;
    const id = `${type}_${this.#ids.now()}_${this.#ids.random().toString(36).substring(2, 6)}`;
    const node: ProjectNode = type === 'file'
      ? { id, name: sanitizeName(name, 'uj_file.js'), type, content: '' }
      : { id, name: sanitizeName(name, 'uj_mappa'), type, children: [] };
    return addToFolder(this.getProject(channelId), parentId, node) ? node : null;
  }

  deleteNode(channelId: string, nodeId: unknown): boolean {
    return removeNode(this.getProject(channelId), nodeId);
  }

  /** Renames a node; returns the sanitized name, or null when nothing changed. */
  renameNode(channelId: string, nodeId: unknown, newName: unknown): string | null {
    const name = sanitizeName(newName, '');
    return name && renameNode(this.getProject(channelId), nodeId, name) ? name : null;
  }

  /** Stores a file's new content (strings up to {@link MAX_FILE_SIZE}); true when applied. */
  changeFile(channelId: string, fileId: unknown, content: unknown): content is string {
    if (typeof content !== 'string' || content.length > MAX_FILE_SIZE) return false;
    return setFileContent(this.getProject(channelId), fileId, content);
  }
}
