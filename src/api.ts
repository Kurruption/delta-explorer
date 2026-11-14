import { convertFileSrc, invoke } from '@tauri-apps/api/core';

// Mirrors the Rust types in de-core / de-shell / src-tauri (camelCase via serde).
// shortcut: hand-written types; generate them with tauri-specta once it leaves RC and the command count grows.
export interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
  hidden: boolean;
  created: number;
  accessed: number;
  /** Windows attributes: R 0x1, H 0x2, S 0x4, A 0x20. */
  attrs: number;
}
export interface Page {
  path: string;
  total: number;
  offset: number;
  entries: Entry[];
  /** Empty unless grouped (see src/layout.ts). */
  groups: import('./layout').Group[];
}
export type SortKey = 'name' | 'modified' | 'size' | 'kind' | 'created' | 'accessed' | 'attrs';
/** Details view extras for list_dir (src-tauri/src/details.rs ListOpts). */
export interface ListOpts { then: SortKey | null; thenDesc: boolean; group: import('./layout').GroupBy; bounds: number[]; collapsed: string[] }
export interface Place { name: string; path: string }
export interface Drive { path: string; label: string; total: number; free: number; kind: string }
export interface Places { home: string; quick: Place[]; drives: Drive[]; cloud: Place[] }

export const listDir = (path: string, offset: number, limit: number, opts: { refresh?: boolean; sort?: SortKey; desc?: boolean; filter?: string; showHidden?: boolean; view?: ListOpts } = {}) =>
  invoke<Page>('list_dir', { path, offset, limit, refresh: opts.refresh ?? false, sort: opts.sort, desc: opts.desc, filter: opts.filter || null, showHidden: opts.showHidden ?? false, opts: opts.view ?? null });
export const places = () => invoke<Places>('places');
export const openPath = (path: string) => invoke<void>('open_path', { path });
export const properties = (path: string) => invoke<void>('properties', { path });
export const setVirtual = (key: string, paths: string[]) => invoke<void>('set_virtual', { key, paths });
export const createDir = (parent: string, name: string) => invoke<string>('create_dir', { parent, name });
/** Resolves to the name actually used ("Name (1).txt" when the typed one was taken). */
export const renamePath = (path: string, name: string) => invoke<string>('rename', { path, name });
export const recycle = (paths: string[]) => invoke<void>('recycle', { paths });

// ---- path + formatting helpers ----
export const HOME = 'delta:home';
/** In search results and virtual lists (dir === '') names are already absolute paths. */
export const joinPath = (dir: string, name: string) => (!dir ? name : isRemote(dir) ? (dir.endsWith('/') ? dir + name : `${dir}/${name}`) : dir.endsWith('\\') ? dir + name : `${dir}\\${name}`);
/** Network share root ("\\server\share"), or null for local paths. */
export const uncRoot = (p: string) => /^\\\\[^\\]+\\[^\\]+/.exec(p)?.[0] ?? null;
/** Parent folder; a drive root's (or network share's) parent is the Home page. */
export const parentPath = (p: string): string => {
  const a = parseArchive(p);
  if (a) return a.inner.includes('\\') ? archivePath(a.file, a.inner.slice(0, a.inner.lastIndexOf('\\'))) : a.inner ? archivePath(a.file) : parentPath(a.file);
  if (isRemote(p)) {
    const root = remoteRoot(p), r = p.replace(/\/+$/, ''), j = r.lastIndexOf('/');
    return r.length < root.length ? HOME : j < root.length ? root : r.slice(0, j);
  }
  const t = p.replace(/\\+$/, '');
  const unc = uncRoot(t);
  if (unc && t.length <= unc.length) return HOME;
  const i = t.lastIndexOf('\\');
  if (i < 0) return HOME;
  if (unc && i < unc.length) return unc;
  return i <= 2 ? t.slice(0, 3) : t.slice(0, i);
};
export const baseName = (p: string): string => {
  const a = parseArchive(p);
  if (a) return a.inner ? a.inner.split('\\').pop()! : baseName(a.file);
  return p === HOME ? 'Home' : isRemote(p) ? p.replace(/\/+$/, '').split('/').pop() || p : p.replace(/\\+$/, '').split('\\').pop() || p;
};

