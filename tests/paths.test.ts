// Self-check of the path helpers: node --test tests/  (Node runs .ts directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, displayName, HOME, joinPath, kindOf, normPath, parentPath, parseSearch, searchPath, uncRoot } from '../src/api.ts';

test('parent of local, root and network paths', () => {
  assert.equal(parentPath('C:\\Users\\Me'), 'C:\\Users');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('C:\\'), HOME);
  assert.equal(parentPath('\\\\nas\\share\\a\\b'), '\\\\nas\\share\\a');
  assert.equal(parentPath('\\\\nas\\share\\a'), '\\\\nas\\share');
  assert.equal(parentPath('\\\\nas\\share'), HOME);
  assert.equal(uncRoot('C:\\x'), null);
});
test('names, joins and search paths', () => {
  assert.equal(joinPath('C:\\', 'a'), 'C:\\a');
  assert.equal(joinPath('', 'C:\\x\\y'), 'C:\\x\\y');
  assert.equal(baseName('C:\\a\\b\\'), 'b');
  assert.deepEqual(parseSearch(searchPath('C:\\x', 'what?ever')), { root: 'C:\\x', q: 'what?ever' });
  assert.equal(normPath('\\\\?\\C:\\Users\\'), 'c:\\users');
});
test('display names and kinds', () => {
  assert.equal(displayName('Blender.lnk', false, true), 'Blender');
  assert.equal(displayName('photo.jpg', false, false), 'photo');
  assert.equal(displayName('photo.jpg', false, true), 'photo.jpg');
  assert.equal(displayName('.gitignore', false, false), '.gitignore');
  assert.equal(displayName('my.folder', true, false), 'my.folder');
  assert.equal(kindOf({ name: 'a.PDF', isDir: false, size: 0, modified: 0, hidden: false }), 'PDF file');
  assert.equal(kindOf({ name: 'Makefile', isDir: false, size: 0, modified: 0, hidden: false }), 'File');
});
