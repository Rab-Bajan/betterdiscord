import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeEditorService, MAX_FILE_SIZE, sanitizeName } from '../../../src/modules/codeEditor/CodeEditorService.ts';
import { findNode } from '../../../src/modules/codeEditor/ProjectTree.ts';

const ids = (): { now: () => number; random: () => number } => {
  let n = 0;
  return { now: () => 1_700_000_000_000, random: () => (n += 0.1) };
};

test('every channel starts from its own copy of the starter project', () => {
  const code = new CodeEditorService();
  const a = code.getProject('a');
  assert.equal(a.id, 'root');
  assert.deepEqual(a.children.map((c) => c.id), ['file-index-js', 'folder-src', 'file-readme']);
  assert.equal(code.getProject('a'), a);
  assert.notEqual(code.getProject('b'), a);
});

test('sanitizeName strips slashes, trims, caps at 100 and falls back', () => {
  assert.equal(sanitizeName(' a/b\\c ', 'x'), 'abc');
  assert.equal(sanitizeName('//', 'fallback'), 'fallback');
  assert.equal(sanitizeName(undefined, 'f'), 'f');
  assert.equal(sanitizeName('n'.repeat(150), 'f').length, 100);
});

test('createNode: file/folder only, into folders only, legacy id and defaults', () => {
  const code = new CodeEditorService(ids());
  assert.equal(code.createNode('r', undefined, 'x', 'link'), null);
  assert.equal(code.createNode('r', 'file-readme', 'x', 'file'), null);
  const folder = code.createNode('r', undefined, '', 'folder');
  assert.deepEqual(folder, { id: `folder_1700000000000_${(0.2).toString(36).substring(2, 6)}`, name: 'uj_mappa', type: 'folder', children: [] });
  const file = code.createNode('r', folder?.id, undefined, 'file');
  assert.equal(file?.name, 'uj_file.js');
  assert.equal(findNode(code.getProject('r'), file?.id)?.type, 'file');
});

test('rename, delete and file content rules', () => {
  const code = new CodeEditorService(ids());
  assert.equal(code.renameNode('r', 'root', 'x'), null);
  assert.equal(code.renameNode('r', 'file-readme', '///'), null);
  assert.equal(code.renameNode('r', 'file-readme', ' README.txt '), 'README.txt');
  assert.equal(code.deleteNode('r', 'root'), false);
  assert.equal(code.deleteNode('r', 'file-app-py'), true);
  assert.equal(findNode(code.getProject('r'), 'file-app-py'), null);
  assert.equal(code.deleteNode('r', 'file-app-py'), false);
  assert.equal(code.changeFile('r', 'folder-src', 'x'), false);
  assert.equal(code.changeFile('r', 'file-readme', 42), false);
  assert.equal(code.changeFile('r', 'file-readme', 'x'.repeat(MAX_FILE_SIZE + 1)), false);
  assert.equal(code.changeFile('r', 'file-readme', 'új'), true);
  const readme = findNode(code.getProject('r'), 'file-readme');
  assert.equal(readme?.type === 'file' ? readme.content : null, 'új');
});
