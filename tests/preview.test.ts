// Self-check of preview kind detection and the highlighter: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlight, previewKind } from '../src/previewKinds.ts';

test('preview kind by extension', () => {
  assert.equal(previewKind('C:\\x\\Photo.JPG'), 'image');
  assert.equal(previewKind('a.pdf'), 'pdf');
  assert.equal(previewKind('clip.webm'), 'video');
  assert.equal(previewKind('song.flac'), 'audio');
  assert.equal(previewKind('Inter.woff2'), 'font');
  assert.equal(previewKind('a.zip'), 'zip');
  assert.equal(previewKind('main.rs'), 'text');
  assert.equal(previewKind('.gitignore'), 'text');
  assert.equal(previewKind('C:\\repo\\LICENSE'), 'text');
  assert.equal(previewKind('setup.exe'), 'other');
  assert.equal(previewKind('noext'), 'other');
});

const flat = (lines: ReturnType<typeof highlight>) => lines.map((l) => l.map(([c, t]) => `${c}:${t}`).join('|'));

test('highlights comments, strings, numbers and keywords', () => {
  assert.deepEqual(flat(highlight('const a = "x"; // hi\r\nreturn 42', 'ts')), ['k:const|: a = |s:"x"|:; |c:// hi', 'k:return|: |n:42']);
  assert.deepEqual(flat(highlight('/* a\nb */x', 'c')), ['c:/* a', 'c:b */|:x']);
  assert.deepEqual(flat(highlight('/* never closed\nstill', 'js')), ['c:/* never closed', 'c:still']);
  assert.deepEqual(flat(highlight('# note\nx = 1', 'py')), ['c:# note', ':x = |n:1']);
  assert.deepEqual(flat(highlight("fn f<'a>(c: char) { 'x' }", 'rs')), ["k:fn|: f<'a>(c: char) { |s:'x'|: }"]);
});

test('plain text is left alone, line by line', () => {
  assert.deepEqual(flat(highlight("don't \"quote\"\n\nend", 'txt')), [":don't \"quote\"", '', ':end']);
  assert.deepEqual(flat(highlight('# Title\ntext', 'md')), ['k:# Title', ':text']);
});

test('svg previews as a picture, not code', () => {
  assert.equal(previewKind('logo.svg'), 'svg');
  assert.equal(previewKind('C:\a\Icon.SVG'), 'svg');
});
