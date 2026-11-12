import type { FolderNode, ProjectNode } from './types.ts';

const ROOT_ID = 'root';

/** Depth-first search for the node with `id` (the root included). */
export function findNode(node: ProjectNode, id: unknown): ProjectNode | null {
  if (node.id === id) return node;
  if (node.type !== 'folder') return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Adds `node` to folder `parentId` (default: the root); false when that is no folder. */
export function addToFolder(root: FolderNode, parentId: unknown, node: ProjectNode): boolean {
  const parent = findNode(root, parentId || ROOT_ID);
  if (parent?.type !== 'folder') return false;
  parent.children.push(node);
  return true;
}

/** Removes the first node with `id` below `folder`; the root itself is never removed. */
export function removeNode(folder: FolderNode, id: unknown): boolean {
  if (id === ROOT_ID) return false;
  const index = folder.children.findIndex((c) => c.id === id);
  if (index !== -1) {
    folder.children.splice(index, 1);
    return true;
  }
  return folder.children.some((child) => child.type === 'folder' && removeNode(child, id));
}

/** Renames any node except the root. */
export function renameNode(root: FolderNode, id: unknown, name: string): boolean {
  const node = findNode(root, id);
  if (!node || id === ROOT_ID) return false;
  node.name = name.trim();
  return true;
}

/** Replaces a file's content; false when `fileId` is not a file. */
export function setFileContent(root: FolderNode, fileId: unknown, content: string): boolean {
  const node = findNode(root, fileId);
  if (node?.type !== 'file') return false;
  node.content = content;
  return true;
}
