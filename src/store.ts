import { useSyncExternalStore } from 'react';
import type { View } from './FileList';
import type { SortKey, RemoteConn } from './api';
import type { GroupBy } from './layout';

// Tiny shared stores. `persisted` keeps per-user preferences in localStorage; storage can be unavailable,
// so every access is guarded and the app works (without remembering) if it fails.
const read = <T,>(k: string, d: T): T => {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};
const write = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not persisted */ }
};

export interface Store<T> {
  get: () => T;
  set: (next: T | ((v: T) => T)) => void;
  use: () => T;
}

export function store<T>(initial: T, persistKey?: string): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
  // Another Delta window changed this value: take it, so windows never overwrite each other's changes.
  if (persistKey && typeof addEventListener === 'function') {
    addEventListener('storage', (e) => {
      if (e.key !== persistKey || e.newValue === null) return;
      try { value = JSON.parse(e.newValue) as T; subs.forEach((f) => f()); } catch { /* ignore a bad write */ }
    });
  }
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (v: T) => T)(value) : next;
      if (persistKey) write(persistKey, value);
      subs.forEach((f) => f());
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
export const memory = <T,>(initial: T) => store(initial);
/** `upgrade` lets older saved data pick up fields added in newer versions. */
export const persisted = <T,>(key: string, initial: T, upgrade?: (saved: T) => T) => store(upgrade ? upgrade(read(key, initial)) : read(key, initial), key);

// ---------------- settings ----------------
export type ThemeId = 'system' | 'dark' | 'light' | 'midnight' | 'oled';
export type Motion = 'full' | 'reduced' | 'off';
export interface Settings {
  theme: ThemeId;
  accent: string;
  density: 'comfortable' | 'compact';
  motion: Motion;
  showHidden: boolean;
  photosInViewer: boolean;
  defaultView: View;
  hotkey: string;
  sidebar: boolean;
  sections: Record<string, boolean>;
  splitRatio: number;
  /** 0.35 – 1. Below 1 the window shows the desktop through it (blurred). */
  windowOpacity: number;
  windowEffect: 'acrylic' | 'mica';
  /** Last used sort, kept across restarts. */
  sort: { key: SortKey; desc: boolean };
  /** Off: names show without their extension (shortcuts and apps never show one). */
  showExtensions: boolean;
  /** Sidebar sections, top to bottom, and the ones the user hid. */
  sectionOrder: SectionId[];
  hiddenSections: SectionId[];
  /** Tabs above the toolbar (browser-style) or along the bottom (Dorion-style). */
  tabsPosition: 'top' | 'bottom';
  /** full: always open · rail: icons, expands on hover · floating: hidden, slides in from the edge (Zen compact). */
  sidebarStyle: 'full' | 'rail' | 'floating';
  sidebarSide: 'left' | 'right';
  /** Whole-app zoom, 0.8 – 1.3. */
  uiScale: number;
  corners: 'sharp' | 'soft' | 'round';
  /** Grid view icon size. */
  iconSize: 'small' | 'medium' | 'large' | 'huge';
  /** Each folder remembers list/grid (like File Explorer); off: one layout everywhere. */
  /** Off: one layout for every folder. (Renamed from viewPerFolder so everyone starts on the shared layout.) */
  layoutPerFolder: boolean;
  /** Plain folders in Delta indigo, or in the accent colour. */
  folderTint: 'delta' | 'accent';
  /** A picture shown behind the files ('' = none), how strongly, and how blurred. */
  bgImage: string;
  bgOpacity: number;
  bgBlur: number;
  /** Crop: zoom (1 = just fills) and focal point in % of the picture. fit 'whole' shows all of it instead of filling. */
  bgZoom: number;
  bgX: number;
  bgY: number;
  bgFit: 'fill' | 'whole';
  /** Preview pane beside the file list (Alt+P), and its width in px. */
  previewPane: boolean;
  previewWidth: number;
  /** Details view columns (left to right) and the second sort key (Shift+click a header). */
  columns: Col[];
  sortThen: { key: SortKey; desc: boolean } | null;
  groupBy: GroupBy;
  /** Fill the Size column of folders by walking them in the background. */
  folderSizes: boolean;
  /** Hovering an item shows a small card with its details. */
  hoverCards: boolean;
  /** Command bar buttons, in order: built-in ids (see CommandBar.tsx), "sep:<n>", or "cmd:<palette id>". */
  cmdbar: string[];
  /** Archive compression level: fast = 1, balanced = 6, smallest = 9. */
  compression: 'fast' | 'balanced' | 'smallest';
}
export type ColId = 'name' | 'modified' | 'created' | 'accessed' | 'type' | 'ext' | 'size' | 'attrs' | 'dims' | 'duration';
export interface Col { id: ColId; w: number }
export const DEFAULT_COLUMNS: Col[] = [{ id: 'name', w: 220 }, { id: 'modified', w: 150 }, { id: 'type', w: 130 }, { id: 'size', w: 90 }];
export type SectionId = 'pinned' | 'places' | 'cloud' | 'drives' | 'recent' | 'tags' | 'workspaces' | 'collections' | 'folders' | 'remote';
export const SECTION_NAMES: Record<SectionId, string> = {
  pinned: 'Pinned', places: 'Places', cloud: 'Cloud', drives: 'Drives', recent: 'Recent', tags: 'Tags', workspaces: 'Workspaces', collections: 'Collections', folders: 'Folders', remote: 'Remote',
};
const DEFAULTS: Settings = {
  theme: 'dark',
  accent: 'indigo',
  density: 'comfortable',
  motion: 'full',
  showHidden: false,
  photosInViewer: true,
  defaultView: 'list',
  hotkey: '',
  sidebar: true,
  sections: { pinned: true, places: true, cloud: true, drives: true, recent: false, tags: true, workspaces: false, collections: true, folders: false, remote: true },
  splitRatio: 0.5,
  windowOpacity: 1,
  windowEffect: 'acrylic',
  sort: { key: 'name', desc: false },
  showExtensions: true,
  sectionOrder: ['pinned', 'places', 'cloud', 'drives', 'recent', 'tags', 'workspaces', 'collections', 'folders', 'remote'],
  hiddenSections: [],
  tabsPosition: 'bottom',
  sidebarStyle: 'full',
  sidebarSide: 'left',
  uiScale: 1,
  corners: 'soft',
  iconSize: 'medium',
  layoutPerFolder: false,
  folderTint: 'delta',
  bgImage: '',
  bgOpacity: 0.18,
  bgBlur: 0,
  bgZoom: 1,
  bgX: 50,
  bgY: 50,
  bgFit: 'fill',
  previewPane: false,
  previewWidth: 340,
  columns: DEFAULT_COLUMNS,
  sortThen: null,
  groupBy: 'none',
  folderSizes: false,
  hoverCards: true,
  cmdbar: ['newFolder', 'sep:1', 'cut', 'copy', 'paste', 'rename', 'delete', 'sep:2', 'properties', 'selectAll'],
  compression: 'fast',
};
export const settings = persisted<Settings>('settings', DEFAULTS, (saved) => {
  const s: Settings = { ...DEFAULTS, ...saved };
  // Sections added in later versions appear at the end of a saved order.
  s.sectionOrder = [...s.sectionOrder.filter((x) => x in SECTION_NAMES), ...DEFAULTS.sectionOrder.filter((x) => !s.sectionOrder.includes(x))];
  s.hiddenSections = (s.hiddenSections ?? []).filter((x) => x in SECTION_NAMES);
  s.sections = { ...DEFAULTS.sections, ...s.sections }; // new sections start open
  return s;
});
export const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => settings.set((s) => ({ ...s, [k]: v }));

