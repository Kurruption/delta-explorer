// Tabs as plain data: what a pane holds, and the pure moves on it (reorder, duplicate, lock, move between panes).

export type Tab = { id: number; history: string[]; idx: number; /** Tab colour ("#rrggbb"). */ color?: string; /** Navigating from a locked tab opens a new tab. */ locked?: boolean };
export type PaneState = { tabs: Tab[]; active: number };
/** A tab travelling to another pane or window. */
export type TabPayload = Omit<Tab, 'id'>;

let nextId = 1;
export const newTab = (path: string): Tab => ({ id: nextId++, history: [path], idx: 0 });
export const fromPayload = (t: TabPayload): Tab => ({ ...t, history: t.history.length ? t.history : ['delta:home'], idx: Math.min(Math.max(0, t.idx), Math.max(0, t.history.length - 1)), id: nextId++ });
export const payload = ({ id: _id, ...t }: Tab): TabPayload => t;

export const pathOfTab = (t: Tab) => t.history[t.idx];

/** Moves tab `from` to position `to`; the active tab stays the same tab. */
export function moveTab(s: PaneState, from: number, to: number): PaneState {
  if (from === to || from < 0 || from >= s.tabs.length) return s;
  const tabs = [...s.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, t);
  return { tabs, active: tabs.indexOf(s.tabs[s.active]) };
}

/** Takes tab `i` out; an emptied pane gets a Home tab. */
export function removeTab(s: PaneState, i: number): PaneState {
  if (s.tabs.length === 1) return { tabs: [newTab('delta:home')], active: 0 };
  const tabs = s.tabs.filter((_, j) => j !== i);
  return { tabs, active: s.active > i || s.active === s.tabs.length - 1 ? Math.max(0, s.active - 1) : s.active };
}

/** Adds a tab (after `at`, or at the end) and makes it active. */
export function insertTab(s: PaneState, t: Tab, at = s.tabs.length - 1): PaneState {
  const tabs = [...s.tabs];
  tabs.splice(at + 1, 0, t);
  return { tabs, active: at + 1 };
}

export const duplicateTab = (s: PaneState, i: number) => insertTab(s, fromPayload({ ...payload(s.tabs[i]), locked: false }), i);
export const editTab = (s: PaneState, i: number, f: (t: Tab) => Tab): PaneState => ({ ...s, tabs: s.tabs.map((t, j) => (j === i ? f(t) : t)) });
