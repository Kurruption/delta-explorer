// Self-checks for the keymap, tab moves and settings import/export: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, comboOf, conflictsIn as conflicts, keysIn as keysOf } from '../src/keys.ts';
import { moveTab, newTab, removeTab, insertTab, duplicateTab, fromPayload, payload } from '../src/tabs.ts';
import { diff, makeBundle, parseBundle, snapshot } from '../src/profiles.ts';

const ev = (key: string, code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

test('key combos are layout-aware and canonical', () => {
  assert.equal(comboOf(ev('k', 'KeyK', { ctrlKey: true })), 'Ctrl+K');
  assert.equal(comboOf(ev('N', 'KeyN', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+N');
  assert.equal(comboOf(ev('!', 'Digit1', { shiftKey: true })), 'Shift+1');
  assert.equal(comboOf(ev('<', 'Comma', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+,');
  assert.equal(comboOf(ev(',', 'Comma', { ctrlKey: true })), 'Ctrl+,');
  assert.equal(comboOf(ev('\\', 'Backslash', { ctrlKey: true })), 'Ctrl+\\');
  assert.equal(comboOf(ev('ArrowLeft', 'ArrowLeft', { altKey: true })), 'Alt+ArrowLeft');
  assert.equal(comboOf(ev(' ', 'Space')), 'Space');
  assert.equal(comboOf(ev('Control', 'ControlLeft', { ctrlKey: true })), '');
  assert.equal(comboOf(ev('z', 'KeyY', { metaKey: true })), 'Ctrl+Z', 'QWERTZ: the letter, not the key position');
});

test('defaults have no conflicts; overrides are detected', () => {
  assert.equal(conflicts({}).size, 0);
  const c = conflicts({ newWindow: ['Ctrl+T'] });
  assert.deepEqual(c.get('Ctrl+T')?.sort(), ['newTab', 'newWindow']);
  assert.deepEqual(keysOf('palette', {}), ACTIONS.palette.keys);
  assert.deepEqual(keysOf('palette', { palette: [] }), []);
});

test('tab moves keep the active tab and never leave a pane empty', () => {
  const s = { tabs: ['a', 'b', 'c'].map(newTab), active: 1 };
  const m = moveTab(s, 1, 2);
  assert.deepEqual(m.tabs.map((t) => t.history[0]), ['a', 'c', 'b']);
  assert.equal(m.tabs[m.active].history[0], 'b');
  assert.equal(moveTab(s, 0, 0), s);
  const r = removeTab(s, 1);
  assert.equal(r.tabs.length, 2);
  assert.equal(removeTab({ tabs: [newTab('x')], active: 0 }, 0).tabs[0].history[0], 'delta:home');
  const d = duplicateTab({ tabs: [{ ...newTab('x'), locked: true, color: '#f00' }], active: 0 }, 0);
  assert.equal(d.tabs.length, 2);
  assert.equal(d.active, 1);
  assert.equal(d.tabs[1].color, '#f00');
  assert.equal(d.tabs[1].locked, false);
  assert.notEqual(d.tabs[0].id, d.tabs[1].id);
  const i = insertTab(s, newTab('z'), 0);
  assert.equal(i.tabs[1].history[0], 'z');
  const back = fromPayload({ ...payload(newTab('q')), idx: 9 });
  assert.equal(back.idx, 0, 'a bad history index from another window is clamped');
});

test('settings bundles: validated, previewed', () => {
  const ls = { length: 3, key: (i: number) => ['settings', 'session', 'pinned'][i], getItem: (k: string) => JSON.stringify(k === 'settings' ? { theme: 'dark' } : ['C:\\x']) };
  const snap = snapshot(ls);
  assert.deepEqual(Object.keys(snap).sort(), ['pinned', 'settings'], 'session is never exported');
  const b = parseBundle(JSON.stringify(makeBundle({ settings: { theme: 'light' }, pinned: ['C:\\x'], tags: [{ id: 'r', name: 'R', color: '#f00' }] })));
  const changes = diff(snap, b.data);
  assert.deepEqual(changes.map((c) => [c.key, c.kind]), [['pinned', 'unchanged'], ['settings', 'changed'], ['tags', 'added']]);
  assert.equal(changes[1].detail, '1 setting change');
  assert.throws(() => parseBundle('nope'), /valid JSON/);
  assert.throws(() => parseBundle(JSON.stringify({ app: 'other', data: {} })), /isn’t a Delta/);
  assert.throws(() => parseBundle(JSON.stringify({ app: 'delta-explorer', version: 1, data: { pinned: [1, 2] } })), /damaged/);
  assert.throws(() => parseBundle(JSON.stringify({ app: 'delta-explorer', version: 1, data: { session: {} } })), /Unexpected/);
  assert.throws(() => parseBundle(JSON.stringify({ app: 'delta-explorer', version: 1, data: { 'bad key!': 1 } })), /Unexpected/);
});
