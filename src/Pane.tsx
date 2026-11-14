import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Clock, Columns2, House, LayoutGrid, List, PanelRight, Plus, RotateCw, Search, Tag, Trash2, X, SlidersHorizontal, Server, AppWindow, CopyPlus, Lock, LockOpen, Palette, Archive,
} from 'lucide-react';
import { baseName, BIN, fmtSize, freeSpace, HOME, isFolder, parentPath, parseSearch, resolvePath, searchPath, uncRoot, type Places, type SortKey, isRemote, remoteId, remoteRoot, archivePath, parseArchive } from './api';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { NameDialog, viewMenu } from './details';
import { FileList, type ListActions, type View } from './FileList';
import { Home } from './Home';
import { FolderIcon, toneFor } from './icons';
import { folderColumns, folderViews, setSetting, settings, tags, toast, viewProfiles, type Col, type ViewProfile, remotes, FOLDER_COLORS } from './store';
import { is, keyLabel as kl } from './keymap';
import { duplicateTab, editTab, insertTab, moveTab, newTab, type PaneState, type Tab } from './tabs';
import { RecycleBin } from './RecycleBin';
import { fade, glide, snap } from './motion';
import { PreviewPane, previewDrag, type PreviewTarget } from './Preview';
import { Columns3, GitBranch, GitCompare, Library } from 'lucide-react';
import { Columns } from './Columns';
import { showChanged, useGit } from './git';
import { collections } from './store';

export { newTab, type PaneState, type Tab } from './tabs';
/** Recently closed tabs (Ctrl+Shift+T reopens them). */
const closed: string[] = [];

/** Human name for any location, including search results and virtual lists. */
export function locationName(p: string) {
  if (p === HOME) return 'Home';
  if (p === BIN) return 'Recycle Bin';
  const s = parseSearch(p);
  if (s) return `“${s.q}”`;
  if (p === 'v:recent') return 'Recent';
  if (p.startsWith('v:tag:')) return tags.get().find((t) => `v:tag:${t.id}` === p)?.name ?? 'Tag';
  if (p === 'v:git') return 'Changed files';
  if (p.startsWith('v:col:')) return collections.get().find((c) => `v:col:${c.id}` === p)?.name ?? 'Collection';
  if (isRemote(p) && p.length <= remoteRoot(p).length) return remoteName(p);
  return baseName(p);
}

/** A remote location's connection name ("remote:<id>/..." -> "My server"). */
const remoteName = (p: string) => remotes.get().find((c) => c.id === remoteId(p))?.name ?? 'Remote';
/** Recursive search runs on this PC's disks only. */
const canSearch = (p: string) => isFolder(p) && !isRemote(p);

interface Props {
  id: string;
  state: PaneState;
  setState: (f: (s: PaneState) => PaneState) => void;
  active: boolean;
  onActivate: () => void;
  places: Places | null;
  actions: Omit<ListActions, 'navigate'> & { openFile: (p: string) => void };
  cutPaths: Set<string>;
  clipInfo: string | null;
  split: boolean;
  onToggleSplit: () => void;
  /** The sidebar/palette navigate into the active pane through this. */
  registerNavigate: (f: ((p: string, newTab?: boolean) => void) | null) => void;
  registerSearch: (f: (() => void) | null) => void;
  showHome: (open: (p: string, newTab?: boolean) => void) => React.ReactNode;
  /** Split view: compare this pane's folder with the other one. */
  onComparePanes?: () => void;
  /** A tab dragged out of this strip: where it is (null: back over the strip) and where it was dropped. */
  onTabDrag?: (pt: { x: number; y: number } | null) => void;
  onTabDrop?: (tabIndex: number, x: number, y: number) => void;
  /** "Move to new window". */
  onTabOut?: (tabIndex: number) => void;
}

