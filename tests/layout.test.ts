// Self-check of the grouped virtual-list geometry: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, dateBounds, groupLabel, headsIn, posOf, rangeOf, segOf } from '../src/layout.ts';

test('ungrouped list and grid', () => {
  const L = buildLayout([], 100_000, 1, 30, 28);
  assert.equal(L.height, 3_000_000);
  assert.deepEqual(rangeOf(L, 300, 600), [10, 20]);
  assert.deepEqual(posOf(L, 12), { col: 0, y: 360 });
  assert.deepEqual(headsIn(L, 0, 600), []);
  const G = buildLayout([], 10, 4, 100, 28);
  assert.equal(G.height, 300);
  assert.deepEqual(posOf(G, 9), { col: 1, y: 200 });
  assert.deepEqual(rangeOf(G, 150, 250), [4, 10]);
});

test('groups with a collapsed one in the middle', () => {
  // a: 3 items, b: 5 items collapsed, c: 2 items. Visible indices 0-2 (a), 3-4 (c).
  const groups = [{ key: 'a', start: 0, count: 3, shown: 3 }, { key: 'b', start: 3, count: 5, shown: 0 }, { key: 'c', start: 3, count: 2, shown: 2 }];
  const L = buildLayout(groups, 5, 1, 30, 28);
  assert.deepEqual(L.segs.map((s) => [s.top, s.body, s.end]), [[0, 28, 118], [118, 146, 146], [146, 174, 234]]);
  assert.equal(L.height, 234);
  assert.equal(segOf(L, 3).key, 'c');
  assert.equal(segOf(L, 2).key, 'a');
  assert.deepEqual(posOf(L, 4), { col: 0, y: 204 });
  assert.deepEqual(rangeOf(L, 0, 1000), [0, 5]);
  assert.deepEqual(rangeOf(L, 100, 180), [2, 4]);
  // Scrolled into group a: its header sticks to the top edge.
  const h = headsIn(L, 50, 200);
  assert.deepEqual(h.map((x) => [x.seg.key, x.y, x.stuck]), [['a', 50, true], ['b', 118, false], ['c', 146, false]]);
  // Near the end of a, the sticky header is pushed up by the next one.
  assert.equal(headsIn(L, 100, 200)[0].y, 90);
});

test('date bounds and labels', () => {
  const b = dateBounds(new Date(2026, 10, 12, 15, 0), 1); // Thursday 12 Nov 2026, weeks start Monday
  const day = (d: number) => new Date(2026, 10, d).getTime() / 1000;
  assert.deepEqual(b, [day(12), day(11), day(9), day(2), day(1)]);
  assert.equal(groupLabel('modified', '3', String), 'Last week');
  assert.equal(groupLabel('type', 'folder', String), 'Folders');
  assert.equal(groupLabel('type', 'png', (x) => x.toUpperCase()), 'PNG');
  assert.equal(groupLabel('letter', '0-9', String), '0 – 9');
});