export const THEMES: { id: ThemeId; name: string; desc: string; swatch: [string, string, string] }[] = [
  { id: 'system', name: 'System', desc: 'Follows Windows', swatch: ['#f6f6fa', '#18181f', '#8b83ff'] },
  { id: 'dark', name: 'Delta Dark', desc: 'Default', swatch: ['#111117', '#18181f', '#8b83ff'] },
  { id: 'light', name: 'Delta Light', desc: 'Bright and calm', swatch: ['#eeeef5', '#ffffff', '#4338ca'] },
  { id: 'midnight', name: 'Midnight', desc: 'Deep blue night', swatch: ['#0b0e1a', '#121729', '#8b83ff'] },
  { id: 'oled', name: 'OLED Black', desc: 'True black', swatch: ['#000000', '#0b0b0e', '#8b83ff'] },
];
/** Each accent has a colour for light themes and a brighter one for dark themes. */
export const ACCENTS = [
  { id: 'indigo', name: 'Delta Indigo', light: '#4338ca', dark: '#8b83ff' },
  { id: 'violet', name: 'Violet', light: '#7c3aed', dark: '#b18cff' },
  { id: 'blue', name: 'Blue', light: '#2563eb', dark: '#7aa7ff' },
  { id: 'teal', name: 'Teal', light: '#0f8f7e', dark: '#3fd3bd' },
  { id: 'rose', name: 'Rose', light: '#d61f4f', dark: '#ff7a96' },
  { id: 'amber', name: 'Amber', light: '#b45309', dark: '#ffb35c' },
];

