// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squarify } from '../src/treemap.ts';
import { archivePath, baseName, parentPath, parseArchive, isFolder } from '../src/api.ts';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test('treemap tiles fill the box, proportionally, without overlap', () => {
  const sizes = [500, 300, 120, 60, 10, 6, 3, 1, 0];
  const box = { x: 10, y: 20, w: 400, h: 250 };
  const tiles = squarify(sizes.map((size) => ({ size })), box);
  assert.equal(tiles.length, 8, 'zero-size items are left out');
  const total = sizes.reduce((a, b) => a + b, 0);
  let area = 0;
  for (const t of tiles) {
    area += t.w * t.h;
    assert.ok(close((t.w * t.h) / (box.w * box.h), t.item.size / total), 'area matches share');
    assert.ok(t.x >= box.x - 1e-6 && t.y >= box.y - 1e-6 && t.x + t.w <= box.x + box.w + 1e-6 && t.y + t.h <= box.y + box.h + 1e-6, 'inside the box');
  }
  assert.ok(close(area, box.w * box.h));
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j];
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
    assert.ok(!overlap, `tiles ${i} and ${j} overlap`);
  }
  // Squarified: equal items in a square come out square-ish, not as thin strips.
  const sq = squarify([1, 1, 1, 1].map((size) => ({ size })), { x: 0, y: 0, w: 100, h: 100 });
  for (const t of sq) assert.ok(Math.max(t.w / t.h, t.h / t.w) <= 1.01);
  assert.deepEqual(squarify([{ size: 0 }], box), []);
});

test('archive paths browse like folders', () => {
  const root = archivePath('C:\\x\\a.zip');
  const inner = archivePath('C:\\x\\a.zip', 'sub\\b.txt');
  assert.deepEqual(parseArchive(inner), { file: 'C:\\x\\a.zip', inner: 'sub\\b.txt' });
  assert.equal(parentPath(inner), archivePath('C:\\x\\a.zip', 'sub'));
  assert.equal(parentPath(archivePath('C:\\x\\a.zip', 'sub')), root);
  assert.equal(parentPath(root), 'C:\\x');
  assert.equal(baseName(inner), 'b.txt');
  assert.equal(baseName(root), 'a.zip');
  assert.equal(isFolder(root), false, 'read-only: no paste, watch or new folder');
});
