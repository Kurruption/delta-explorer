
// One map of every keyboard shortcut. Handlers ask `is(e, 'id')` instead of testing keys themselves, so
// Settings → Shortcuts can change any of them. To add a shortcut: add an entry here, then `is(e, 'yourId')`.

export interface KeyAction {
  label: string;
  group: 'App' | 'Tabs & navigation' | 'Files';
  keys: string[];
  /** Ignored while typing in a text box (e.g. Ctrl+Z is the text box's own undo). */
  noTyping?: boolean;
}

export const ACTIONS = {
  palette: { label: 'Command palette', group: 'App', keys: ['Ctrl+K', 'Ctrl+Shift+P'] },
  settings: { label: 'Settings', group: 'App', keys: ['Ctrl+,'] },
  split: { label: 'Split view', group: 'App', keys: ['Ctrl+\\'] },
  undo: { label: 'Undo last action', group: 'App', keys: ['Ctrl+Z'], noTyping: true },
  otherPane: { label: 'Switch to the other pane', group: 'App', keys: ['F6'] },
  newWindow: { label: 'New window', group: 'App', keys: ['Ctrl+N'] },
  previewPane: { label: 'Preview pane', group: 'App', keys: ['Alt+P'] },

  newTab: { label: 'New tab', group: 'Tabs & navigation', keys: ['Ctrl+T'] },
  closeTab: { label: 'Close tab', group: 'Tabs & navigation', keys: ['Ctrl+W'] },
  reopenTab: { label: 'Reopen closed tab', group: 'Tabs & navigation', keys: ['Ctrl+Shift+T'] },
  nextTab: { label: 'Next tab', group: 'Tabs & navigation', keys: ['Ctrl+Tab'] },
  prevTab: { label: 'Previous tab', group: 'Tabs & navigation', keys: ['Ctrl+Shift+Tab'] },
  duplicateTab: { label: 'Duplicate tab', group: 'Tabs & navigation', keys: [] },
  lockTab: { label: 'Lock / unlock tab', group: 'Tabs & navigation', keys: [] },
  tabToWindow: { label: 'Move tab to a new window', group: 'Tabs & navigation', keys: [] },
  address: { label: 'Type a path', group: 'Tabs & navigation', keys: ['Ctrl+L', 'Alt+D', 'F4'] },
  search: { label: 'Search', group: 'Tabs & navigation', keys: ['Ctrl+F'] },
  back: { label: 'Back', group: 'Tabs & navigation', keys: ['Alt+ArrowLeft', 'Backspace'] },
  forward: { label: 'Forward', group: 'Tabs & navigation', keys: ['Alt+ArrowRight'] },
  up: { label: 'Up one folder', group: 'Tabs & navigation', keys: ['Alt+ArrowUp'] },

  open: { label: 'Open', group: 'Files', keys: ['Enter'] },
  openNewTab: { label: 'Open folder in new tab', group: 'Files', keys: ['Ctrl+Enter'] },
  quickLook: { label: 'Quick Look', group: 'Files', keys: ['Space'] },
  rename: { label: 'Rename', group: 'Files', keys: ['F2'] },
  delete: { label: 'Delete (Recycle Bin)', group: 'Files', keys: ['Delete'] },
  deleteForever: { label: 'Delete permanently', group: 'Files', keys: ['Shift+Delete'] },
  newFolder: { label: 'New folder', group: 'Files', keys: ['Ctrl+Shift+N'] },
  cut: { label: 'Cut', group: 'Files', keys: ['Ctrl+X'] },
  copy: { label: 'Copy', group: 'Files', keys: ['Ctrl+C'] },
  paste: { label: 'Paste', group: 'Files', keys: ['Ctrl+V'] },
  selectAll: { label: 'Select all', group: 'Files', keys: ['Ctrl+A'] },
  clearSelection: { label: 'Clear selection', group: 'Files', keys: ['Escape'] },
  copyPath: { label: 'Copy path', group: 'Files', keys: ['Ctrl+Shift+C'] },
  copyAsPath: { label: 'Copy as path (quoted)', group: 'Files', keys: [] },
  properties: { label: 'Properties', group: 'Files', keys: ['Alt+Enter'] },
  refresh: { label: 'Refresh', group: 'Files', keys: ['F5'] },
  menu: { label: 'Delta menu', group: 'Files', keys: ['ContextMenu'] },
  nativeMenu: { label: 'Windows menu', group: 'Files', keys: ['Shift+F10'] },
  terminal: { label: 'Open in Terminal', group: 'Files', keys: [] },
  share: { label: 'Share', group: 'Files', keys: [] },
} satisfies Record<string, KeyAction>;
export type ActionId = keyof typeof ACTIONS;

/** Fixed keys, listed for reference but not remappable. */
export const FIXED: [string, string][] = [
  ['Switch to tab 1–8 / last tab', 'Ctrl+1…8 / Ctrl+9'], ['Move through files', 'Arrows, Page Up/Down, Home, End'],
  ['Jump to a name', 'Type its first letters'], ['Photo viewer: rotate / crop / pencil', 'R / C / P'],
];

const CODES: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', IntlBackslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backquote: '`', Space: 'Space',
};
type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** "Ctrl+Shift+N" for a key event; '' for a lone modifier. Letters follow the keyboard layout. */
export function comboOf(e: KeyLike) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return '';
  const k = e.key;
  const name = k.length === 1 && /\p{L}/u.test(k) ? k.toUpperCase()
    : /^(Digit|Numpad)\d$/.test(e.code) ? e.code.slice(-1)
    : k === ' ' ? 'Space'
    : k.length === 1 && !e.shiftKey ? k
    : CODES[e.code] ?? (k.length === 1 ? k.toUpperCase() : k);
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', name].filter(Boolean).join('+');
}

/** An action's keys given the user's overrides (only changed actions are stored). */
export const keysIn = (id: ActionId, map: Record<string, string[]>) => map[id] ?? ACTIONS[id].keys;

/** Combos used by more than one action: combo → action ids. */
export function conflictsIn(map: Record<string, string[]>) {
  const by = new Map<string, ActionId[]>();
  for (const id of Object.keys(ACTIONS) as ActionId[]) for (const c of keysIn(id, map)) by.set(c, [...(by.get(c) ?? []), id]);
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** "Ctrl+ArrowLeft" → "Ctrl+←". */
export const pretty = (combo: string) => combo.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