const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const resolvedTheme = (t: ThemeId) => (t === 'system' ? (prefersDark() ? 'dark' : 'light') : t);

/** Applies theme, accent, density and motion to <html>. */
export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  const theme = resolvedTheme(s.theme);
  root.dataset.theme = theme;
  root.dataset.density = s.density;
  root.dataset.motion = s.motion;
  root.dataset.corners = s.corners;
  // A preset accent, or any colour picked on the colour wheel ("#rrggbb").
  const a = s.accent.startsWith('#') ? { light: s.accent, dark: s.accent } : ACCENTS.find((x) => x.id === s.accent) ?? ACCENTS[0];
  root.style.setProperty('--accent', theme === 'light' ? a.light : a.dark);
  root.dataset.folders = s.folderTint;
  root.style.setProperty('--alpha', String(s.windowOpacity));
}

// ---------------- user data ----------------
export const pinned = persisted<string[]>('pinned', []);
export const recent = persisted<string[]>('recent', []);
/** Drops Recent entries whose files were deleted or moved away. */
export const pruneRecent = (gone: string[]) => gone.length && recent.set((r) => r.filter((p) => !gone.includes(p)));
export const addRecent = (p: string) => recent.set((r) => [p, ...r.filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 40));

export interface Tag { id: string; name: string; color: string }
export const tags = persisted<Tag[]>('tags', [
  { id: 'red', name: 'Important', color: '#ff5d6c' },
  { id: 'orange', name: 'In progress', color: '#ff9f43' },
  { id: 'yellow', name: 'Review', color: '#ffd43b' },
  { id: 'green', name: 'Done', color: '#2bd9a0' },
  { id: 'blue', name: 'Personal', color: '#5aa7ff' },
  { id: 'purple', name: 'Delta', color: '#a78bfa' },
]);
/** path (lowercase) -> tag ids, plus the original-case path so lists show it properly. */
export const tagged = persisted<Record<string, { path: string; tags: string[] }>>('tagged', {});
export const tagsOf = (all: Record<string, { path: string; tags: string[] }>, p: string) => all[p.toLowerCase()]?.tags ?? [];
export const toggleTag = (p: string, id: string) =>
  tagged.set((t) => {
    const k = p.toLowerCase();
    const cur = t[k]?.tags ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const out = { ...t };
    if (next.length) out[k] = { path: p, tags: next }; else delete out[k];
    return out;
  });
export const pathsWithTag = (id: string) => Object.values(tagged.get()).filter((v) => v.tags.includes(id)).map((v) => v.path);

/** A file or folder was renamed or moved: its tags, pins and recent entries follow it (also everything inside a moved folder). */
export function movePathRefs(from: string, to: string) {
  const f = from.toLowerCase();
  const map = (p: string) => {
    const l = p.toLowerCase();
    return l === f ? to : l.startsWith(f + '\\') ? to + p.slice(from.length) : null;
  };
  tagged.set((t) => {
    if (!Object.keys(t).some((k) => map(k) !== null)) return t;
    const out: typeof t = {};
    for (const [k, v] of Object.entries(t)) { const n = map(v.path); out[n ? n.toLowerCase() : k] = n ? { ...v, path: n } : v; }
    return out;
  });
  pinned.set((ps) => (ps.some((p) => map(p) !== null) ? ps.map((p) => map(p) ?? p) : ps));
  // Folder colours and layouts are keyed by lowercase path.
  for (const st of [folderColors, folderViews, folderColumns] as unknown as Store<Record<string, string>>[]) {
    st.set((m) => {
      if (!Object.keys(m).some((k) => map(k) !== null)) return m;
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [map(k)?.toLowerCase() ?? k, v]));
    });
  }
  recent.set((rs) => (rs.some((p) => map(p) !== null) ? rs.map((p) => map(p) ?? p) : rs));
  shelf.set((rs) => (rs.some((p) => map(p) !== null) ? rs.map((p) => map(p) ?? p) : rs));
  collections.set((cs) => (cs.some((c) => c.paths.some((p) => map(p) !== null)) ? cs.map((c) => ({ ...c, paths: c.paths.map((p) => map(p) ?? p) })) : cs));
}

/** Per-folder colour (Right-click a folder → Folder colour); keyed by lowercase path. */
export const folderColors = persisted<Record<string, string>>('folderColors', {});
export const FOLDER_COLORS = [
  { name: 'Red', c: '#E5484D' }, { name: 'Orange', c: '#F2802E' }, { name: 'Yellow', c: '#E9B32A' }, { name: 'Green', c: '#30A46C' },
  { name: 'Teal', c: '#12A594' }, { name: 'Blue', c: '#3E7CF0' }, { name: 'Purple', c: '#8E4EC6' }, { name: 'Pink', c: '#D6409F' }, { name: 'Grey', c: '#7C7F8A' },
];
/** Layout each folder was last shown in (when Settings → Files → "Remember layout per folder" is on). */
export const folderViews = persisted<Record<string, View>>('folderViews', {});

