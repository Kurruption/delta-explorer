// Remote path helpers: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, driveOf, HOME, joinPath, parentPath, remoteHome, remoteId, remoteRoot } from '../src/api.ts';

test('remote paths walk like folders', () => {
  assert.equal(joinPath('remote:ab/', 'x'), 'remote:ab/x');
  assert.equal(joinPath('remote:ab/x', 'y z'), 'remote:ab/x/y z');
  assert.equal(parentPath('remote:ab/x/y'), 'remote:ab/x');
  assert.equal(parentPath('remote:ab/x'), 'remote:ab/');
  assert.equal(parentPath('remote:ab/'), HOME);
  assert.equal(baseName('remote:ab/x/y.txt'), 'y.txt');
  assert.equal(remoteRoot('remote:ab/x/y'), 'remote:ab/');
  assert.equal(remoteId('remote:ab/x'), 'ab');
  assert.notEqual(driveOf('remote:ab/x'), driveOf('remote:cd/x'));
  assert.equal(driveOf('remote:ab/x'), driveOf('remote:ab/y/z'));
  assert.equal(remoteHome({ id: 'ab', path: '/home/me', name: '', protocol: 'sftp', host: '', port: 0, user: '', keyFile: '', fingerprint: '' }), 'remote:ab/home/me');
  // Local paths unchanged.
  assert.equal(parentPath('C:\\a\\b'), 'C:\\a');
  assert.equal(driveOf('C:\\a'), 'c:');
});
