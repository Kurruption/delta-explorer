import { persisted } from './store';
import { ACTIONS, comboOf, conflictsIn, keysIn, pretty, type ActionId, type KeyAction } from './keys';

// The live shortcut map: the defaults in keys.ts plus the user's changes (Settings → Shortcuts).
export * from './keys';

/** Only the user's changes are stored; everything else follows the defaults (so new actions get theirs). */
export const keymap = persisted<Record<string, string[]>>('keymap', {});
export const keysOf = (id: ActionId, map = keymap.get()) => keysIn(id, map);
export const conflicts = (map = keymap.get()) => conflictsIn(map);

const typingIn = (t: EventTarget | null) => !!(t as HTMLElement | null)?.matches?.('input, textarea, [contenteditable="true"]');

/** Does this key event trigger the action? Plain keys (no Ctrl/Alt, not F-keys) never fire while typing. */
export function is(e: KeyboardEvent, id: ActionId) {
  const c = comboOf(e);
  if (!c || !keysOf(id).includes(c)) return false;
  if (typingIn(e.target) && ((ACTIONS[id] as KeyAction).noTyping || !/^(Ctrl|Alt)\+|^F\d+$/.test(c))) return false;
  return true;
}

/** The first key of an action, for menus and tooltips. */
export const keyLabel = (id: ActionId) => { const k = keysOf(id)[0]; return k ? pretty(k) : undefined; };

export function setKeys(id: ActionId, keys: string[]) {
  keymap.set((m) => {
    const n = { ...m };
    if (keys.length === ACTIONS[id].keys.length && keys.every((k, i) => k === ACTIONS[id].keys[i])) delete n[id]; else n[id] = keys;
    return n;
  });
}
