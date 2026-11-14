import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AnimatePresence, motion } from 'motion/react';
import {
  AppWindow, Shapes, Wrench, SquareTerminal, Archive, ArrowDown, ArrowUp, ClipboardPaste, Copy, ExternalLink, FolderOpen, FolderOutput, FolderPlus, FolderSearch, Info, Link, Menu, Eye, Image as ImageIcon, Palette, PanelTop, Pencil, Pin, RotateCw, Scissors, Search, Tag as TagIcon, Trash2, Calculator, ChevronRight, ArchiveRestore, ChartPie, FolderInput, Hash,
} from 'lucide-react';
import {
  appsFor, baseName, chooseApp, createDir, deleteForever, displayName, linkTarget, fmtAgo, fmtDate, fmtSize, iconUrl, joinPath, kindOf, listDir, normPath, openPath, openWith, parentPath, properties, recycle, renamePath, restore, shellMenu, shellMenuInvoke, shellMenuItems, startJob, type NativeItem, VIEWABLE, type Entry, type ListOpts, type SortKey, isRemote, remoteOpen, ARCHIVE, archiveOpen, archivePath, parseArchive, startArchiveJob, startExtractJob,
} from './api';
import { calculateSize, cell, colsWidth, dirSizes, DetailsHeader, gridTemplate, HoverCard, isMedia, labelOf, mediaVer, sizeFolders, sizeOf, stopSizing, wantMedia } from './details';
import { buildLayout, dateBounds, headsIn, posOf, rangeOf, type GroupBy, type Group } from './layout';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { FileVisual, FolderIcon, toneFor } from './icons';
import { addRecent, bgEditor, FOLDER_COLORS, folderColors, movePathRefs, pushUndo, setSetting, settings, tagged, tags, tagsOf, toast, toggleTag, undoable, type Col, openTool } from './store';
import deltaIcon from './assets/icon-small.svg';
import { QuickLook, type PreviewTarget } from './Preview';
import { createDirs } from './api';
import { BatchRename } from './BatchRename';
import { pasteAsFile, PromptDialog } from './QuickDialogs';
import { folderLines, pendingReveal, recall, remember, wildcard } from './quick';
import { ClipboardType, Files, FolderTree, ListChecks, TextCursorInput } from 'lucide-react';
import { powerMenu } from './powerMenu';
import { GitBadge, gitOf, useGit } from './git';
import { is as isKey, keyLabel as kl, type ActionId } from './keymap';
import { failOrElevate } from './elevate';
import { activeList, copyAsPath, extrasMenu, shareItems, terminal, type ActiveList } from './shellExtras';
import { CommandBar } from './CommandBar';

const ROW = { comfortable: 30, compact: 25 };
/** Grid cell and icon size per Settings → Appearance → Icon size. */
const GRID = { small: [100, 112, 52], medium: [124, 140, 76], large: [156, 176, 108], huge: [200, 220, 150] } as const;
const PAGE = 200;
const ENTER_ROWS = 28; // rows that cascade in when a folder opens; the rest just appear
const GROUP_H = 30; // group header height
let mounts = 0;

export type View = 'list' | 'grid' | 'columns';
export interface ListActions {
  navigate: (path: string, newTab?: boolean) => void;
  /** Opens an image in the built-in Delta viewer, zooming from `from` (the thumbnail's rect). */
  view: (path: string, from?: DOMRect) => void;
  copy: (paths: string[], cut: boolean) => void;
  paste: (dest: string) => Promise<void>;
  canPaste: boolean;
  pin: (path: string) => void;
  error: (msg: unknown) => void;
  /** Hands a drag of these items (from folder `dir`) to the app-wide drag controller. */
  beginDrag: (paths: string[], dir: string, x: number, y: number) => void;
}

interface Props {
  id: string;
  path: string;
  home: string;
  view: View;
  sort: SortKey;
  desc: boolean;
  /** `add`: Shift+click, sort by this as well (second key). */
  onSort: (k: SortKey, add: boolean) => void;
  sortThen: { key: SortKey; desc: boolean } | null;
  groupBy: GroupBy;
  columns: Col[];
  setColumns: (c: Col[]) => void;
  filter: string;
  reloadKey: number;
  cutPaths: Set<string>;
  actions: ListActions;
  onInfo: (i: { total: number; selected: number; selectedSize: number; path: string; loaded: boolean }) => void;
  /** Focused and selected items, for the preview pane. */
  onPreview?: (t: PreviewTarget) => void;
  /** Came here with Back/Forward (or a tab switch): put scroll position and selection back as they were. */
  restore?: boolean;
}

/**
 * Virtualized folder view: Rust holds the whole (sorted, filtered) listing; we fetch pages as they scroll in.
 * Also shows search results and Tag/Recent lists ("virtual": dir === '', names are absolute paths).
 */
