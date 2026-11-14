// Delta's saved data as one portable bundle: export/import (with a preview) and named profiles.
// Everything Delta keeps lives in localStorage as JSON (see store.ts `persisted`), so a bundle is those keys.

export const APP_ID = 'delta-explorer';
/** Never exported or switched: the profile list itself and which tabs are open right now. */
const LOCAL = new Set(['profiles', 'session']);
const KEY = /^[\w:.-]{1,80}$/;

export interface Bundle { app: typeof APP_ID; version: 1; exported: string; data: Record<string, unknown> }

/** Friendly names for the keys people will recognise in a preview. */
export const KEY_NAMES: Record<string, string> = {
  settings: 'Settings', pinned: 'Pinned folders', recent: 'Recent files', tags: 'Tags', tagged: 'Tagged files', folderColors: 'Folder colours',
  folderViews: 'Folder layouts', workspaces: 'Workspaces', keymap: 'Keyboard shortcuts',
};

type Storage = Pick<globalThis.Storage, 'length' | 'key' | 'getItem'>;

/** Current data (parsed), minus the per-machine keys. */
export function snapshot(ls: Storage = localStorage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (!k || LOCAL.has(k) || !KEY.test(k)) continue;
    try { out[k] = JSON.parse(ls.getItem(k) ?? 'null'); } catch { /* not ours */ }
  }
  return out;
}

export const makeBundle = (data: Record<string, unknown>, now = new Date()): Bundle => ({ app: APP_ID, version: 1, exported: now.toISOString(), data });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** Shape checks for the keys Delta knows; unknown keys (from newer versions) only need to be valid JSON. */
const SHAPES: Record<string, (v: unknown) => boolean> = {
  settings: isObj,
  pinned: strings,
  recent: strings,
  tags: (v) => Array.isArray(v) && v.every((t) => isObj(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.color === 'string'),
  tagged: (v) => isObj(v) && Object.values(v).every((x) => isObj(x) && typeof x.path === 'string' && strings(x.tags)),
  folderColors: (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string'),
  folderViews: (v) => isObj(v) && Object.values(v).every((x) => x === 'list' || x === 'grid'),
  workspaces: (v) => Array.isArray(v) && v.every((w) => isObj(w) && typeof w.name === 'string' && Array.isArray(w.panes) && w.panes.every(strings)),
  keymap: (v) => isObj(v) && Object.values(v).every(strings),
};

/** Parses and checks an exported file. Throws a readable message if it isn't a Delta export. */
export function parseBundle(text: string): Bundle {
  let b: unknown;
  try { b = JSON.parse(text); } catch { throw new Error('This file isn’t valid JSON.'); }
  if (!isObj(b) || b.app !== APP_ID || !isObj(b.data)) throw new Error('This isn’t a Delta Explorer settings file.');
  if (b.version !== 1) throw new Error('This file is from a newer Delta Explorer; update Delta first.');
  for (const [k, v] of Object.entries(b.data)) {
    if (!KEY.test(k) || LOCAL.has(k)) throw new Error(`Unexpected entry “${k.slice(0, 40)}”.`);
    if (SHAPES[k] && !SHAPES[k](v)) throw new Error(`“${KEY_NAMES[k] ?? k}” in this file is damaged.`);
  }
  return b as unknown as Bundle;
}

export interface Change { key: string; name: string; kind: 'added' | 'changed' | 'unchanged' | 'removed'; detail: string }

const count = (v: unknown) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 1);
/** What importing `next` over `cur` would do, key by key (for the preview). Keys missing from `next` stay as they are. */
export function diff(cur: Record<string, unknown>, next: Record<string, unknown>): Change[] {
  return Object.keys(next).sort().map((key) => {
    const name = KEY_NAMES[key] ?? key;
    const a = cur[key], b = next[key];
    if (a === undefined) return { key, name, kind: 'added', detail: `${count(b)} item${count(b) === 1 ? '' : 's'}` };
    if (JSON.stringify(a) === JSON.stringify(b)) return { key, name, kind: 'unchanged', detail: 'no change' };
    if (isObj(a) && isObj(b) && !Array.isArray(a)) {
      const n = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))).size;
      return { key, name, kind: 'changed', detail: key === 'settings' ? `${n} setting${n === 1 ? '' : 's'} change` : `${count(a)} → ${count(b)} entries` };
    }
    return { key, name, kind: 'changed', detail: `${count(a)} → ${count(b)}` };
  });
}

// ---------------- profiles ----------------
export interface Profiles { active: string; list: { name: string; data: Record<string, unknown> }[] }
export const readProfiles = (): Profiles => {
  try { const p = JSON.parse(localStorage.getItem('profiles') ?? 'null'); if (p?.list) return p; } catch { /* fresh */ }
  return { active: 'Default', list: [] };
};
const writeProfiles = (p: Profiles) => localStorage.setItem('profiles', JSON.stringify(p));

/** Replaces Delta's data with `data` (keys not in it are removed), then reloads every window. */
export function applyData(data: Record<string, unknown>, removeOthers: boolean) {
  if (removeOthers) for (const k of Object.keys(snapshot())) if (!(k in data)) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
  location.reload();
}

/** Saves the current data as the active profile, then loads `name` (new profiles start as a copy). */
export function switchProfile(name: string) {
  const p = readProfiles();
  const list = p.list.filter((x) => x.name !== p.active).concat({ name: p.active, data: snapshot() });
  const target = list.find((x) => x.name === name);
  writeProfiles({ active: name, list: target ? list : [...list, { name, data: snapshot() }] });
  if (target) applyData(target.data, true);
}

export function deleteProfile(name: string) {
  const p = readProfiles();
  if (name === p.active) throw new Error('Switch to another profile before deleting this one.');
  writeProfiles({ ...p, list: p.list.filter((x) => x.name !== name) });
}