export interface Workspace { name: string; panes: string[][]; split: boolean }
export const workspaces = persisted<Workspace[]>('workspaces', []);
/** Tabs of each pane, restored on the next launch. */
export const session = persisted<{ panes: string[][]; split: boolean; /** Tab colour/lock, same shape as panes. */ meta?: ({ color?: string; locked?: boolean } | null)[][] } | null>('session', null);

// ---------------- undo ----------------
export interface UndoStep { label: string; run: () => Promise<unknown> }
export const undoStack = memory<UndoStep[]>([]);
export const pushUndo = (u: UndoStep) => undoStack.set((s) => [...s.slice(-49), u]);
/** Records an undo step and shows a toast with an Undo button (Ctrl+Z also works). */
export function undoable(u: UndoStep, message: string) {
  pushUndo(u);
  toast(message, 'info', {
    label: 'Undo',
    run: () => { undoStack.set((s) => s.filter((x) => x !== u)); u.run().then(() => toast(`Undone: ${u.label}`), errorToast); },
  });
}

// ---------------- toasts ----------------
export interface Toast { id: number; text: string; kind: 'error' | 'info'; action?: { label: string; run: () => void } }
export const toasts = memory<Toast[]>([]);
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = ++toastId;
  toasts.set((t) => [...t.slice(-3), { id, text, kind, action }]);
  // Toasts with an action (Undo) stay longer so there's time to use them.
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 9000 : 4000);
}
export const errorToast = (e: unknown) => toast(String(e), 'error');
/** Picture the background editor is open for (null = closed). */
export const bgEditor = store<string | null>(null);

// ---------------- power features ----------------
/** Drop Zone: files parked while navigating; kept until cleared. */
export const shelf = persisted<string[]>('shelf', []);
export const addToShelf = (paths: string[]) => shelf.set((s) => [...s, ...paths.filter((p) => !s.some((x) => x.toLowerCase() === p.toLowerCase()))]);
/** Collections: virtual folders of files from anywhere ("v:col:<id>"). */
export interface Collection { id: string; name: string; paths: string[] }
export const collections = persisted<Collection[]>('collections', []);
export const newCollection = (name: string, paths: string[] = []) => {
  const c = { id: Date.now().toString(36), name, paths };
  collections.set((cs) => [...cs, c]);
  return c;
};
export const addToCollection = (id: string, paths: string[]) =>
  collections.set((cs) => cs.map((c) => (c.id === id ? { ...c, paths: [...c.paths, ...paths.filter((p) => !c.paths.some((x) => x.toLowerCase() === p.toLowerCase()))] } : c)));
export const removeFromCollection = (id: string, paths: string[]) =>
  collections.set((cs) => cs.map((c) => (c.id === id ? { ...c, paths: c.paths.filter((x) => !paths.some((p) => p.toLowerCase() === x.toLowerCase())) } : c)));
/** Open compare dialog: two folders or two files. */
export const compareDialog = store<{ kind: 'folders' | 'files'; a: string; b: string } | null>(null);
/** File the metadata dialog is open for. */
export const metaDialog = store<string | null>(null);
/** Columns each folder was last shown with (when "Remember layout per folder" is on). */
export const folderColumns = persisted<Record<string, Col[]>>('folderColumns', {});
/** Named view presets (toolbar → View options). */
export interface ViewProfile { name: string; columns: Col[]; sort: Settings['sort']; sortThen: Settings['sortThen']; groupBy: GroupBy; view: View; iconSize: Settings['iconSize'] }
export const viewProfiles = persisted<ViewProfile[]>('viewProfiles', []);
/** Saved remote connections (host/user/path only; passwords are in Windows Credential Manager). */
export const remotes = persisted<RemoteConn[]>('remotes', []);
/** Connection being added ('new') or edited in the remote dialog (null = closed). */
export const remoteEditor = store<RemoteConn | 'new' | null>(null);
/** Open tool dialog (src/Tools.tsx): checksums of a file, duplicates/storage of a folder, compress or extract-to items. */
export type ToolKind = 'checksums' | 'dupes' | 'storage' | 'compress' | 'extractTo' | 'cleaner';
export const tool = store<{ kind: ToolKind; paths: string[] } | null>(null);
export const openTool = (kind: ToolKind, paths: string[]) => tool.set({ kind, paths });