export function Pane(p: Props) {
  const st = settings.use();
  const { tabs, active } = p.state;
  const tab = tabs[Math.min(active, tabs.length - 1)];
  const path = tab.history[tab.idx];
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [info, setInfo] = useState({ total: 0, selected: 0, selectedSize: 0, path: '', loaded: false });
  const [free, setFree] = useState<number | null>(null);
  const [viewOpts, setViewOpts] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [naming, setNaming] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [preview, setPreview] = useState<PreviewTarget>({ dir: '', focused: null, selected: [] });
  const previewW = previewDrag.use() ?? st.previewWidth;
  const sort = st.sort; // remembered across restarts
  // Layout: per folder (like File Explorer) when that setting is on, otherwise one layout everywhere.
  const views = folderViews.use();
  const viewKey = (parseSearch(path)?.root ?? path).toLowerCase();
  // One shared setting, so every folder, tab and pane switches together.
  const view: View = st.layoutPerFolder ? views[viewKey] ?? st.defaultView : st.defaultView;
  const setView = (v: View) => {
    if (st.layoutPerFolder) folderViews.set((m) => ({ ...m, [viewKey]: v }));
    else setSetting('defaultView', v);
  };
  // Details columns: per folder with "Remember layout per folder", otherwise one set everywhere.
  const colMap = folderColumns.use();
  const columns: Col[] = st.layoutPerFolder ? colMap[viewKey] ?? st.columns : st.columns;
  const setColumns = (c: Col[]) => {
    if (st.layoutPerFolder) folderColumns.set((m) => ({ ...m, [viewKey]: c }));
    else setSetting('columns', c);
  };
  // Click: sort by this (again: flip). Shift+click: sort by this as well, as the second key.
  const onSort = (k: SortKey, add: boolean) => {
    const byDefaultDesc = k === 'modified' || k === 'size' || k === 'created' || k === 'accessed';
    if (add && k !== sort.key) { setSetting('sortThen', { key: k, desc: st.sortThen?.key === k ? !st.sortThen.desc : byDefaultDesc }); return; }
    if (k !== sort.key) setSetting('sortThen', null);
    setSetting('sort', { key: k, desc: sort.key === k ? !sort.desc : byDefaultDesc });
  };
  const profiles = viewProfiles.use();
  const applyProfile = (pr: ViewProfile) => {
    setColumns(pr.columns); setSetting('sort', pr.sort); setSetting('sortThen', pr.sortThen); setSetting('groupBy', pr.groupBy); setSetting('iconSize', pr.iconSize); setView(pr.view);
    toast(`View profile “${pr.name}”`);
  };
  const saveProfile = (name: string) => {
    viewProfiles.set((ps) => [...ps.filter((x) => x.name !== name), { name, columns, sort, sortThen: st.sortThen, groupBy: st.groupBy, view, iconSize: st.iconSize }]);
    toast(`Saved view profile “${name}”`);
  };
  const openViewMenu = (x: number, y: number) => setViewOpts({
    x, y, items: viewMenu({
      groupBy: st.groupBy, setGroup: (g) => setSetting('groupBy', g), cols: columns, setCols: setColumns,
      folderSizes: st.folderSizes, hoverCards: st.hoverCards, toggle: (k) => setSetting(k, !st[k]),
      profiles, apply: applyProfile, save: () => setNaming(true), remove: (n) => viewProfiles.set((ps) => ps.filter((x) => x.name !== n)),
    }),
  });
  // Free space of the drive shown (refreshed when the item count changes, e.g. after a copy).
  useEffect(() => {
    if (!info.path) { setFree(null); return; }
    let live = true;
    freeSpace(info.path).then((f) => live && setFree(f), () => live && setFree(null));
    return () => { live = false; };
  }, [info.path, info.total]);
  const [dir, setDir] = useState(1); // direction of the last navigation, for the page slide
  const searchBox = useRef<HTMLInputElement>(null);
  const millerView = view === 'columns' && isFolder(path);
  const search = parseSearch(path);
  const showPreview = st.previewPane && path !== HOME && path !== BIN;
  const home = p.places?.home ?? '';
  const git = useGit(isFolder(path) ? path : '');

  // Back/Forward and tab switches bring back the scroll position and selection; other navigation starts fresh.
  const viaHistory = useRef(false);
  const update = (f: (t: Tab) => Tab) => { viaHistory.current = false; p.setState((s) => ({ ...s, tabs: s.tabs.map((t, i) => (i === s.active ? f(t) : t)) })); };
  const navigate = (to: string, inNewTab = false) => {
    setQuery(''); setEditing(null);
    if (inNewTab) { p.setState((s) => ({ ...s, tabs: [...s.tabs, newTab(to)] })); return; }
    // A locked tab stays where it is: going anywhere else opens a new tab.
    if (tab.locked && to !== path) { setDir(1); p.setState((s) => insertTab(s, newTab(to))); return; }
    setDir(1);
    update((t) => (t.history[t.idx] === to ? t : { ...t, history: [...t.history.slice(0, t.idx + 1), to], idx: t.idx + 1 }));
  };
  const go = (d: number) => { if (tab.locked) { const t = tab.history[tab.idx + d]; if (t) navigate(t); return; } setQuery(''); setDir(d); update((t) => ({ ...t, idx: Math.max(0, Math.min(t.history.length - 1, t.idx + d)) }));  viaHistory.current = true; };
  const addTab = (to = path) => p.setState((s) => ({ tabs: [...s.tabs, newTab(to)], active: s.tabs.length }));
  const closeTab = (i: number) => {
    closed.push(tabs[i].history[tabs[i].idx]);
    if (closed.length > 20) closed.shift();
    p.setState((s) => (s.tabs.length === 1 ? { tabs: [newTab(HOME)], active: 0 } : { tabs: s.tabs.filter((_, j) => j !== i), active: s.active > i || s.active === s.tabs.length - 1 ? Math.max(0, s.active - 1) : s.active }));
  };
  const switchTab = (i: number) => { setQuery(''); setDir(i > active ? 1 : -1); viaHistory.current = true; p.setState((s) => ({ ...s, active: i })); };
  // Up: the parent folder; from search results, straight back to the folder the search started in.
  const up = () => { if (search) navigate(search.root); else if (isFolder(path) || parseArchive(path)) navigate(parentPath(path)); };
  const goTo = (typed: string) => {
    const word = typed.toLowerCase();
    if (word === 'home') return navigate(HOME);
    if (word === 'recycle bin' || word === 'shell:recyclebinfolder') return navigate(BIN);
    if (isRemote(typed.trim())) return navigate(typed.trim());
    resolvePath(typed).then((r) => {
      if (r.isDir) return navigate(r.path);
      navigate(parentPath(r.path));
      p.actions.openFile(r.path);
    }, p.actions.error);
  };
  const replaceCurrent = (to: string) => update((t) => ({ ...t, history: t.history.map((h, j) => (j === t.idx ? to : h)) }));
  /** Adds a history entry without touching the search box (used by live search). */
  const push = (to: string) => { if (tab.locked) return navigate(to); setDir(1); update((t) => ({ ...t, history: [...t.history.slice(0, t.idx + 1), to], idx: t.idx + 1 })); };

  // Search like File Explorer: typing searches this folder and every folder inside it (no Enter needed).
  // The first keystroke opens a results view; further typing updates it in place; clearing goes back.
  useEffect(() => {
    if (search && query.trim() !== search.q) setQuery(search.q);
    if (!search && !document.activeElement?.matches('.search input')) setQuery('');
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = search ? search.root : path;
    if (!canSearch(root)) return;
    const q = query.trim();
    const t = setTimeout(() => {
      if (q && search?.q !== q) (search ? replaceCurrent : push)(searchPath(root, q));
      else if (!q && search) { replaceCurrent(root); }
    }, 260);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hand our navigate/search to the app while we're the active pane.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  useEffect(() => {
    if (!p.active) return;
    p.registerNavigate((to, nt) => navRef.current(to, nt));
    p.registerSearch(() => searchBox.current?.focus());
  }, [p.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Command palette: view profiles act on the active pane.
  const profRef = useRef({ applyProfile, open: () => setNaming(true) });
  profRef.current = { applyProfile, open: () => setNaming(true) };
  useEffect(() => {
    if (!p.active) return;
    const apply = (e: Event) => { const pr = viewProfiles.get().find((x) => x.name === (e as CustomEvent<string>).detail); if (pr) profRef.current.applyProfile(pr); };
    const save = () => profRef.current.open();
    addEventListener('apply-profile', apply); addEventListener('save-profile', save);
    return () => { removeEventListener('apply-profile', apply); removeEventListener('save-profile', save); };
  }, [p.active]);

  // Pane shortcuts, only for the active pane.
  useEffect(() => {
    if (!p.active) return;
    const onKey = (k: KeyboardEvent) => {
      if (document.querySelector('.viewer, .modal')) return; // dialogs own the keyboard
      const ctrl = k.ctrlKey || k.metaKey;
      if (is(k, 'reopenTab')) { k.preventDefault(); const last = closed.pop(); if (last) addTab(last); }
      else if (is(k, 'newTab')) { k.preventDefault(); addTab(); }
      else if (ctrl && !k.shiftKey && !k.altKey && /^[1-9]$/.test(k.key)) { k.preventDefault(); switchTab(k.key === '9' ? tabs.length - 1 : Math.min(tabs.length - 1, +k.key - 1)); }
      else if (is(k, 'address')) { k.preventDefault(); setEditing(isFolder(base) ? base : ''); }
      else if (is(k, 'closeTab')) { k.preventDefault(); closeTab(active); }
      else if (is(k, 'nextTab') || is(k, 'prevTab')) { k.preventDefault(); switchTab((active + (is(k, 'prevTab') ? -1 : 1) + tabs.length) % tabs.length); }
      else if (is(k, 'search')) { k.preventDefault(); searchBox.current?.focus(); }
      else if (is(k, 'back')) { k.preventDefault(); go(-1); }
      else if (is(k, 'forward')) go(1);
      else if (is(k, 'up')) up();
      else if (is(k, 'previewPane')) { k.preventDefault(); setSetting('previewPane', !settings.get().previewPane); }
      else if (is(k, 'duplicateTab')) { k.preventDefault(); p.setState((s) => duplicateTab(s, s.active)); }
      else if (is(k, 'lockTab')) { k.preventDefault(); p.setState((s) => editTab(s, s.active, (t) => ({ ...t, locked: !t.locked }))); }
      else if (is(k, 'tabToWindow')) { k.preventDefault(); p.onTabOut?.(active); }
    };
    // Mouse side buttons: back (button 3) and forward (button 4).
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === 'mouseup' && !document.querySelector('.viewer, .modal')) go(e.button === 3 ? -1 : 1);
    };
    addEventListener('keydown', onKey);
    addEventListener('mousedown', onMouse);
    addEventListener('mouseup', onMouse);
    return () => { removeEventListener('keydown', onKey); removeEventListener('mousedown', onMouse); removeEventListener('mouseup', onMouse); };
  });

  // Breadcrumb: "C:\" then each folder; long paths keep the drive and the last 3 folders.
  const base = search ? search.root : path;
  // A network share ("\\server\share") is one crumb.
  const unc = uncRoot(base);
  const segs = !isFolder(base) ? [] : unc ? [unc, ...base.slice(unc.length).split('\\').filter(Boolean)] : base.replace(/\\+$/, '').split('\\');
  const rroot = isRemote(base) ? remoteRoot(base) : null;
  const all = rroot
    ? [{ name: remoteName(base), path: rroot }, ...base.slice(rroot.length).split('/').filter(Boolean).map((seg, i, a) => ({ name: seg, path: rroot + a.slice(0, i + 1).join('/') }))]
    : segs.map((seg, i, a) => ({ name: seg, path: i === 0 ? (unc ? seg : seg + '\\') : a.slice(0, i + 1).join('\\') }));
  const hidden = all.length > 5 ? all.slice(1, -3) : [];
  // Inside an archive: the folder holding it, the archive, then folders inside it (all clickable).
  const arc = parseArchive(path);
  const arcCrumbs = arc && [
    { name: baseName(parentPath(arc.file)), path: parentPath(arc.file) },
    { name: baseName(arc.file), path: archivePath(arc.file) },
    ...arc.inner.split('\\').filter(Boolean).map((n, i, a) => ({ name: n, path: archivePath(arc.file, a.slice(0, i + 1).join('\\')) })),
  ];
  const crumbs = arcCrumbs ? arcCrumbs : search && all.length ? [all[all.length - 1]] : hidden.length ? [all[0], { name: '…', path: hidden[hidden.length - 1].path, more: true }, ...all.slice(-3)] : all;
  const special = path === HOME ? { icon: <House size={15} />, text: 'Home' } : path === BIN ? { icon: <Trash2 size={15} />, text: 'Recycle Bin' } : path === 'v:recent' ? { icon: <Clock size={15} />, text: 'Recent files' } : path.startsWith('v:tag:') ? { icon: <Tag size={15} />, text: `Tag · ${locationName(path)}` } : path === 'v:git' ? { icon: <GitBranch size={15} />, text: 'Changed files (git)' } : path.startsWith('v:col:') ? { icon: <Library size={15} />, text: `Collection · ${locationName(path)}` } : null;

  const tabIcon = (t: string) => t === HOME ? <House size={14} /> : t === BIN ? <Trash2 size={14} /> : parseSearch(t) ? <Search size={14} /> : t === 'v:recent' ? <Clock size={14} /> : t.startsWith('v:tag:') ? <Tag size={14} /> : t === 'v:git' ? <GitBranch size={14} /> : isRemote(t) ? <Server size={14} /> : parseArchive(t) ? <Archive size={14} /> : t.startsWith('v:col:') ? <Library size={14} /> : <FolderIcon tone={toneFor(baseName(t), t, home)} size={15} />;

  // ---- tab menu and dragging ----
  const [tabMenuState, setTabMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const setTabColor = (i: number, color?: string) => p.setState((s) => editTab(s, i, (t) => ({ ...t, color })));
  const tabMenu = (i: number): MenuItem[] => {
    const t = tabs[i];
    return [
      { label: 'New tab', icon: <Plus size={15} />, shortcut: kl('newTab'), run: () => addTab() },
      { label: 'Duplicate tab', icon: <CopyPlus size={15} />, shortcut: kl('duplicateTab'), run: () => p.setState((s) => duplicateTab(s, i)) },
      { label: t.locked ? 'Unlock tab' : 'Lock tab', icon: t.locked ? <LockOpen size={15} /> : <Lock size={15} />, shortcut: kl('lockTab'), run: () => p.setState((s) => editTab(s, i, (x) => ({ ...x, locked: !x.locked }))) },
      { label: 'Tab colour', icon: <Palette size={15} />, sub: () => [
        ...FOLDER_COLORS.map((c) => ({ label: c.name, icon: <span className="color-dot" style={{ background: c.c }} />, checked: t.color === c.c, run: () => setTabColor(i, c.c) })),
        'sep' as const,
        { label: 'No colour', icon: <X size={15} />, run: () => setTabColor(i) },
      ] },
      { label: 'Move to new window', icon: <AppWindow size={15} />, shortcut: kl('tabToWindow'), run: () => p.onTabOut?.(i) },
      'sep',
      { label: 'Close tab', icon: <X size={15} />, shortcut: kl('closeTab'), run: () => closeTab(i) },
      { label: 'Close other tabs', icon: <X size={15} />, disabled: tabs.length < 2, run: () => p.setState((s) => ({ tabs: [s.tabs[i]], active: 0 })) },
    ];
  };
  // Drag along the strip to reorder; drag off it to split, move to the other pane, or out to another window.
  const dragTab = (i: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget, strip = el.parentElement!, id = tabs[i].id, x0 = e.clientX, y0 = e.clientY;
    let dragging = false, out = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        dragging = true;
        el.setPointerCapture(ev.pointerId); // keeps the drag going outside the window
        document.body.classList.add('tab-dragging');
      }
      const r = strip.getBoundingClientRect();
      out = ev.clientY < r.top - 24 || ev.clientY > r.bottom + 24 || ev.clientX < 0 || ev.clientX > innerWidth;
      p.onTabDrag?.(out ? { x: ev.clientX, y: ev.clientY } : null);
      if (out) return;
      const others = [...strip.querySelectorAll<HTMLElement>(':scope > .tab')].filter((t) => t !== el);
      const to = others.filter((t) => { const b = t.getBoundingClientRect(); return b.left + b.width / 2 < ev.clientX; }).length;
      p.setState((s) => moveTab(s, s.tabs.findIndex((t) => t.id === id), to));
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      document.body.classList.remove('tab-dragging');
      if (!dragging) return;
      p.onTabDrag?.(null);
      if (out) p.onTabDrop?.(tabsRef.current.findIndex((t) => t.id === id), ev.clientX, ev.clientY);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

  const tabbar = (
      <footer className={`tabbar ${st.tabsPosition}`}>
        <LayoutGroup id={`tabs-${p.id}`}>
          <div className="tabs" role="tablist" aria-label="Tabs" data-pane={p.id}>
            <AnimatePresence initial={false}>
              {tabs.map((t, i) => {
                const tp = t.history[t.idx];
                const sel = i === active;
                return (
                  <motion.div
                    key={t.id}
                    layout
                    className={`tab${t.color ? ' has-color' : ''}${t.locked ? ' locked' : ''}`}
                    style={t.color ? { ['--tab-color' as string]: t.color } : undefined}
                    role="tab"
                    aria-selected={sel}
                    tabIndex={0}
                    title={tp === HOME ? 'Home' : tp}
                    data-drop={isFolder(tp) ? tp : undefined}
                    initial={{ opacity: 0, scale: 0.85, width: 0 }}
                    animate={{ opacity: 1, scale: 1, width: 'auto', transition: snap }}
                    exit={{ opacity: 0, scale: 0.85, width: 0, paddingLeft: 0, paddingRight: 0, transition: { duration: 0.16 } }}
                    onClick={() => switchTab(i)}
                    onKeyDown={(e) => e.key === 'Enter' && switchTab(i)}
                    onAuxClick={(e) => e.button === 1 && closeTab(i)}
                    onPointerDown={(e) => dragTab(i, e)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabMenu({ x: e.clientX, y: e.clientY, items: tabMenu(i) }); }}
                  >
                    {sel && <motion.span layoutId={`tab-ind-${p.id}`} className="tab-ind" transition={snap} />}
                    {tabIcon(tp)}
                    {t.locked && <Lock size={11} className="tab-lock" aria-label="Locked" />}
                    <span className="tab-label">{locationName(tp)}</span>
                    <button className="x" aria-label={`Close ${locationName(tp)}`} onClick={(e) => { e.stopPropagation(); closeTab(i); }}><X size={13} /></button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            <motion.button layout className="icon-btn" aria-label="New tab (Ctrl+T)" title="New tab (Ctrl+T)" onClick={() => addTab()} whileTap={{ scale: 0.88 }}><Plus size={16} /></motion.button>
          </div>
        </LayoutGroup>
        <span className="status muted" aria-live="polite">
          {path !== HOME && path !== BIN && `${info.total.toLocaleString()} ${search ? 'found' : 'items'}`}{info.selected > 0 && path !== HOME && path !== BIN && ` · ${info.selected.toLocaleString()} selected${info.selectedSize ? ` (${fmtSize(info.selectedSize)})` : ''}`}
          {free !== null && path !== HOME && path !== BIN && <span className="free" title={`Free space on ${info.path.slice(0, 2)}`}> · {fmtSize(free)} free</span>}
          {p.clipInfo && ` · ${p.clipInfo}`}
        </span>
        {git && (
          <button className="git-chip" title={`Git branch ${git.branch} in ${git.root}. Click: show only changed files`} onClick={() => showChanged(path, navigate).catch(p.actions.error)}>
            <GitBranch size={13} /><span>{git.branch}</span>{git.changed > 0 && <span className="git-count">{git.changed}</span>}
          </button>
        )}
        <div className="view-toggle" role="group" aria-label="Layout">
          {(['list', 'grid', 'columns'] as const).map((v) => (
            <button key={v} className="icon-btn" aria-label={`${v === 'list' ? 'List' : v === 'grid' ? 'Grid' : 'Columns'} view`} aria-pressed={view === v} onClick={() => setView(v)}>
              {view === v && <motion.span layoutId={`view-pill-${p.id}`} className="view-pill" transition={snap} />}
              {v === 'list' ? <List size={16} /> : v === 'grid' ? <LayoutGrid size={16} /> : <Columns3 size={16} />}
            </button>
          ))}
        </div>
      </footer>
  );

  return (
    <section className={`pane tabs-${st.tabsPosition}${p.active ? ' is-active' : ''}`} onMouseDownCapture={p.onActivate} onFocusCapture={p.onActivate} aria-label={`Pane: ${locationName(path)}`}>
      {st.tabsPosition === 'top' && tabbar}
      <nav className="toolbar">
        <button className="icon-btn" aria-label="Back (Alt+←)" title="Back (Alt+←)" disabled={tab.idx === 0} onClick={() => go(-1)}><ArrowLeft size={17} /></button>
        <button className="icon-btn" aria-label="Forward (Alt+→)" title="Forward (Alt+→)" disabled={tab.idx >= tab.history.length - 1} onClick={() => go(1)}><ArrowRight size={17} /></button>
        <button className="icon-btn" aria-label={search ? 'Back to the folder you searched in' : 'Up one folder (Alt+↑)'} title={search ? `Back to ${baseName(search.root)}` : 'Up (Alt+↑)'} disabled={!isFolder(path) && !search && !parseArchive(path)} onClick={up}><ArrowUp size={17} /></button>
        <button className="icon-btn spin-on-click" aria-label="Refresh (F5)" title="Refresh (F5)" onClick={(e) => { setReloadKey((k) => k + 1); e.currentTarget.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 500, easing: 'cubic-bezier(.16,1,.3,1)' }); }}><RotateCw size={16} /></button>
        <button className="icon-btn" aria-label="Home" title="Home" onClick={() => navigate(HOME)}><House size={16} /></button>

        {editing !== null ? (
          <motion.form className="crumbs editing" initial={{ opacity: 0.6 }} animate={{ opacity: 1 }} onSubmit={(e) => { e.preventDefault(); const t = editing.trim(); setEditing(null); if (t) goTo(t); }}>
            <input autoFocus aria-label="Address" value={editing} spellCheck={false} onChange={(e) => setEditing(e.target.value)} onBlur={() => setEditing(null)} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
          </motion.form>
        ) : (
          <div className="crumbs" onClick={(e) => e.target === e.currentTarget && setEditing(isFolder(base) ? base : '')} title="Click to type a path (Ctrl+L)">
            {special ? <span className="crumb current with-icon">{special.icon}{special.text}</span> : (
              <AnimatePresence initial={false} mode="popLayout">
                {crumbs.map((c, i) => (
                  <motion.span key={c.path + ('more' in c ? '…' : '')} className="crumb-wrap" layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: snap }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                    <button data-drop={'more' in c || !isFolder(c.path) ? undefined : c.path} className={`crumb${i === crumbs.length - 1 && !search ? ' current' : ''}${'more' in c ? ' more' : ''}`} title={'more' in c ? hidden.map((h) => h.name).join(' › ') : undefined} onClick={() => navigate(c.path)}>{c.name}</button>
                    {(i < crumbs.length - 1 || search) && <ChevronRight size={13} className="muted" aria-hidden />}
                  </motion.span>
                ))}
                {search && (
                  <motion.span key="search" className="crumb-wrap" layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: snap }}>
                    <span className="crumb current with-icon"><Search size={13} />Results for “{search.q}”</span>
                  </motion.span>
                )}
              </AnimatePresence>
            )}
          </div>
        )}

        <label className={`search${!canSearch(search ? search.root : path) ? ' disabled' : ''}`} title="Searches this folder and all folders inside it">
          <Search size={15} aria-hidden />
          <input
            ref={searchBox}
            placeholder={isRemote(path) ? 'Search isn\'t available on remote folders' : isFolder(search ? search.root : path) ? `Search ${locationName(search ? search.root : path)}` : 'Open a folder to search'}
            aria-label="Search this folder and its subfolders"
            value={query}
            disabled={!canSearch(search ? search.root : path)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
          <AnimatePresence>
            {query && (
              <motion.button key="clear" className="icon-btn small" aria-label="Clear search" onClick={() => { setQuery(''); searchBox.current?.focus(); }}
                initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={snap}>
                <X size={13} />
              </motion.button>
            )}
          </AnimatePresence>
        </label>
        <button className="icon-btn" aria-label="Preview pane (Alt+P)" title="Preview pane (Alt+P)" aria-pressed={st.previewPane} onClick={() => setSetting('previewPane', !st.previewPane)}><PanelRight size={16} /></button>
        {p.onComparePanes && <button className="icon-btn" aria-label="Compare panes" title="Compare panes (folder compare &amp; sync)" onClick={p.onComparePanes}><GitCompare size={16} /></button>}
        <button className="icon-btn" aria-label="View options" title="View options: group, columns, profiles" aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openViewMenu(r.left, r.bottom + 4); }}><SlidersHorizontal size={16} /></button>
        <button className="icon-btn" aria-label={p.split ? (p.id === 'b' ? 'Close this pane' : 'Close split view') : 'Split view (Ctrl+\\)'} title={p.split ? 'Close split view' : 'Split view (Ctrl+\\)'} aria-pressed={p.split} onClick={p.onToggleSplit}>
          {p.split && p.id === 'b' ? <X size={16} /> : <Columns2 size={16} />}
        </button>
      </nav>

      <main className={`content${showPreview ? ' has-preview' : ''}`} style={showPreview ? { ['--pv-w' as string]: `${previewW}px` } : undefined}>
        <AnimatePresence initial={false} mode="popLayout" custom={dir}>
          <motion.div
            key={`${tab.id}|${millerView ? 'cols' : search ? `s:${search.root}` : path}|${view}`}
            className="page"
            custom={dir}
            variants={{
              enter: (d: number) => ({ opacity: 0, x: d * 22 }),
              center: { opacity: 1, x: 0, transition: glide },
              leave: (d: number) => ({ opacity: 0, x: d * -22, transition: fade }),
            }}
            initial="enter"
            animate="center"
            exit="leave"
          >
            {path === HOME ? p.showHome(navigate) : path === BIN ? <RecycleBin onError={p.actions.error} /> : millerView ? (
              <Columns id={`p${p.id}t${tab.id}`} path={path} home={home} sort={sort.key} desc={sort.desc} reloadKey={reloadKey} actions={{ ...p.actions, navigate }} onInfo={setInfo} />
            ) : (
              <FileList
                id={`p${p.id}t${tab.id}`}
                path={path}
                home={home}
                view={view}
                sort={sort.key}
                desc={sort.desc}
                onSort={onSort}
                sortThen={st.sortThen}
                groupBy={st.groupBy}
                columns={columns}
                setColumns={setColumns}
                filter=""
                reloadKey={reloadKey}
                cutPaths={p.cutPaths}
                actions={{ ...p.actions, navigate }}
                onInfo={setInfo}
                onPreview={showPreview ? setPreview : undefined}
                restore={viaHistory.current}
              />
            )}
          </motion.div>
        </AnimatePresence>
        <AnimatePresence>
          {search && !info.loaded && (
            <motion.div className="searching" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={snap}>
              <span className="spinner" aria-hidden /> Searching {baseName(search.root)} and its subfolders…
            </motion.div>
          )}
        </AnimatePresence>
        {showPreview && <PreviewPane target={preview} folderTotal={info.total} />}
      </main>


      {st.tabsPosition === 'bottom' && tabbar}
      <AnimatePresence>{viewOpts && <ContextMenu key="view-menu" {...viewOpts} onClose={() => setViewOpts(null)} />}</AnimatePresence>
      <AnimatePresence>{naming && <NameDialog key="name" title="Save view as profile" onDone={(n) => { setNaming(false); if (n) saveProfile(n); }} />}</AnimatePresence>
      <AnimatePresence>{tabMenuState && <ContextMenu key="tabmenu" {...tabMenuState} onClose={() => setTabMenu(null)} />}</AnimatePresence>
    </section>
  );
}