// ---- pseudo locations (served by list_dir in Rust) ----
/** Recursive search under `root`. */
export const searchPath = (root: string, q: string) => `search:${root}?${q}`;
export const parseSearch = (p: string) => {
  if (!p.startsWith('search:')) return null;
  const rest = p.slice(7);
  const i = rest.indexOf('?');
  return i < 0 ? null : { root: rest.slice(0, i), q: rest.slice(i + 1) };
};
/** Search results and lists the UI provides (Tags, Recent: "v:<key>"). */
export const isVirtual = (p: string) => p.startsWith('v:') || p.startsWith('search:') || p.startsWith('archive:');
/** A real folder you can paste into, watch, create files in. */
export const isFolder = (p: string) => p !== HOME && p !== 'delta:bin' && !isVirtual(p);

export const fmtSize = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`;
};
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "3 hours ago" style, like the reference designs; full date in the tooltip. */
export const fmtAgo = (s: number) => {
  if (!s) return '';
  const d = s - Date.now() / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = d;
  for (const [n, unit] of steps) {
    if (Math.abs(v) < n) return unit === 'second' ? 'just now' : rtf.format(Math.round(v), unit);
    v /= n;
  }
  return '';
};
export const fmtDate = (s: number) => (s ? new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KINDS: Record<string, string> = { lnk: 'Shortcut', url: 'Internet shortcut', exe: 'Application', 'appref-ms': 'Application', msi: 'Installer', dll: 'Library' };
export const kindOf = (e: Entry) => {
  if (e.isDir) return 'Folder';
  const ext = e.name.includes('.') && !e.name.startsWith('.') ? e.name.split('.').pop()!.toLowerCase() : '';
  return ext ? KINDS[ext] ?? `${ext.toUpperCase()} file` : 'File';
};
/** Extensions Explorer never shows: a shortcut or app reads as its name ("Blender 5.2", not "Blender 5.2.lnk"). */
const HIDDEN_EXT = new Set(['lnk', 'url', 'exe', 'appref-ms', 'pif']);
export const displayName = (name: string, isDir: boolean, showExtensions: boolean) => {
  const i = name.lastIndexOf('.');
  if (isDir || i <= 0) return name;
  return !showExtensions || HIDDEN_EXT.has(name.slice(i + 1).toLowerCase()) ? name.slice(0, i) : name;
};
export const watchDirs = (paths: string[]) => invoke<void>('watch_dirs', { paths });
/** OLE drag out of the window; resolves true if another app accepted the drop. */
export const startDrag = (paths: string[]) => invoke<boolean>('start_drag', { paths });
/** Same comparison form as src-tauri/src/watch.rs `norm`. */
export const normPath = (p: string) => {
  const s = p.toLowerCase().replace(/^\\\\\?\\/, '');
  return s.length > 3 ? s.replace(/\\+$/, '') : s;
};
export const driveOf = (p: string) => (isRemote(p) ? remoteRoot(p) : p.slice(0, 2)).toLowerCase();

// ---- open with ----
export interface App { id: string; name: string; icon: string | null; recommended: boolean }
export const appsFor = (path: string) => invoke<App[]>('apps_for', { path });
export const openWith = (path: string, app: string) => invoke<void>('open_with', { path, app });
export const chooseApp = (path: string) => invoke<void>('choose_app', { path });

// ---- photo viewer ----
export const VIEWABLE = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|ico)$/i;
export const SAVABLE = /\.(png|jpe?g|webp)$/i;
export const imageUrl = (path: string, mtime = 0) => `${convertFileSrc(path, 'thumb')}?k=f&m=${mtime}&t=${Date.now()}`;
/** App icons: exe/dll/ico give their icon; Store apps give a PNG logo, shown as a thumbnail. */
export const iconUrl = (file: string) => `${convertFileSrc(file, 'thumb')}?k=${/\.png$/i.test(file) ? 't' : 'i'}&s=32`;
/** Raw-bytes IPC (no JSON): returns the path actually written. */
export const saveImage = async (path: string, blob: Blob, mode: 'overwrite' | 'copy') =>
  invoke<string>('save_image', new Uint8Array(await blob.arrayBuffer()), { headers: { path: encodeURIComponent(path), mode } });

// ---- background jobs (progress arrives as "job" events) ----
export type JobKind = 'copy' | 'move' | 'zip' | 'extract' | 'sync';
export interface ConflictSide { path: string; isDir: boolean; size: number; modified: number }
export interface JobUpdate {
  id: number; kind: JobKind; label: string; done: number; total: number; current: string;
  state: 'running' | 'conflict' | 'done' | 'error' | 'cancelled'; error: string | null; created: string[]; moved: [string, string][];
  dest: string | null; conflict: { src: ConflictSide; dst: ConflictSide } | null; failed: [string, string][]; replaced: string[];
  /** Only on a failed copy/move (for "Try as administrator"). */
  items?: string[];
}
export type ConflictChoice = 'replace' | 'skip' | 'keepBoth';
export const resolveConflict = (id: number, choice: ConflictChoice, all: boolean) => invoke<void>('resolve_conflict', { id, choice, all });
export const startJob = (kind: JobKind, items: string[], dest?: string) => invoke<number>('start_job', { kind, items, dest: dest ?? null });
export const cancelJob = (id: number) => invoke<void>('cancel_job', { id });
export const restore = (paths: string[]) => invoke<number>('restore', { paths });

// ---- Windows integration ----
/** Windows' own right-click menu (shell extensions). x/y: page coordinates. Empty items = folder background. */
export const shellMenu = (folder: string, items: string[], x: number, y: number, extended = false) => invoke<void>('shell_menu', { folder, items, x, y, extended });
export interface NativeItem { id: number; label: string; disabled: boolean; sub: NativeItem[] }
/** Windows' right-click entries (id 0 = separator), drawn inside Delta's own menu. */
export const shellMenuItems = (folder: string, items: string[], extended = false) => invoke<NativeItem[]>('shell_menu_items', { folder, items, extended });
export const shellMenuInvoke = (id: number, x: number, y: number) => invoke<void>('shell_menu_invoke', { id, x, y });
export const integration = () => invoke<{ winE: boolean; autostart: boolean }>('integration');
export const setWinE = (on: boolean) => invoke<void>('set_win_e', { on });
export const setAutostart = (on: boolean) => invoke<void>('set_autostart', { on });
export const setHotkey = (keys: string) => invoke<void>('set_hotkey', { keys });
export const launchPath = () => invoke<string | null>('launch_path');
// ---- Recycle Bin (Delta's own view) ----
export interface BinItem { id: string; name: string; original: string; deleted: number; size: number | null; isDir: boolean }
export const BIN = 'delta:bin';
export const binList = () => invoke<BinItem[]>('bin_list');
export const binRestore = (ids: string[]) => invoke<void>('bin_restore', { ids });
export const binPurge = (ids: string[]) => invoke<void>('bin_purge', { ids });
/** Undo a "Replace original" save: edited file -> "name (edited)", original back from the bin. */
export const revertReplace = (path: string) => invoke<string>('revert_replace', { path });
// ---- Windows clipboard (shared with Explorer and other apps) ----
export const clipRead = () => invoke<[string[], boolean] | null>('clip_read');
export const clipWrite = (paths: string[], cut: boolean) => invoke<void>('clip_write', { paths, cut });
/** Typed/pasted address -> real location (quotes, %VARS%, "/" and shortcuts handled). */
export const resolvePath = (input: string) => invoke<{ path: string; isDir: boolean }>('resolve_path', { input });
export const linkTarget = (path: string) => invoke<{ path: string; isDir: boolean } | null>('link_target', { path });
/** Deletes for good, skipping the Recycle Bin (Shift+Delete). */
export const deleteForever = (paths: string[]) => invoke<void>('delete_forever', { paths });
export const existing = (paths: string[]) => invoke<boolean[]>('existing', { paths });
// ---- batch rename, several folders, clipboard text/picture as a file ----
/** Mirrors de_core::rename::Recipe. */
export interface RenameRecipe {
  find: string; replace: string; regex: boolean; matchCase: boolean;
  strip: string; stripSpaces: boolean; stripWith: string;
  case: 'keep' | 'lower' | 'upper' | 'title';
  prefix: string; suffix: string;
  number: boolean; start: number; step: number; pad: number; numberAt: 'start' | 'end';
  date: 'none' | 'modified' | 'created'; dateFormat: string; dateAt: 'start' | 'end';
  sep: string;
  extMode: 'keep' | 'change' | 'remove'; ext: string;
}
export const renamePreview = (paths: string[], recipe: RenameRecipe) =>
  invoke<{ to: string; problem: string | null }[]>('rename_preview', { paths, recipe, tz: -new Date().getTimezoneOffset() });
/** Two-phase rename in Rust; `done` = [old path, new path], `failed` = [old path, why]. */
export const renameApply = (pairs: [string, string][]) => invoke<{ done: [string, string][]; failed: [string, string][] }>('rename_apply', { pairs });
export const createDirs = (parent: string, names: string[]) => invoke<string[]>('create_dirs', { parent, names });
export const clipHasData = () => invoke<boolean>('clip_has_data');
export const pasteClip = (dir: string) => invoke<string | null>('paste_clip', { dir });
// ---- archives (browsed as read-only folders: "archive:<file>?<inner path with \>") ----
/** Archive types Delta opens, extracts and browses. */
export const ARCHIVE = /\.(zip|7z|rar|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i;
export const archivePath = (file: string, inner = '') => `archive:${file}?${inner}`;
export function parseArchive(p: string) {
  if (!p.startsWith('archive:')) return null;
  const i = p.indexOf('?');
  return i < 0 ? null : { file: p.slice(8, i), inner: p.slice(i + 1).replace(/^\\+|\\+$/g, '') };
}
export type ArchiveFormat = 'zip' | 'sevenZ' | 'tarGz';
/** Compresses folders (only folders; Rust refuses anything else). level 0–9. */
export const startArchiveJob = (items: string[], format: ArchiveFormat, level: number, password?: string) =>
  invoke<number>('start_archive_job', { items, format, level, password: password || null });
/** here: next to the archive · folder: into a new "Name" folder · to: a new "Name" folder inside dest. */
export type ExtractMode = 'here' | 'folder' | 'to';
export const startExtractJob = (items: string[], mode: ExtractMode, dest?: string) => invoke<number>('start_extract_job', { items, mode, dest: dest ?? null });
/** Opens a file inside an archive (unpacked to temp first). */
export const archiveOpen = (path: string) => invoke<void>('archive_open', { path });

// ---- tools: checksums, duplicates, storage (progress via "tool-progress" events) ----
export interface ToolProgress { id: number; done: number; current: string }
export const newToolId = () => Math.floor(Math.random() * 2 ** 40);
export const toolCancel = (id: number) => invoke<void>('tool_cancel', { id });
export interface Sums { md5: string; sha1: string; sha256: string }
export const checksums = (id: number, path: string) => invoke<Sums>('checksums', { id, path });
export interface DupFile { path: string; modified: number }
export interface DupGroup { size: number; files: DupFile[] }
export const findDupes = (id: number, root: string) => invoke<DupGroup[]>('find_dupes', { id, root });
export interface StorageNode { name: string; path: string; size: number; isDir: boolean; count: number }
export interface StorageSummary {
  root: string; total: number; files: number; folders: number; skipped: number;
  largestFolders: StorageNode[]; largestFiles: StorageNode[]; types: { ext: string; size: number; count: number }[]; empty: string[];
}
export const storageScan = (id: number, root: string) => invoke<StorageSummary>('storage_scan', { id, root });
export const storageView = (id: number, dir: string) => invoke<StorageNode[]>('storage_view', { id, dir });
export type WindowEffect = 'acrylic' | 'mica' | 'none';
export const setWindowEffect = (effect: WindowEffect) => invoke<void>('set_window_effect', { effect });
// ---- preview pane / Quick Look (src-tauri/src/preview.rs) ----
export interface TextPreview { text: string; binary: boolean; truncated: boolean }
export interface ZipListing { entries: { name: string; size: number; isDir: boolean }[]; total: number }
export const previewText = (path: string) => invoke<TextPreview>('preview_text', { path });
export const previewZip = (path: string) => invoke<ZipListing>('preview_zip', { path });
export const dirCount = (path: string) => invoke<number>('dir_count', { path });
/** The file's own bytes (PDF, audio/video, fonts only), with Range support for seeking. */
export const rawUrl = (path: string, mtime = 0) => `${convertFileSrc(path, 'raw')}?m=${mtime}`;

// ---- power features (src-tauri/src/power.rs) ----
export const listSubdirs = (path: string, showHidden: boolean) => invoke<string[]>('list_subdirs', { path, showHidden });
export type GitState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'ignored' | 'dirty';
export interface GitDir { root: string; branch: string; items: Record<string, GitState>; all: GitState | null; changed: number }
/** null: not in a git repo, or git isn't installed. */
export const gitStatus = (dir: string, refresh = false) => invoke<GitDir | null>('git_status', { dir, refresh });
export const gitChanged = (dir: string) => invoke<string[]>('git_changed', { dir });
export type CmpKind = 'onlyLeft' | 'onlyRight' | 'newerLeft' | 'newerRight' | 'differs' | 'identical' | 'conflict';
export interface CmpSide { size: number; modified: number; isDir: boolean }
export interface CmpItem { rel: string; kind: CmpKind; left: CmpSide | null; right: CmpSide | null }
export type SyncMode = 'leftToRight' | 'rightToLeft' | 'both' | 'mirror';
export interface SyncAction { op: 'copy' | 'replace' | 'delete'; rel: string; toRight: boolean }
export const compareDirs = (left: string, right: string) => invoke<CmpItem[]>('compare_dirs', { left, right });
export const compareContents = (left: string, right: string, rels: string[]) => invoke<boolean[]>('compare_contents', { left, right, rels });
export const planSync = (items: CmpItem[], mode: SyncMode) => invoke<SyncAction[]>('plan_sync', { items, mode });
export const startSync = (left: string, right: string, actions: SyncAction[]) => invoke<number>('start_sync', { left, right, actions });
export interface DiffRow { tag: 'eq' | 'chg' | 'del' | 'add' | 'skip'; l: number | null; r: number | null; a: string; b: string }
export interface FileDiff { text: boolean; rows: DiffRow[]; truncated: boolean; sizeA: number; sizeB: number; hashA: string; hashB: string; identical: boolean; added: number; removed: number }
export const diffFiles = (a: string, b: string) => invoke<FileDiff>('diff_files', { a, b });
export interface AudioTags { title: string; artist: string; album: string; genre: string; track: number }
export interface Meta { kind: 'image' | 'audio' | ''; fields: [string, string][]; tags: AudioTags | null }
export const readMeta = (path: string) => invoke<Meta>('read_meta', { path });
export const writeAudioTags = (path: string, tags: AudioTags) => invoke<void>('write_audio_tags', { path, tags });
export const META_FILE = /\.(jpe?g|tiff?|heic|heif|png|webp|avif|mp3|flac|m4a|mp4|aac|ogg|opus|wav|aiff?|wv|ape|mpc|spx)$/i;
// ---- details view: media columns, folder sizes, free space ----
export interface Media { width: number; height: number; durationMs: number }
export interface DirSize { bytes: number; files: number; dirs: number }
export const mediaInfo = (paths: string[]) => invoke<Media[]>('media_info', { paths });
/** Results arrive as "folder-size" events ({ path, bytes, files, dirs }). `key` groups a pane's requests for cancelling. */
export const folderSizes = (key: string, paths: string[], fresh = false) => invoke<void>('folder_sizes', { key, paths, fresh });
export const cancelFolderSizes = (key: string) => invoke<void>('cancel_folder_sizes', { key });
export const freeSpace = (path: string) => invoke<number | null>('free_space', { path });
export const countItems = (path: string) => invoke<number>('count_items', { path });
// ---- remote connections (SFTP, FTP/FTPS, WebDAV): paths "remote:<id>/<path>", served by list_dir ----
export const REMOTE = 'remote:';
export const isRemote = (p: string) => p.startsWith(REMOTE);
/** "remote:<id>/" for any path on that connection. */
export const remoteRoot = (p: string) => { const i = p.indexOf('/'); return i < 0 ? `${p}/` : p.slice(0, i + 1); };
export const remoteId = (p: string) => remoteRoot(p).slice(REMOTE.length, -1);
export type RemoteProtocol = 'sftp' | 'ftp' | 'ftps' | 'webdav' | 'webdavs';
/** A saved connection. No secrets: passwords live in Windows Credential Manager. */
export interface RemoteConn {
  id: string; name: string; protocol: RemoteProtocol; host: string; port: number; user: string; path: string;
  /** SFTP: private key file ('' = password login). */
  keyFile: string;
  /** SFTP: pinned host key fingerprint ('' = not trusted yet). */
  fingerprint: string;
}
export const remoteHome = (c: RemoteConn) => `${REMOTE}${c.id}/${c.path.replace(/^[/\\]+/, '').replace(/\\/g, '/')}`;
export const remoteConfigure = (conns: RemoteConn[]) => invoke<void>('remote_configure', { conns });
export const remoteSetSecret = (id: string, secret: string) => invoke<void>('remote_set_secret', { id, secret });
export const remoteForget = (id: string) => invoke<void>('remote_forget', { id });
/** Connects and lists the start folder; null secret = use the stored one. */
export const remoteTest = (conn: RemoteConn, secret: string | null) => invoke<void>('remote_test', { conn, secret });
/** Downloads to a temp copy and opens it; resolves to the local copy. */
export const remoteOpen = (path: string) => invoke<string>('remote_open', { path });
// ---- Try as administrator (one operation through an elevated helper; Delta itself never runs elevated) ----
export type ElevatedOp = 'copy' | 'move' | 'recycle' | 'delete' | 'rename' | 'mkdir';
export interface ElevatedRequest { op: ElevatedOp; items: string[]; dest?: string; name?: string }
export interface ElevatedOutcome { ok: boolean; error: string | null; created: string[]; moved: [string, string][] }
export const runElevated = (request: ElevatedRequest) => invoke<ElevatedOutcome>('run_elevated', { request });
// ---- shell extras ----
export const share = (paths: string[]) => invoke<void>('share', { paths });
export type TerminalKind = 'wt' | 'powershell' | 'cmd';
export const openTerminal = (dir: string, kind: TerminalKind) => invoke<void>('open_terminal', { dir, kind });
export const createShortcut = (paths: string[]) => invoke<string[]>('create_shortcut', { paths });
export const sendToTargets = () => invoke<{ name: string; path: string }[]>('send_to_targets');
export const sendTo = (target: string, paths: string[]) => invoke<void>('send_to', { target, paths });
/** Explorer's "Copy as path": each path in quotes, one per line. */
export const quotedPaths = (paths: string[]) => paths.map((p) => `"${p}"`).join('\r\n');
// ---- windows ----
export const newWindow = (init?: unknown, atCursor = false) => invoke<string>('new_window', { init: init ?? null, atCursor });
export const windowInit = <T,>() => invoke<T | null>('window_init');
export const windowAtCursor = () => invoke<string | null>('window_at_cursor');
export const writeExport = (name: string, text: string) => invoke<string>('write_export', { name, text });