export function FileList({  id, path, home, view, sort, desc, onSort, sortThen, groupBy, columns, setColumns, filter, reloadKey, cutPaths, actions, onInfo, onPreview, restore: restoreView }: Props) {
  const st = settings.use();
  const allTags = tags.use();
  const allTagged = tagged.use();
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState<Map<number, Entry[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  // Opening a folder puts the keyboard in its list (Ctrl+A, Ctrl+C... work straight away), unless the user is
  // typing somewhere else or this isn't the active pane.
  useEffect(() => {
    if (!loaded) return;
    const a = document.activeElement;
    const typing = a instanceof HTMLElement && a !== box.current && a.matches('input, textarea, [contenteditable="true"]');
    if (!typing && box.current?.closest('.pane.is-active, .pane:only-child')) box.current.focus({ preventScroll: true });
  }, [loaded, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const [vp, setVp] = useState({ top: 0, height: 600, width: 800 });
  const [dir, setDir] = useState(path);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(-1);
  const [anchor, setAnchor] = useState(-1);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [entering, setEntering] = useState(true);
  const [gone, setGone] = useState<Set<string>>(new Set()); // being deleted: shown fading out
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; base: Set<string> } | null>(null);
  const [batch, setBatch] = useState<string[] | null>(null); // batch rename dialog for these paths
  const [prompt, setPrompt] = useState<'pattern' | 'folders' | null>(null);
  const inflight = useRef(new Set<number>());
  const box = useRef<HTMLDivElement>(null);
  const gen = useRef(0); // ignores responses from a previous path/sort/filter
  const virtual = loaded && dir === '';
  const rowH0 = ROW[st.density];
  const [CELL_W, CELL_H, GRID_ICON] = GRID[st.iconSize] ?? GRID.medium;
  const colors = folderColors.use();
  const showHidden = st.showHidden;
  const git = useGit(loaded ? dir : '');
  const [groups, setGroups] = useState<Group[]>([]);
  // Collapsed group keys belong to one grouping (FileList remounts per folder, so they reset per folder too).
  const [collapsedBy, setCollapsedBy] = useState<{ by: GroupBy; keys: string[] }>({ by: groupBy, keys: [] });
  const collapsed = collapsedBy.by === groupBy ? collapsedBy.keys : [];
  const viewOpts = useMemo<ListOpts>(() => ({
    then: sortThen?.key ?? null, thenDesc: sortThen?.desc ?? false, group: groupBy,
    bounds: groupBy === 'modified' ? dateBounds() : [0, 0, 0, 0, 0], collapsed,
  }), [sortThen?.key, sortThen?.desc, groupBy, collapsed.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps
  const optsKey = JSON.stringify(viewOpts);
  const [liveCols, setLiveCols] = useState<Col[] | null>(null);
  const cols0 = liveCols ?? columns;
  const headWrap = useRef<HTMLDivElement>(null);
  const sizes = dirSizes.use();
  mediaVer.use();
  const sizeKey = useRef(`${id}:${++mounts}`).current; // per mount: an unmounting list must not cancel its successor's walks
  useEffect(() => () => stopSizing(sizeKey), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const hoverT = useRef(0);
  const mouse = useRef({ x: 0, y: 0 });
  const unhover = () => { clearTimeout(hoverT.current); setHover(null); };
  const armHover = (i: number) => {
    unhover();
    if (st.hoverCards) hoverT.current = window.setTimeout(() => setHover({ i, ...mouse.current }), 600);
  };
  /** Browsing inside an archive: read-only, items extract instead of copy/rename/delete. */
  const inArchive = parseArchive(path);

  const load = useCallback((p: number, refresh = false) => {
    if (inflight.current.has(p)) return;
    inflight.current.add(p);
    const g = gen.current;
    listDir(path, p * PAGE, PAGE, { refresh, sort, desc, filter, showHidden, view: viewOpts })
      .then((r) => {
        if (g !== gen.current) return;
        setTotal(r.total);
        setGroups(r.groups);
        setDir(r.path);
        setLoaded(true);
        setPages((m) => new Map(m).set(p, r.entries));
        if (p === 0 && arrive.current) { arrive.current = false; onArrive(r.path, r.entries); }
      })
      .catch((e) => g === gen.current && (setError(String(e)), setTotal(0), setLoaded(true)))
      .finally(() => inflight.current.delete(p));
  }, [path, sort, desc, filter, showHidden, viewOpts]);

  // Back/Forward memory: what this view looked like when we left it; and "Open containing folder" picks.
  const arrive = useRef(true);
  const restoreRef = useRef(restoreView);
  const left = useRef({ top: 0, sel: new Set<string>(), focus: -1 });
  left.current = { top: vp.top, sel, focus };
  useEffect(() => () => remember(`${id}|${path}`, { top: left.current.top, sel: [...left.current.sel], focus: left.current.focus }), [id, path]);
  const onArrive = (shown: string, first: Entry[]) => {
    const pick = pendingReveal.get(normPath(shown));
    const m = restoreRef.current ? recall(`${id}|${path}`) : undefined;
    restoreRef.current = false;
    if (pick) {
      pendingReveal.delete(normPath(shown));
      setSel(new Set([pick]));
      const i = first.findIndex((e) => e.name === pick); // shortcut: only scrolls to it when it's in the first page
      if (i >= 0) { setFocus(i); setAnchor(i); requestAnimationFrame(() => scrollToRef.current(i)); }
    } else if (m) {
      setSel(new Set(m.sel)); setFocus(m.focus); setAnchor(m.focus);
      requestAnimationFrame(() => requestAnimationFrame(() => box.current?.scrollTo(0, m.top)));
    }
  };

  // New location: start fresh at the top, and let the first rows cascade in.
  useEffect(() => {
    arrive.current = true;
    setSel(new Set()); setFocus(-1); setAnchor(-1); setRenaming(null);
    box.current?.scrollTo(0, 0);
    setEntering(true);
    const t = setTimeout(() => setEntering(false), 700);
    return () => clearTimeout(t);
  }, [path]);

  // Any change of folder, order, filter or an explicit reload refetches; selection survives reloads.
  // Only a new folder or a reload re-reads the disk; order/grouping changes reuse Rust's cached listing.
  const lastRead = useRef('');
  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    setPages(new Map());
    setError(null);
    setLoaded(false);
    const k = `${path}|${reloadKey}|${showHidden}`;
    load(0, k !== lastRead.current);
    lastRead.current = k;
  }, [path, sort, desc, filter, showHidden, reloadKey, optsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Combined size of the selection (folders count once their size is known).
  const selSize = useMemo(() => {
    if (!sel.size) return 0;
    let n = 0;
    for (const es of pages.values()) for (const x of es) if (sel.has(x.name)) n += sizeOf(x, joinPath(dir, x.name), sizes);
    return n;
  }, [sel, pages, sizes, dir]);
  useEffect(() => { onInfo({ total, selected: sel.size, selectedSize: selSize, path: dir, loaded }); }, [total, sel.size, selSize, dir, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (onPreview) onPreview({ dir, focused: (focus >= 0 && entryAt(focus)) || null, selected: sel.size ? [...pages.values()].flat().filter((x) => sel.has(x.name)) : [] });
  }, [focus, sel, pages, dir, !!onPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track viewport size for virtualization.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp((v) => ({ ...v, height: el.clientHeight, width: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = view === 'grid' ? Math.max(1, Math.floor((vp.width - 16) / CELL_W)) : 1;
  const rowH = view === 'grid' ? CELL_H : rowH0;
  const pad = view === 'grid' ? 6 : 4; // space above the first row
  const L = useMemo(() => buildLayout(groups, total, cols, rowH, GROUP_H), [groups, total, cols, rowH]);
  const [first, last] = rangeOf(L, vp.top - pad, vp.top + vp.height + 3 * rowH);

  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(last - 1, 0) / PAGE); p++) if (!pages.has(p)) load(p);
  }, [first, last, pages, load]);

  const entryAt = (i: number) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  const pathOf = (e: Entry) => joinPath(dir, e.name);
  // Media columns and folder sizes: one batched request per settled viewport, never per row.
  const shownCols = cols0;
  const needMedia = view === 'list' && shownCols.some((c) => c.id === 'dims' || c.id === 'duration');
  const needSizes = view === 'list' && st.folderSizes && shownCols.some((c) => c.id === 'size');
  useEffect(() => {
    if (!needMedia && !needSizes) return;
    const t = setTimeout(() => {
      const vis: Entry[] = [];
      for (let i = first; i < last; i++) { const e = entryAt(i); if (e) vis.push(e); }
      if (needMedia) wantMedia(vis.filter((e) => !e.isDir && isMedia(e.name)).map((e) => ({ path: pathOf(e), mtime: e.modified })));
      if (needSizes) sizeFolders(sizeKey, vis.filter((e) => e.isDir).map(pathOf));
    }, 120);
    return () => clearTimeout(t);
  }, [first, last, pages, needMedia, needSizes]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = () => [...sel].map((n) => joinPath(dir, n));
  // Refresh in place (no flash of empty rows): page 0 with refresh rebuilds the listing in Rust,
  // then the other loaded pages are re-read from it and swapped in together.
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const reload = () => {
    const g = ++gen.current;
    inflight.current.clear();
    const had = [...pagesRef.current.keys()];
    listDir(path, 0, PAGE, { refresh: true, sort, desc, filter, showHidden, view: viewOpts }).then(async (r) => {
      if (g !== gen.current) return;
      const next = new Map([[0, r.entries]]);
      for (const p of had.filter((p) => p > 0 && p * PAGE < r.total)) {
        next.set(p, (await listDir(path, p * PAGE, PAGE, { sort, desc, filter, showHidden, view: viewOpts })).entries);
      }
      if (g !== gen.current) return;
      setTotal(r.total);
      setGroups(r.groups);
      setPages(next);
      setGone(new Set());
      const names = new Set([...next.values()].flat().map((e) => e.name));
      setSel((s) => new Set([...s].filter((n) => names.has(n)))); // drop selections of deleted items
      // A new or renamed item: scroll to where it landed in the sort order.
      if (reveal.current) {
        const want = reveal.current;
        reveal.current = null;
        for (const [p, es] of next) {
          const j = es.findIndex((e) => e.name === want);
          if (j >= 0) { const i = p * PAGE + j; setFocus(i); setAnchor(i); requestAnimationFrame(() => scrollToRef.current(i)); break; }
        }
      }
    }).catch((e) => { if (g === gen.current) { setPages(new Map()); setTotal(0); setError(String(e)); } }); // e.g. the open folder was deleted
  };
  const reveal = useRef<string | null>(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // Tag / Recent lists changed (they live in Rust as virtual listings): refetch.
  useEffect(() => {
    if (!path.startsWith('v:')) return;
    const f = () => reload();
    addEventListener('virtual-changed', f);
    return () => removeEventListener('virtual-changed', f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isRemote(path)) return;
    const f = () => reloadRef.current();
    addEventListener('remotes-changed', f);
    const un = listen<{ state: string }>('job', ({ payload }) => payload.state !== 'running' && f());
    return () => { removeEventListener('remotes-changed', f); un.then((g) => g()); };
  }, [path]);

  // Auto-refresh: the Rust watcher reports changed folders.
  useEffect(() => {
    const un = listen<string[]>('fs-changed', ({ payload }) => {
      if (dirRef.current && payload.includes(normPath(dirRef.current))) reloadRef.current();
    });
    return () => { un.then((f) => f()); };
  }, []);

  // Press on an item, move 5px with the button held: start a drag. Pressing an already-selected item
  // (no modifiers) keeps the multi-selection until mouse-up, so several items can be dragged together.
  const press = useRef<{ x: number; y: number; i: number; collapse: boolean } | null>(null);
  const onRowDown = (i: number, m: React.MouseEvent) => {
    if (m.button !== 0 || renaming) return;
    const en = entryAt(i);
    const keep = !!en && sel.has(en.name) && !m.ctrlKey && !m.shiftKey;
    press.current = { x: m.clientX, y: m.clientY, i, collapse: keep };
    if (!keep) select(i, m);
  };
  const onMove = (m: React.MouseEvent) => {
    mouse.current = { x: m.clientX, y: m.clientY };
    const p = press.current;
    if (!p || !(m.buttons & 1) || Math.hypot(m.clientX - p.x, m.clientY - p.y) < 5) return;
    press.current = null;
    const en = entryAt(p.i);
    const names = en && !sel.has(en.name) ? [en.name] : [...sel];
    if (names.length) actions.beginDrag(names.map((n) => joinPath(dir, n)), dir || parentPath(joinPath(dir, names[0])), m.clientX, m.clientY);
  };
  const onUp = () => {
    const p = press.current;
    press.current = null;
    if (p?.collapse) select(p.i, { ctrlKey: false, shiftKey: false });
  };

  const rowEl = (i: number) => document.getElementById(`${id}-r${i}`);

  // ---- selection box ----
  const startMarquee = (m: React.MouseEvent) => {
    if (m.button !== 0 || m.target !== m.currentTarget) return;
    const el = box.current!;
    const r = el.getBoundingClientRect();
    const at = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop });
    const p0 = at(m);
    const base = m.ctrlKey ? new Set(sel) : new Set<string>();
    if (!m.ctrlKey) setSel(new Set());
    el.focus();
    let moved = false;
    const move = (e: MouseEvent) => {
      // Auto-scroll when dragging past the top or bottom edge.
      if (e.clientY > r.bottom - 16) el.scrollTop += Math.min(40, e.clientY - r.bottom + 16);
      else if (e.clientY < r.top + 16) el.scrollTop -= Math.min(40, r.top + 16 - e.clientY);
      const p1 = at(e);
      if (!moved && Math.hypot(p1.x - p0.x, p1.y - p0.y) < 4) return;
      moved = true;
      setMarquee({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, base });
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); setMarquee(null); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
  // Items the box touches (from geometry, so it also works for rows that are scrolled out of view).
  useEffect(() => {
    if (!marquee) return;
    const [x0, x1] = [Math.min(marquee.x0, marquee.x1), Math.max(marquee.x0, marquee.x1)];
    const [y0, y1] = [Math.min(marquee.y0, marquee.y1), Math.max(marquee.y0, marquee.y1)];
    const s = new Set(marquee.base);
    const [a, b] = rangeOf(L, y0 - pad, y1 - pad);
    for (let i = a; i < b; i++) {
      const e = entryAt(i);
      if (!e) continue;
      if (view === 'grid') {
        const p = posOf(L, i), cx = p.col * CELL_W + 8, cy = p.y + 6;
        if (!(cx < x1 && cx + CELL_W - 8 > x0 && cy < y1 && cy + CELL_H - 8 > y0)) continue;
      }
      s.add(e.name);
    }
    setSel(s);
  }, [marquee]); // eslint-disable-line react-hooks/exhaustive-deps
  // Folders navigate; photos open in Delta Viewer (if enabled); everything else in its default app.
  const open = (e: Entry, newTab = false, i?: number) => {
    const p = pathOf(e);
    if (e.isDir) return actions.navigate(p, newTab);
    if (isRemote(p)) return void remoteOpen(p).catch(actions.error);
    if (inArchive) { archiveOpen(p).catch(actions.error); return; } // unpacked to temp, then its own app
    if (ARCHIVE.test(e.name)) return actions.navigate(archivePath(p), newTab); // archives open as folders, inside Delta
    addRecent(p);
    if (st.photosInViewer && VIEWABLE.test(e.name)) return actions.view(p, i === undefined ? undefined : rowEl(i)?.querySelector('.ficon, .thumb')?.getBoundingClientRect());
    // A shortcut to a folder opens here, not in File Explorer.
    if (/\.lnk$/i.test(e.name)) {
      linkTarget(p).then((t) => (t?.isDir ? actions.navigate(t.path, newTab) : openPath(p)), () => openPath(p)).catch(actions.error);
      return;
    }
    openPath(p).catch(actions.error);
  };

  const openWithMenu = async (e: Entry): Promise<MenuItem[]> => {
    const p = pathOf(e);
    const apps = await appsFor(p).catch((err) => { actions.error(err); return []; });
    return [
      ...(VIEWABLE.test(e.name) ? [{ label: 'Delta Viewer', icon: <img src={deltaIcon} alt="" width={16} height={16} />, run: () => { addRecent(p); actions.view(p); } }, 'sep' as const] : []),
      ...apps.map((a) => ({ label: a.name, icon: <AppIcon file={a.icon} />, run: () => { addRecent(p); openWith(p, a.id).catch(actions.error); } })),
      'sep' as const,
      { label: 'Choose another app…', icon: <Search size={15} />, run: () => chooseApp(p).catch(actions.error) },
    ];
  };

  const isDirPath = (p: string) => [...pages.values()].flat().some((x) => x.isDir && pathOf(x) === p);
  const colorMenu = (paths: string[]): MenuItem[] => [
    ...FOLDER_COLORS.map((c) => ({
      label: c.name,
      icon: <span className="color-dot" style={{ background: c.c }} />,
      checked: paths.every((p) => colors[p.toLowerCase()] === c.c),
      run: () => folderColors.set((m) => { const n = { ...m }; for (const p of paths) n[p.toLowerCase()] = c.c; return n; }),
    })),
    'sep' as const,
    { label: 'Default', icon: <FolderIcon size={15} />, run: () => folderColors.set((m) => { const n = { ...m }; for (const p of paths) delete n[p.toLowerCase()]; return n; }) },
  ];
  const tagMenu = (paths: string[]): MenuItem[] =>
    allTags.map((t) => ({
      label: t.name,
      icon: <span className="tag-dot big" style={{ background: t.color }} />,
      checked: paths.every((p) => tagsOf(tagged.get(), p).includes(t.id)),
      run: () => paths.forEach((p) => toggleTag(p, t.id)),
    }));

  const scrollTo = (i: number) => {
    const el = box.current;
    if (!el) return;
    const top = posOf(L, i).y;
    if (top - L.headH < el.scrollTop) el.scrollTop = top - L.headH; // clear of a sticky group header
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  };
  const scrollToRef = useRef(scrollTo);
  scrollToRef.current = scrollTo;

  // ---- Quick Look (Space): shows the item at `quick`; arrows move the selection with it ----
  const [quick, setQuick] = useState<number | null>(null);
  const indexOf = (e: Entry) => { for (const [p, es] of pages) { const j = es.indexOf(e); if (j >= 0) return p * PAGE + j; } return -1; };
  const stepQuick = (d: number) => {
    if (quick === null || !total) return;
    const i = Math.max(0, Math.min(total - 1, quick + d));
    select(i, { ctrlKey: false, shiftKey: false }); scrollTo(i); setQuick(i);
  };

  const select = (i: number, e: { ctrlKey: boolean; shiftKey: boolean }) => {
    const en = entryAt(i);
    if (!en) return;
    if (e.shiftKey && anchor >= 0) {
      const s = new Set(e.ctrlKey ? sel : []);
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) { const x = entryAt(k); if (x) s.add(x.name); }
      setSel(s);
    } else if (e.ctrlKey) {
      const s = new Set(sel);
      s.has(en.name) ? s.delete(en.name) : s.add(en.name);
      setSel(s);
      setAnchor(i);
    } else {
      setSel(new Set([en.name]));
      setAnchor(i);
    }
    setFocus(i);
  };

  // ---- operations (each one records how to undo it) ----
  const del = () => {
    const p = selected();
    if (!p.length) return;
    if (isRemote(dir)) return setConfirmForever(p);
    setGone(new Set(sel));
    setSel(new Set());
    recycle(p).then(() => {
      reload();
      const what = p.length > 1 ? `${p.length} items` : `“${baseName(p[0])}”`;
      undoable({ label: `Delete ${what}`, run: () => restore(p) }, `Moved ${what} to the Recycle Bin`);
    }, (e) => { setGone(new Set()); failOrElevate(e, { op: 'recycle', items: p }, `Moved ${p.length > 1 ? `${p.length} items` : `“${baseName(p[0])}”`} to the Recycle Bin`, reload); });
  };
  // Ctrl+A: every item, including pages not scrolled into view yet (so Delete/Copy act on all of them).
  const allNames = async () => {
    const g = gen.current;
    const all = new Map(pages);
    try {
      for (let p = 0; p * PAGE < total; p++) {
        if (!all.has(p)) all.set(p, (await listDir(path, p * PAGE, PAGE, { sort, desc, filter, showHidden, view: viewOpts })).entries);
      }
    } catch (e) { actions.error(e); return null; }
    if (g !== gen.current) return null;
    setPages(all);
    return [...all.values()].flat().map((x) => x.name);
  };
  const selectAll = async () => { const n = await allNames(); if (n) setSel(new Set(n)); };
  // Ctrl+I: everything that isn't selected, and nothing that is.
  const invert = async () => { const n = await allNames(); if (n) setSel((s) => new Set(n.filter((x) => !s.has(x)))); };
  const selectPattern = async (pattern: string) => {
    const re = wildcard(pattern);
    const n = re && (await allNames());
    if (!re || !n) return;
    const hit = n.filter((x) => re.test(baseName(x)));
    setSel(new Set(hit));
    toast(hit.length ? `Selected ${hit.length} item${hit.length > 1 ? 's' : ''}` : `Nothing here matches “${pattern.trim()}”`);
  };
  /** F2 with several selected (or the menu / palette): the batch rename dialog. */
  const batchRename = () => { if (sel.size) setBatch(selected()); };
  const makeFolders = (text: string) => {
    if (!dir) return;
    createDirs(dir, folderLines(text)).then((made) => {
      reload();
      if (!made.length) return toast('Those folders already exist');
      setSel(new Set(made.map(baseName)));
      undoable({ label: `Create ${made.length} folder${made.length > 1 ? 's' : ''}`, run: () => recycle(made) }, `Created ${made.length} folder${made.length > 1 ? 's' : ''}`);
    }, actions.error);
  };
  const pasteFile = () => dir && pasteAsFile(dir).then((made) => { if (made) { reveal.current = baseName(made); setSel(new Set([baseName(made)])); reload(); } }, actions.error);
  const copyNames = (paths: string[]) => copyText(paths.map(baseName).join('\n'));
  const copyParents = (paths: string[]) => copyText([...new Set(paths.map(parentPath))].join('\n'));
  /** Search results: go to the item's folder with it selected. */
  const openContaining = (p: string) => { pendingReveal.set(normPath(parentPath(p)), baseName(p)); actions.navigate(parentPath(p)); };
  // Type a name's first letters to jump to it (like File Explorer). Repeating one letter cycles through matches.
  const typed = useRef({ text: '', at: 0 });
  const typeAhead = (ch: string) => {
    const t = typed.current;
    const now = Date.now();
    t.text = now - t.at > 900 ? ch.toLowerCase() : t.text + ch.toLowerCase();
    t.at = now;
    const cycling = t.text.length > 1 && [...t.text].every((c) => c === t.text[0]);
    const want = cycling ? t.text[0] : t.text;
    const start = cycling || t.text.length === 1 ? focus + 1 : Math.max(focus, 0);
    for (let k = 0; k < total; k++) {
      const i = (start + k) % total;
      const e = entryAt(i);
      if (e && displayName(baseName(e.name), e.isDir, st.showExtensions).toLowerCase().startsWith(want)) {
        select(i, { ctrlKey: false, shiftKey: false });
        scrollTo(i);
        return;
      }
    }
  };
  // Shift+Delete: skips the Recycle Bin, so it always asks first.
  const [confirmForever, setConfirmForever] = useState<string[] | null>(null);
  const deleteNow = (p: string[]) => {
    setConfirmForever(null);
    setGone(new Set(p.map((x) => (dir ? baseName(x) : x))));
    setSel(new Set());
    deleteForever(p).then(() => { reload(); toast(`Deleted ${p.length > 1 ? `${p.length} items` : `“${baseName(p[0])}”`} permanently`); }, (e) => { setGone(new Set()); reload(); failOrElevate(e, { op: 'delete', items: p }, 'Deleted permanently', reload); });
  };
  const paste = () => dir && actions.paste(dir).catch(actions.error);
  const newFolder = () =>
    dir && createDir(dir, 'New folder').then((name) => {
      setSel(new Set([name])); setRenaming(name); reveal.current = name; reload();
      const made = joinPath(dir, name);
      if (!isRemote(made)) pushUndo({ label: 'New folder', run: () => recycle([made]) });
    }, (e) => failOrElevate(e, { op: 'mkdir', items: [dir], name: 'New folder' }, 'Created a new folder', reload));
  const commitRename = (from: string, to: string) => {
    setRenaming(null);
    const name = to.trim();
    if (!name || name === baseName(from)) return;
    const full = joinPath(dir, from);
    renamePath(full, name).then((used) => {
      const now = joinPath(parentPath(full), used);
      if (used !== name) toast(`“${name}” is taken, so it's now “${used}”`);
      setSel(new Set([dir ? used : now])); reveal.current = dir ? used : now; reload();
      movePathRefs(full, now); // tags, pins and recents follow the new name
      pushUndo({ label: `Rename to “${used}”`, run: () => renamePath(now, baseName(full)).then(() => movePathRefs(now, full)) });
    }, (e) => failOrElevate(e, { op: 'rename', items: [full], name }, `Renamed to “${name}”`, () => { movePathRefs(full, joinPath(parentPath(full), name)); reload(); }));
  };
  /** Folder for "terminal here": one selected folder, else this one. */
  const here = () => { const s = [...pages.values()].flat().filter((x) => sel.has(x.name)); return s.length === 1 && s[0].isDir ? pathOf(s[0]) : dir; };
  // The palette's Share / Copy as path / Terminal act on the list used last.
  const mine = useRef<ActiveList | null>(null);
  mine.current = { dir, selected, here, reload };
  const claim = () => { activeList.current = { get dir() { return mine.current!.dir; }, selected: () => mine.current!.selected(), here: () => mine.current!.here(), reload: () => mine.current!.reload() }; };
  useEffect(() => { if (sel.size) claim(); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyText = (t: string) => navigator.clipboard.writeText(t).catch(actions.error);
  const native = (x: number, y: number, items: string[], extended = false) => {
    const folder = items.length ? parentPath(items[0]) : dir;
    if (items.some((p) => normPath(parentPath(p)) !== normPath(folder))) return actions.error('Windows menu works on items from one folder');
    shellMenu(folder, items, x, y, extended).then(reload, actions.error);
  };

  /** The three ways to extract archives (or, inside a browsed archive, the selected items). */
  const extractMenu = (arcs: string[]): MenuItem[] => inArchive ? [
    { label: `Extract next to “${baseName(inArchive.file)}”`, icon: <FolderOutput size={15} />, run: () => startExtractJob(arcs, 'folder').catch(actions.error) },
    { label: 'Extract to folder…', icon: <FolderSearch size={15} />, run: () => openTool('extractTo', arcs) },
  ] : [
    { label: 'Extract here', icon: <FolderOutput size={15} />, run: () => startExtractJob(arcs, 'here').catch(actions.error) },
    { label: arcs.length > 1 ? 'Extract each to its own folder' : `Extract to “${archiveStem(arcs[0])}\\”`, icon: <FolderInput size={15} />, run: () => startExtractJob(arcs, 'folder').catch(actions.error) },
    { label: 'Extract to folder…', icon: <FolderSearch size={15} />, run: () => openTool('extractTo', arcs) },
  ];
  const selArchives = inArchive ? selected() : selected().filter((p) => ARCHIVE.test(p));
  const extractButton = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items: extractMenu(selArchives) });
  };

  // On a server only these make sense (no shell menu, zip, tags, properties, Recycle Bin).
  const REMOTE_OK = /^(Open( “.*”| in new tab)?|Cut|Copy|Paste( into folder)?|Rename|Delete permanently…|Copy (folder )?path|Pin to sidebar|New folder|Refresh)$/;
  const remoteOnly = (items: MenuItem[]) => (!isRemote(dir) ? items : items.filter((m) => m !== 'sep' && REMOTE_OK.test(m.label)));
  // First right-click: the everyday items. "Show more options" opens Delta's second menu: everything else plus Windows' own entries.
  const FIRST = /^(Open( “.*”| in new tab| with)?|Quick look|Cut|Copy|Paste( into folder)?|Rename( \d+ items…)?|Delete( \d+ items)?|Compress to ZIP|Extract here|Extract all|New folder|Refresh|Pin to sidebar|Copy (folder )?path|Properties)$/;
  const DUP_NATIVE = /^(open|cut|copy|paste|delete|rename|properties|create shortcut|copy as path|share|send to|open in terminal|open with|refresh|new)$/i;
  const toMenu = (n: NativeItem[], x: number, y: number): MenuItem[] => n.map((i) => (i.id === 0 ? 'sep' as const
    : { label: i.label, disabled: i.disabled, ...(i.sub.length ? { sub: () => toMenu(i.sub, x, y) } : { run: () => void shellMenuInvoke(i.id, x, y).then(reload, actions.error) }) }));
  const moreMenu = async (x: number, y: number, rest: MenuItem[], items: string[]) => {
    const folder = items.length ? parentPath(items[0]) : dir;
    const win = isRemote(dir) || inArchive || items.some((p) => normPath(parentPath(p)) !== normPath(folder)) ? []
      : await shellMenuItems(folder, items).catch(() => [] as NativeItem[]);
    const natives = toMenu(win.filter((i) => !DUP_NATIVE.test(i.label)), x, y);
    // Grouped so the second menu fits on screen: related actions share a submenu; one-of-a-kind ones stay top level.
    const GROUPS: [string, ReactNode, RegExp][] = [
      ['Organise', <Shapes size={15} />, /^(Batch rename…|Tags|Folder colour|Add to shelf|Add to collection|Remove from collection|New collection|Unpin.*)$/],
      ['Tools', <Wrench size={15} />, /^(Compress…|Browse archive|Extract.*|Find duplicates.*|Analyse storage…|Calculate size|Checksums…|Compare (files|folders)|Metadata…|Use as Delta background)$/],
      ['Copy', <Copy size={15} />, /^(Copy (as path|names?|parent folder path))$/],
      ['Open in', <SquareTerminal size={15} />, /^(Open in Terminal|Open PowerShell here|Open Command Prompt here|Open in default app|Open containing folder|Open in new tab)$/],
    ];
    const top: MenuItem[] = [];
    const buckets = GROUPS.map(() => [] as MenuItem[]);
    const danger: MenuItem[] = [];
    for (const m of rest) {
      if (m === 'sep') continue;
      if (m.label.startsWith('Delete permanently')) { danger.push(m); continue; } // never the first, pre-highlighted item
      const g = GROUPS.findIndex(([, , re]) => re.test(m.label));
      (g < 0 ? top : buckets[g]).push(m);
    }
    const grouped: MenuItem[] = GROUPS.flatMap(([label, icon], i) =>
      buckets[i].length > 1 ? [{ label, icon, sub: () => buckets[i] }] : buckets[i]);
    setMenu({ x, y, items: [...top, ...(top.length && grouped.length ? ['sep' as const] : []), ...grouped,
      ...(natives.length ? ['sep' as const, { label: 'Windows & apps', icon: <AppWindow size={15} />, sub: () => natives }] : []),
      ...(danger.length ? ['sep' as const, ...danger] : [])] });
  };
  const split = (all: MenuItem[], x: number, y: number, items: string[]): MenuItem[] => {
    const full = all.filter((m) => m === 'sep' || m.label !== 'Show more options');
    const first = full.filter((m) => m === 'sep' || FIRST.test(m.label));
    const rest = full.filter((m) => m === 'sep' || !FIRST.test(m.label));
    const tidy = (l: MenuItem[]) => l.filter((m, i) => m !== 'sep' || (i > 0 && l[i - 1] !== 'sep' && i < l.length - 1));
    return [...tidy(first), 'sep', { label: 'Show more options', icon: <Menu size={15} />, shortcut: kl('nativeMenu'), run: () => void moreMenu(x, y, tidy(rest), items) }];
  };
  const itemMenu = (e: Entry, x: number, y: number): MenuItem[] =>
    isRemote(dir) || inArchive ? remoteOnly(itemMenuAll(e, x, y)) : split(itemMenuAll(e, x, y), x, y, sel.has(e.name) ? selected() : [pathOf(e)]);
  const itemMenuAll = (e: Entry, x: number, y: number): MenuItem[] => {
    const many = sel.size > 1;
    const paths = sel.has(e.name) ? selected() : [pathOf(e)];
    const zips = paths.filter((p) => ARCHIVE.test(p));
    if (inArchive) return [
      { label: e.isDir ? `Open “${baseName(e.name)}”` : 'Open', icon: <FolderOpen size={15} />, shortcut: 'Enter', run: () => open(e) },
      'sep',
      ...extractMenu(paths),
      { label: 'Copy path', icon: <Link size={15} />, run: () => copyText(paths.join('\n')) },
    ];
    // Compressing only makes sense for folders (not single files, shortcuts or mixed selections).
    const allFolders = paths.every((p) => isDirPath(p));
    return [
      { label: e.isDir ? `Open “${baseName(e.name)}”` : 'Open', icon: <FolderOpen size={15} />, shortcut: kl('open'), run: () => open(e) },
      ...(!e.isDir && !many ? [{ label: 'Open with', icon: <AppWindow size={15} />, sub: () => openWithMenu(e) }] : []),
      ...(!e.isDir && VIEWABLE.test(e.name) && st.photosInViewer ? [{ label: 'Open in default app', icon: <ExternalLink size={15} />, run: () => openPath(pathOf(e)).catch(actions.error) }] : []),
      ...(e.isDir ? [{ label: 'Open in new tab', icon: <PanelTop size={15} />, shortcut: 'Ctrl+Click', run: () => open(e, true) }] : []),
      ...(virtual ? [{ label: 'Open containing folder', icon: <FolderSearch size={15} />, run: () => openContaining(pathOf(e)) }] : []),
      'sep',
      ...(!many ? [{ label: 'Quick look', icon: <Eye size={15} />, shortcut: kl('quickLook'), run: () => setQuick(indexOf(e)) }] : []),
      { label: 'Cut', icon: <Scissors size={15} />, shortcut: kl('cut'), run: () => actions.copy(paths, true) },
      { label: 'Copy', icon: <Copy size={15} />, shortcut: kl('copy'), run: () => actions.copy(paths, false) },
      ...(e.isDir ? [{ label: 'Paste into folder', icon: <ClipboardPaste size={15} />, disabled: !actions.canPaste, run: () => actions.paste(pathOf(e)).catch(actions.error) }] : []),
      many
        ? { label: `Rename ${sel.size} items…`, icon: <Pencil size={15} />, shortcut: kl('rename'), run: batchRename }
        : { label: 'Rename', icon: <Pencil size={15} />, shortcut: kl('rename'), run: () => setRenaming(e.name) },
      ...(!many ? [{ label: 'Batch rename…', icon: <TextCursorInput size={15} />, run: () => setBatch(paths) }] : []),
      { label: many ? `Delete ${sel.size} items` : 'Delete', icon: <Trash2 size={15} />, shortcut: kl('delete'), danger: true, run: del },
      { label: 'Delete permanently…', icon: <Trash2 size={15} />, shortcut: kl('deleteForever'), danger: true, run: () => setConfirmForever(paths) },
      'sep',
      ...(allFolders ? [
        { label: 'Compress to ZIP', icon: <Archive size={15} />, run: () => startArchiveJob(paths, 'zip', LEVELS[st.compression]).catch(actions.error) },
        { label: 'Compress…', icon: <Archive size={15} />, run: () => openTool('compress', paths) },
      ] : []),
      ...(zips.length === 1 && !many ? [{ label: 'Browse archive', icon: <FolderOpen size={15} />, run: () => actions.navigate(archivePath(zips[0])) }] : []),
      ...(zips.length ? extractMenu(zips) : []),
      ...(!e.isDir && !many ? [{ label: 'Checksums…', icon: <Hash size={15} />, run: () => openTool('checksums', [pathOf(e)]) }] : []),
      ...(e.isDir && !many ? [
        { label: 'Find duplicates…', icon: <Files size={15} />, run: () => openTool('dupes', [pathOf(e)]) },
        { label: 'Analyse storage…', icon: <ChartPie size={15} />, run: () => openTool('storage', [pathOf(e)]) },
      ] : []),
      { label: 'Tags', icon: <TagIcon size={15} />, sub: () => tagMenu(paths) },
      ...(e.isDir ? [{ label: 'Pin to sidebar', icon: <Pin size={15} />, run: () => actions.pin(pathOf(e)) }] : []),
      ...(e.isDir ? [{ label: 'Calculate size', icon: <Calculator size={15} />, run: () => calculateSize(paths.filter(isDirPath)) }] : []),
      ...(paths.length && !paths.some((p) => !isDirPath(p)) ? [{ label: 'Folder colour', icon: <Palette size={15} />, sub: () => colorMenu(paths) }] : []),
      ...(!e.isDir && !many && VIEWABLE.test(e.name) ? [{ label: 'Use as Delta background', icon: <ImageIcon size={15} />, run: () => bgEditor.set(pathOf(e)) }] : []),
      ...powerMenu(paths, isDirPath, path),
      { label: 'Copy path', icon: <Link size={15} />, shortcut: kl('copyPath'), run: () => copyText(paths.join('\n')) },
      ...extrasMenu(paths, e.isDir && !many ? pathOf(e) : '', reload),
      { label: many ? 'Copy names' : 'Copy name', icon: <Copy size={15} />, run: () => copyNames(paths) },
      { label: 'Copy parent folder path', icon: <Link size={15} />, run: () => copyParents(paths) },
      { label: 'Properties', icon: <Info size={15} />, shortcut: kl('properties'), disabled: many, run: () => properties(pathOf(e)).catch(actions.error) },
      'sep',
      { label: 'Show more options', icon: <Menu size={15} />, shortcut: kl('nativeMenu'), run: () => native(x, y, paths) },
    ];
  };
  const bgMenu = (x: number, y: number): MenuItem[] => (isRemote(dir) || inArchive || virtual ? remoteOnly(bgMenuAll(x, y)) : split(bgMenuAll(x, y), x, y, []));
  const bgMenuAll = (x: number, y: number): MenuItem[] =>
    inArchive
      ? [
          { label: 'Extract all', icon: <ArchiveRestore size={15} />, run: () => startExtractJob([inArchive.file], 'folder').catch(actions.error) },
          { label: 'Extract all to folder…', icon: <FolderSearch size={15} />, run: () => openTool('extractTo', [inArchive.file]) },
          { label: 'Refresh', icon: <RotateCw size={15} />, shortcut: kl('refresh'), run: reload },
        ]
      : virtual
      ? [
          { label: 'Refresh', icon: <RotateCw size={15} />, shortcut: kl('refresh'), run: reload },
          { label: 'Select by pattern…', icon: <ListChecks size={15} />, run: () => setPrompt('pattern') },
          { label: 'Invert selection', icon: <Files size={15} />, shortcut: 'Ctrl+I', run: invert },
        ]
      : [
          { label: 'New folder', icon: <FolderPlus size={15} />, shortcut: kl('newFolder'), run: newFolder },
          { label: 'Create several folders…', icon: <FolderTree size={15} />, run: () => setPrompt('folders') },
          { label: 'Paste', icon: <ClipboardPaste size={15} />, shortcut: kl('paste'), disabled: !actions.canPaste, run: paste },
          { label: 'Paste text or picture as a file', icon: <ClipboardType size={15} />, run: pasteFile },
          { label: 'Refresh', icon: <RotateCw size={15} />, shortcut: kl('refresh'), run: reload },
          'sep',
          { label: 'Select by pattern…', icon: <ListChecks size={15} />, run: () => setPrompt('pattern') },
          { label: 'Invert selection', icon: <Files size={15} />, shortcut: 'Ctrl+I', run: invert },
          'sep',
          { label: 'Copy folder path', icon: <Link size={15} />, run: () => copyText(dir) },
          { label: 'Pin to sidebar', icon: <Pin size={15} />, run: () => actions.pin(dir) },
          { label: 'Find duplicates here…', icon: <Files size={15} />, run: () => openTool('dupes', [dir]) },
          { label: 'Analyse storage…', icon: <ChartPie size={15} />, run: () => openTool('storage', [dir]) },
          { label: 'Properties', icon: <Info size={15} />, run: () => properties(dir).catch(actions.error) },
          'sep',
          ...extrasMenu([], dir),
          'sep',
          { label: 'Show more options', icon: <Menu size={15} />, run: () => native(x, y, []) },
        ];

  const menuAtFocus = (nativeMenu: boolean) => {
    const i = focus >= 0 ? focus : -1;
    const r = (i >= 0 ? rowEl(i) : box.current)?.getBoundingClientRect();
    if (!r) return;
    const x = r.left + 40, y = r.top + Math.min(r.height, 24);
    const e = i >= 0 ? entryAt(i) : undefined;
    if (nativeMenu) native(x, y, e ? (sel.has(e.name) ? selected() : [pathOf(e)]) : []);
    else setMenu({ x, y, items: e ? itemMenu(e, x, y) : bgMenu(x, y) });
  };

  const onKey = (k: React.KeyboardEvent) => {
    if (renaming || menu) return;
    const ctrl = k.ctrlKey || k.metaKey;
    const step = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: view === 'grid' ? 1 : 0, ArrowLeft: view === 'grid' ? -1 : 0, PageDown: 20 * cols, PageUp: -20 * cols, Home: -Infinity, End: Infinity }[k.key];
    if (step !== undefined && step !== 0 && total) {
      k.preventDefault();
      const i = Math.max(0, Math.min(total - 1, (focus < 0 ? -1 : focus) + (Number.isFinite(step) ? step : step > 0 ? total : -total)));
      select(i, { ctrlKey: false, shiftKey: k.shiftKey });
      scrollTo(i);
      return;
    }
    const fe = focus >= 0 ? entryAt(focus) : undefined;
    const is = (id: ActionId) => isKey(k.nativeEvent, id);
    // Inside an archive nothing can be deleted, renamed, cut, copied as files or pasted.
    if (inArchive && (is('delete') || is('deleteForever') || is('rename') || is('cut') || is('paste') || is('newFolder'))) { k.preventDefault(); return; }
    if (is('deleteForever')) { if (sel.size) setConfirmForever(selected()); }
    else if (is('properties') && fe) properties(pathOf(fe)).catch(actions.error);
    else if (is('openNewTab') && fe) open(fe, true, focus);
    else if (is('open') && fe) open(fe, false, focus);
    else if (is('rename') && sel.size > 1) batchRename();
    else if (is('rename') && fe) setRenaming(fe.name);
    else if (ctrl && !k.shiftKey && k.key.toLowerCase() === 'i') { k.preventDefault(); invert(); }
    else if (is('delete')) del();
    else if (is('refresh')) { k.preventDefault(); reload(); }
    else if (is('nativeMenu')) { k.preventDefault(); menuAtFocus(true); }
    else if (is('menu')) { k.preventDefault(); menuAtFocus(false); }
    else if (is('newFolder')) { k.preventDefault(); newFolder(); }
    else if (is('copyPath')) copyText(selected().join('\n'));
    else if (is('copyAsPath') && sel.size) copyAsPath(selected());
    else if (is('share') && sel.size) shareItems(selected());
    else if (is('terminal') && dir) terminal(here());
    else if (is('selectAll')) { k.preventDefault(); selectAll(); }
    else if (is('copy') && sel.size) actions.copy(selected(), false);
    else if (is('cut') && sel.size) actions.copy(selected(), true);
    else if (is('paste')) paste();
    else if (is('clearSelection')) setSel(new Set());
    else if (is('quickLook') && fe) { k.preventDefault(); setQuick(focus); }
    else if (k.key.length === 1 && !ctrl && !k.altKey && k.key !== ' ') typeAhead(k.key);
    else return;
    k.stopPropagation();
  };

  // Command palette file actions (App dispatches "delta-cmd"); only the active pane's list reacts.
  const cmdRef = useRef<(c: string) => void>(() => {});
  cmdRef.current = (c) => {
    const paths = selected();
    const need = () => { if (!paths.length) toast('Select something first'); return paths.length > 0; };
    if (c === 'batchRename') { if (need()) batchRename(); }
    else if (c === 'invert') invert();
    else if (c === 'pattern') setPrompt('pattern');
    else if (c === 'folders') { if (dir) setPrompt('folders'); else toast('Open a folder first'); }
    else if (c === 'pasteFile') { if (dir) pasteFile(); else toast('Open a folder first'); }
    else if (c === 'copyName') { if (need()) copyNames(paths); }
    else if (c === 'copyParent') { if (need()) copyParents(paths); }
  };
  useEffect(() => {
    const f = (e: Event) => { if (box.current?.closest('.pane.is-active')) cmdRef.current((e as CustomEvent<string>).detail); };
    addEventListener('delta-cmd', f);
    return () => removeEventListener('delta-cmd', f);
  }, []);

  const grid = view === 'grid';
  const items = [];
  for (let i = first; i < last; i++) {
    const e = entryAt(i);
    const isSel = !!e && sel.has(e.name);
    const at = posOf(L, i);
    const style: React.CSSProperties & Record<string, string | number> = grid
      ? { transform: `translate(${at.col * CELL_W + 8}px, ${at.y + 6}px)` }
      : { transform: `translateY(${at.y + 4}px)`, height: rowH0 };
    if (entering && i < ENTER_ROWS) style['--i'] = i;
    const real = e ? baseName(e.name) : '';
    const label = e ? displayName(real, e.isDir, st.showExtensions) : '';
    const icon = e && (e.isDir
      ? <FolderIcon tone={toneFor(real, pathOf(e), home)} color={colors[pathOf(e).toLowerCase()]} size={grid ? GRID_ICON : 18} />
      : <FileVisual name={real} path={pathOf(e)} mtime={e.modified} size={grid ? GRID_ICON : 18} grid={grid} />);
    const itemTags = e ? tagsOf(allTagged, pathOf(e)) : [];
    const gs = e && !virtual ? gitOf(git, e.name) : null;
    const dots = itemTags.length > 0 && (
      <span className="tag-dots" aria-label={`Tags: ${itemTags.map((t) => allTags.find((x) => x.id === t)?.name).join(', ')}`}>
        {itemTags.map((t) => <span key={t} className="tag-dot" style={{ background: allTags.find((x) => x.id === t)?.color }} />)}
      </span>
    );
    const name = e && (renaming === e.name ? (
      <input
        className="rename"
        autoFocus
        defaultValue={real}
        aria-label="New name"
        onFocus={(f) => { const dot = e.isDir ? -1 : real.lastIndexOf('.'); f.currentTarget.setSelectionRange(0, dot > 0 ? dot : real.length); }}
        onBlur={(b) => commitRename(e.name, b.currentTarget.value)}
        onKeyDown={(k) => { k.stopPropagation(); if (k.key === 'Enter') k.currentTarget.blur(); if (k.key === 'Escape') setRenaming(null); }}
        onClick={(c) => c.stopPropagation()}
      />
    ) : <span className="label">{label}</span>);
    const badge = <GitBadge s={gs} />;
    items.push(
      <div
        key={i}
        id={`${id}-r${i}`}
        className={`${grid ? 'cell' : 'row dcols'}${isSel ? ' sel' : ''}${focus === i ? ' focus' : ''}${e && (cutPaths.has(pathOf(e)) || e.hidden || gs === 'ignored') ? ' dim' : ''}${entering && i < ENTER_ROWS ? ' enter' : ''}${e && gone.has(e.name) ? ' gone' : ''}`}
        role="row"
        aria-rowindex={i + 1}
        aria-selected={isSel}
        style={style}
        onMouseDown={(m) => { unhover(); onRowDown(i, m); }}
        onMouseEnter={(m) => { mouse.current = { x: m.clientX, y: m.clientY }; armHover(i); }}
        onMouseMove={(m) => { mouse.current = { x: m.clientX, y: m.clientY }; }}
        onMouseLeave={unhover}
        data-drop={e?.isDir ? pathOf(e) : undefined}
        onDoubleClick={() => e && open(e, false, i)}
        onAuxClick={(m) => m.button === 1 && e?.isDir && open(e, true)}
        onContextMenu={(m) => {
          m.preventDefault(); m.stopPropagation();
          if (!e) return;
          if (!sel.has(e.name)) { setSel(new Set([e.name])); setAnchor(i); setFocus(i); }
          if (m.shiftKey) return native(m.clientX, m.clientY, sel.has(e.name) ? selected() : [pathOf(e)], true); // Shift: straight to the Windows menu
          setMenu({ x: m.clientX, y: m.clientY, items: itemMenu(e, m.clientX, m.clientY) });
        }}
        title={e && grid && !st.hoverCards ? `${label}\n${fmtDate(e.modified)}` : e && virtual ? pathOf(e) : undefined}
      >
        {e ? (
          grid ? (
            <>{icon}<span className="cell-label" role="gridcell">{name}{dots}{badge}</span></>
          ) : (
            <>
              {shownCols.map((c) => c.id === 'name'
                ? <span key="name" className="name" role="gridcell">{icon}{name}{dots}{badge}{virtual && !inArchive && renaming !== e.name && <span className="where muted">{parentPath(pathOf(e))}</span>}</span>
                : <Fragment key={c.id}>{cell(c.id, e, real, pathOf(e), sizes)}</Fragment>)}
            </>
          )
        ) : <span className="muted skeleton" />}
      </div>,
    );
  }

  return (
    <div className={`list${grid ? ' is-grid' : ''}`} style={{ ['--cell-w' as string]: `${CELL_W - 8}px`, ['--cell-h' as string]: `${CELL_H - 8}px`, ['--dcols' as string]: gridTemplate(shownCols) }} role="grid" aria-rowcount={total} aria-multiselectable onMouseDownCapture={claim} onFocusCapture={claim} aria-label={virtual ? 'Results' : `Contents of ${baseName(dir)}`}>
      <CommandBar
        can={{ make: !virtual && !!dir, any: sel.size > 0 && !inArchive, one: sel.size === 1 && !inArchive, paste: !virtual && !!dir && actions.canPaste }}
        run={(f) => { f(); box.current?.focus(); }}
        paths={selected()} here={virtual ? '' : here()} reload={reload}
        extra={inArchive ? (
          <>
            <button className="cmd has-text" onMouseDown={(e) => e.preventDefault()} onClick={() => startExtractJob([inArchive.file], 'folder').catch(actions.error)} title="Extract everything into a folder next to the archive">
              <ArchiveRestore size={16} /><span>Extract all</span>
            </button>
            {sel.size > 0 && <button className="cmd has-text" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={(e) => extractButton(e.currentTarget)}><FolderOutput size={16} /><span>Extract selected</span></button>}
          </>
        ) : selArchives.length > 0 && selArchives.length === sel.size ? (
          <button className="cmd has-text" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={(e) => extractButton(e.currentTarget)}><FolderOutput size={16} /><span>Extract</span></button>
        ) : null}
        cmds={{
          newFolder, paste, selectAll, delete: del, refresh: reload,
          cut: () => actions.copy(selected(), true),
          copy: () => actions.copy(selected(), false),
          rename: () => (sel.size > 1 ? batchRename() : setRenaming([...sel][0])),
          properties: () => properties(selected()[0]).catch(actions.error),
          share: () => shareItems(selected()),
          copyAsPath: () => copyAsPath(selected()),
          terminal: () => terminal(here()),
        }} />
      {!grid && (
        <div className="head-wrap" ref={headWrap}>
          <DetailsHeader cols={shownCols} onLive={setLiveCols} onCommit={setColumns} sort={sort} desc={desc} then={sortThen} onSort={onSort}
            openMenu={(x, y, items) => setMenu({ x, y, items })} />
        </div>
      )}
      <div
        className="scroller"
        data-drop={virtual ? undefined : dir}
        onMouseMove={onMove}
        onMouseUp={onUp}
        ref={box}
        tabIndex={0}
        aria-activedescendant={focus >= 0 ? `${id}-r${focus}` : undefined}
        onKeyDown={onKey}
        onScroll={(ev) => {
          const { scrollTop: top, scrollLeft } = ev.currentTarget;
          if (headWrap.current) headWrap.current.scrollLeft = scrollLeft;
          if (hover) unhover();
          setVp((v) => ({ ...v, top }));
        }}
        onMouseDown={startMarquee}
        onContextMenu={(m) => {
          m.preventDefault(); setSel(new Set());
          if (m.shiftKey && !virtual) return native(m.clientX, m.clientY, [], true);
          setMenu({ x: m.clientX, y: m.clientY, items: bgMenu(m.clientX, m.clientY) });
        }}
      >
        <div className="sizer" style={{ height: L.height + 12, minWidth: grid ? undefined : colsWidth(shownCols) }} onMouseDown={startMarquee}>
          {items}
          {headsIn(L, vp.top - pad, vp.top + vp.height).map(({ seg, y, stuck }) => {
            const open = !collapsed.includes(seg.key);
            return (
              <button
                key={`g:${seg.key}`}
                className={`group-head${stuck ? ' stuck' : ''}`}
                style={{ transform: `translateY(${y + pad}px)` }}
                aria-expanded={open}
                onMouseDown={(m) => m.stopPropagation()}
                onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && k.stopPropagation()}
                onClick={() => setCollapsedBy({ by: groupBy, keys: open ? [...collapsed, seg.key] : collapsed.filter((k) => k !== seg.key) })}
              >
                <ChevronRight size={14} className="chev" aria-hidden />
                <span className="group-label">{labelOf(groupBy, seg.key)}</span>
                <span className="muted">{seg.count.toLocaleString()}</span>
              </button>
            );
          })}
          {marquee && (
            <div className="marquee" style={{
              left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
            }} />
          )}
        </div>
        {error && (
          /os error (2|3)\)/.test(error) ? (
            // A folder that was deleted or renamed (often a tab restored from last time).
            <div className="empty" role="alert">
              <p>“{baseName(path)}” doesn’t exist any more. It may have been moved, renamed or deleted.</p>
              <button className="btn" onClick={() => actions.navigate(parentPath(path))}>Go to {baseName(parentPath(path))}</button>
            </div>
          ) : /os error 5\)/.test(error) ? (
            <div className="empty" role="alert">You don’t have permission to open “{baseName(path)}”.</div>
          ) : <div className="empty" role="alert">{error}</div>
        )}
        {!error && loaded && total === 0 && (
          <div className="empty">{filter ? `Nothing here matches “${filter}”` : virtual ? 'Nothing here yet' : 'This folder is empty'}</div>
        )}
      </div>
      <AnimatePresence>{menu && <ContextMenu key="menu" {...menu} onClose={() => { setMenu(null); box.current?.focus(); }} />}</AnimatePresence>
      {hover && st.hoverCards && !menu && !marquee && !renaming && entryAt(hover.i) && <HoverCard key={hover.i} e={entryAt(hover.i)!} path={pathOf(entryAt(hover.i)!)} x={hover.x} y={hover.y} />}
      <AnimatePresence>
        {quick !== null && quick >= 0 && (
          <QuickLook key="quick" index={quick} total={total} entry={entryAt(quick)} path={entryAt(quick) ? pathOf(entryAt(quick)!) : ''}
            onStep={stepQuick} onClose={() => { setQuick(null); box.current?.focus(); }} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {confirmForever && (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setConfirmForever(null)}>
            <motion.div className="modal confirm" role="alertdialog" aria-modal aria-labelledby={`${id}-forever`}
              initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setConfirmForever(null); box.current?.focus(); } }}>
              <h3 id={`${id}-forever`}>Delete {confirmForever.length > 1 ? `${confirmForever.length} items` : `“${baseName(confirmForever[0])}”`} permanently?</h3>
              <p className="muted">{isRemote(confirmForever[0]) ? 'It is deleted from the server. Servers have no Recycle Bin, so this can\'t be undone.' : 'This skips the Recycle Bin and can\'t be undone.'}</p>
              <div className="confirm-buttons">
                <button className="btn" autoFocus onClick={() => { setConfirmForever(null); box.current?.focus(); }}>Cancel</button>
                <button className="btn danger-solid" onClick={() => deleteNow(confirmForever)}>Delete permanently</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {batch && (
          <BatchRename key="batch" paths={batch} onClose={() => { setBatch(null); box.current?.focus(); }}
            onDone={(now) => { if (now.length) { setSel(new Set(now.map((p) => (dir ? baseName(p) : p)))); reload(); } }} />
        )}
        {prompt === 'pattern' && (
          <PromptDialog key="pattern" title="Select by pattern" label="Names like" placeholder="*.png; IMG_20??*" submit="Select"
            hint="* matches anything, ? one character; separate several patterns with ;"
            onSubmit={selectPattern} onClose={() => { setPrompt(null); box.current?.focus(); }} />
        )}
        {prompt === 'folders' && (
          <PromptDialog key="folders" title="Create several folders" label="One folder per line" placeholder={'Invoices\nPhotos\\2024\\January'} submit="Create" multiline
            hint="Use \ to make folders inside folders. Ctrl+Enter creates them."
            onSubmit={makeFolders} onClose={() => { setPrompt(null); box.current?.focus(); }} />
        )}
      </AnimatePresence>
    </div>
  );
}

/** An app's own icon in menus; anything that can't be read shows a generic app glyph. */
function AppIcon({ file }: { file: string | null }) {
  const [bad, setBad] = useState(false);
  return file && !bad ? <img src={iconUrl(file)} alt="" width={16} height={16} onError={() => setBad(true)} /> : <AppWindow size={15} />;
}

const LEVELS = { fast: 1, balanced: 6, smallest: 9 } as const;
/** "Photos.tar.gz" -> "Photos" (the folder "Extract to" makes). */
const archiveStem = (p: string) => baseName(p).replace(/\.(tar\.(gz|bz2|xz)|zip|7z|rar|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i, '');

