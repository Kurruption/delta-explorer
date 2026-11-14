// Self-check of the quick-win helpers: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderLines, recall, remember, undoPairs, wildcard, numberClashes } from '../src/quick.ts';

test('wildcards match whole names, case-insensitively', () => {
  const re = wildcard('*.png; report-??.pdf')!;
  assert.ok(re.test('A.PNG') && re.test('report-01.pdf'));
  assert.ok(!re.test('a.png.txt') && !re.test('report-1.pdf') && !re.test('xpng'));
  assert.ok(wildcard('a+(b).txt')!.test('a+(b).txt'), 'regex characters are literal');
  assert.equal(wildcard(' ; '), null);
});
test('folder lines and undo pairs', () => {
  assert.deepEqual(folderLines(' a \r\n\nb\\c\n'), ['a', 'b\\c']);
  assert.deepEqual(undoPairs([['C:\\x\\a.txt', 'C:\\x\\b.txt']]), [['C:\\x\\b.txt', 'a.txt']]);
});
test('view memory keeps the latest', () => {
  remember('k', { top: 1, sel: [], focus: 0 });
  remember('k', { top: 2, sel: ['a'], focus: 3 });
  assert.equal(recall('k')?.top, 2);
});

test('batch rename numbers names that clash, keeping extensions', () => {
  assert.deepEqual(numberClashes(['Holiday.jpg', 'Holiday.JPG', 'Holiday.png', 'x'], false), ['Holiday (1).jpg', 'Holiday (2).JPG', 'Holiday.png', 'x']);
  assert.deepEqual(numberClashes(['a.b', 'a.b'], true), ['a.b (1)', 'a.b (2)']);
});
