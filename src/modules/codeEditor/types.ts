/** A file of a channel's shared project. */
export interface FileNode {
  id: string;
  name: string;
  type: 'file';
  content: string;
}

/** A folder of a channel's shared project (the tree root is the folder `root`). */
export interface FolderNode {
  id: string;
  name: string;
  type: 'folder';
  children: ProjectNode[];
}

export type ProjectNode = FileNode | FolderNode;

/** What other modules consume (legacy codeEditorHandler return value). */
export interface CodeEditorApi {
  getProject(channelId: string): FolderNode;
}
