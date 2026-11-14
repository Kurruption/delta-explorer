import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { convertFileSrc } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  Briefcase, ChevronsLeft, ChevronsRight, Clock, Cloud, Columns2, Copy, Eye, FolderOpen, HardDrive, House, Minus, Moon, Palette as PaletteIcon, Pin,
  Settings as SettingsIcon, Square, Sun, Tag, Undo2, X, PanelRight, Server, Plus, AppWindow, Clipboard, CopyPlus, Keyboard, Lock, PanelTop, Share2, SquareTerminal, Terminal, UserRound,
} from 'lucide-react';
import { newWindow, windowAtCursor, windowInit } from './api';
import { is } from './keymap';
import { fromPayload, payload, removeTab, insertTab, duplicateTab, editTab, type TabPayload } from './tabs';
import { openSettingsAt, paletteCommands } from './CommandBar';
import { copyAsPath, makeShortcuts, shareItems, terminal, withActive } from './shellExtras';
import { profileCommands } from './ProfilesPanel';
import {
  baseName, clipRead, clipWrite, HOME, isFolder, launchPath, openPath, parentPath, places as loadPlaces, setHotkey, setVirtual, setWindowEffect, startJob, VIEWABLE, watchDirs, type Places,
  isRemote, remoteConfigure, remoteHome, remoteOpen,
} from './api';
import { useDragDrop } from './dragdrop';
import { LIST_COMMANDS, pasteAsFile } from './QuickDialogs';
import { clipHasData } from './api';
import { Home } from './Home';
import { JobsPanel, useJobEvents } from './jobs';
import { Pane, newTab, type PaneState } from './Pane';
import { Palette, type Command } from './Palette';
import { PhotoViewer } from './PhotoViewer';
import { Settings } from './Settings';
import { BgEditor, BgLayer } from './BgEditor';
import { Sidebar } from './Sidebar';
import { ToolHost } from './Tools';
import { useCleanerSchedule } from './Cleaner';
import { ChartPie, Files } from 'lucide-react';
import { FolderIcon, toneFor } from './icons';
import {
  addRecent, applyAppearance, errorToast, pathsWithTag, pinned, recent, resolvedTheme, session, setSetting, settings, tagged, tags, toast, toasts,
  undoStack, workspaces, THEMES, type Workspace, bgEditor, remoteEditor, remotes, openTool,
} from './store';
import { RemoteDialog } from './RemoteDialog';
import { glide, snap } from './motion';
import { viewProfiles } from './store';
import { GROUPS } from './details';
import { Bookmark, Calculator, Layers, MousePointer2, Save } from 'lucide-react';
import icon from './assets/icon-small.svg';
import { Columns3, FolderTree, GitBranch, GitCompare, Inbox, Library } from 'lucide-react';
import { Shelf, shelfOpen } from './Shelf';
import { CompareDialog } from './Compare';
import { MetaDialog } from './MetaDialog';
import { showChanged } from './git';
import { collections, compareDialog, metaDialog, newCollection } from './store';

const win = getCurrentWindow();
const paneFrom = (paths: string[], meta?: ({ color?: string; locked?: boolean } | null)[]): PaneState => ({ tabs: (paths.length ? paths : [HOME]).map((x, i) => ({ ...newTab(x), ...(meta?.[i] ?? {}) })), active: 0 });
/** Only the first window restores and saves the session; extra windows start fresh and never overwrite it. */
const isMain = win.label === 'main';
const savable = (p: PaneState) => p.tabs.filter((t) => !t.history[t.idx].startsWith('search:'));
const pathsOf = (p: PaneState) => p.tabs.map((t) => t.history[t.idx]);

export default function App() {
  const st = settings.use();
  const undo = undoStack.use();
  const [places, setPlaces] = useState<Places | null>(null);
  const saved = isMain ? session.get() : null;
  const [panes, setPanes] = useState<PaneState[]>(() => (saved?.panes?.length ? saved.panes.map((x, i) => paneFrom(x, saved.meta?.[i])) : [paneFrom([HOME])]));
  const [split, setSplit] = useState(() => !!saved?.split && (saved?.panes?.length ?? 0) > 1);
  const [activePane, setActivePane] = useState(0);
  const [clip, setClip] = useState<{ paths: string[]; cut: boolean } | null>(null);
  const [viewing, setViewing] = useState<{ path: string; dir: string; from?: DOMRect } | null>(null);
  const [overlay, setOverlay] = useState<'settings' | 'palette' | null>(null);
  const [settingsPage, setSettingsPage] = useState<string | undefined>();
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const navRef = useRef<((p: string, newTab?: boolean) => void) | null>(null);
  const searchRef = useRef<(() => void) | null>(null);
  const panesBox = useRef<HTMLDivElement>(null);

  useJobEvents();
  useCleanerSchedule();
  const bgPath = bgEditor.use();
  const { beginDrag, ghost } = useDragDrop(errorToast);

  // Appearance follows settings (and Windows' light/dark when the theme is "System").
  useEffect(() => applyAppearance(st), [st]);
  // The window starts hidden (tauri.conf.json) so the WebView's blank white frame never shows; reveal it once themed and painted.
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => { getCurrentWindow().show().catch(() => {}); })); }, []);
  useEffect(() => { getCurrentWebview().setZoom(st.uiScale).catch(() => { /* zoom unsupported: stay at 100% */ }); }, [st.uiScale]);
  // Windows' blur only matters when the window is see-through; solid windows skip it (cheaper, and no drag lag).
  const effect = st.windowOpacity < 1 ? st.windowEffect : 'none';
  useEffect(() => { setWindowEffect(effect).catch(() => { /* older Windows: just stays solid */ }); }, [effect]);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const f = () => applyAppearance(settings.get());
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);

  useEffect(() => {
    loadPlaces().then(setPlaces, errorToast);
    if (st.hotkey && isMain) setHotkey(st.hotkey).catch(() => toast(`Couldn't register ${st.hotkey}; another app may use it`, 'error'));
    // Launched with a folder (shortcut / Win+E second instance): open it in a new tab.
    if (isMain) launchPath().then((p) => p && navRef.current?.(p, true));
    // A new window opened with tabs (New window, or a tab dragged out).
    else windowInit<{ tabs?: TabPayload[] }>().then((i) => { if (i?.tabs?.length) setPanes([{ tabs: i.tabs.map(fromPayload), active: 0 }]); }, errorToast);
    // Launches go to the window used last (Rust sends them only to it).
    const un = win.listen<string>('open-path', ({ payload }) => navRef.current?.(payload || HOME, true));
    // A tab dropped onto this window from another Delta window.
    const un2 = win.listen<TabPayload>('tab-in', ({ payload: t }) => {
      setPanes((ps) => ps.map((p, i) => (i === activeRef.current ? insertTab(p, fromPayload(t)) : p)));
      win.setFocus().catch(() => {});
    });
    const openSettings = (e: Event) => { setSettingsPage((e as CustomEvent<string>).detail); setOverlay('settings'); };
    addEventListener('open-settings', openSettings);
    return () => { un.then((f) => f()); un2.then((f) => f()); removeEventListener('open-settings', openSettings); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember tabs for next launch; watch every open folder for live updates.
  const shownPanes = split ? panes.slice(0, 2) : panes.slice(0, 1);
  useEffect(() => {
    if (!isMain) return;
    const keep = shownPanes.map(savable);
    session.set({ panes: keep.map((ts) => ts.map((t) => t.history[t.idx])), split, meta: keep.map((ts) => ts.map((t) => (t.color || t.locked ? { color: t.color, locked: t.locked } : null))) });
  }, [panes, split]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeRef = useRef(activePane);
  activeRef.current = activePane;
  const watched = shownPanes.flatMap(pathsOf).filter((x) => isFolder(x) && !isRemote(x)).join('|');
  useEffect(() => { watchDirs(watched ? watched.split('|') : []).catch(() => { /* best effort */ }); }, [watched]);

  // Tag and Recent lists live in Rust as "virtual" listings; keep them current and tell open views.
  const tagMap = tagged.use();
  const rec = recent.use();
  const tagList = tags.use();
  // Saved remote connections live in Rust's pool; open remote views retry once it knows them (startup race).
  const conns = remotes.use();
  const editingRemote = remoteEditor.use();
  useEffect(() => { remoteConfigure(conns).then(() => dispatchEvent(new Event('remotes-changed')), errorToast); }, [conns]);
  useEffect(() => {
    Promise.all([...tagList.map((t) => setVirtual(`tag:${t.id}`, pathsWithTag(t.id))), setVirtual('recent', rec)])
      .then(() => dispatchEvent(new Event('virtual-changed')));
  }, [tagMap, rec, tagList]);

  // Collections are virtual lists too (v:col:<id>).
  const cols = collections.use();
  useEffect(() => { Promise.all(cols.map((c) => setVirtual(`col:${c.id}`, c.paths))).then(() => dispatchEvent(new Event('virtual-changed'))); }, [cols]);
  const cmp = compareDialog.use();
  const metaPath = metaDialog.use();

  const navigate = useCallback((p: string, nt = false) => navRef.current?.(p, nt), []);
  const openFile = useCallback((p: string) => {
    if (isRemote(p)) { remoteOpen(p).catch(errorToast); return; } // a downloaded temp copy opens in its app
    addRecent(p);
    if (settings.get().photosInViewer && VIEWABLE.test(p)) setViewing({ path: p, dir: parentPath(p) });
    else openPath(p).catch(errorToast);
  }, []);
  const toggleSplit = () => {
    if (split) { setSplit(false); setActivePane(0); return; }
    setPanes((ps) => [ps[0], paneFrom([pathsOf(ps[0])[ps[0].active] ?? HOME])]);
    setSplit(true);
    setActivePane(1);
  };
  // The Windows clipboard is the source of truth, so files copied in File Explorer paste here and the other way round.
  const [osFiles, setOsFiles] = useState(false);
  const [osData, setOsData] = useState(false); // text or a picture: Paste makes a new file of it
  useEffect(() => {
    const check = () => clipRead().then((c) => {
      setOsFiles(!!c?.[0].length);
      if (!c?.[0].length) clipHasData().then(setOsData, () => setOsData(false));
      // Something else was copied since (in Explorer or any app): forget Delta's own copy/cut.
      // (Remote items never reach the Windows clipboard, so their copy/cut stays.)
      setClip((old) => (old && (old.paths.some(isRemote) || (c && old.paths.length === c[0].length && old.paths.every((p, i) => p.toLowerCase() === c[0][i].toLowerCase()))) ? old : null));
    }, () => setOsFiles(false));
    check();
    addEventListener('focus', check);
    return () => removeEventListener('focus', check);
  }, []);
  const copyToClip = (paths: string[], cut: boolean) => {
    setClip({ paths, cut });
    if (!paths.some(isRemote)) clipWrite(paths, cut).then(() => setOsFiles(true), () => { /* Delta's own clipboard still works */ });
    toast(`${paths.length > 1 ? `${paths.length} items` : `“${baseName(paths[0])}”`} ${cut ? 'cut' : 'copied'}`);
  };
  const paste = async (dest: string) => {
    const os = await clipRead().catch(() => null);
    const src = clip?.paths.some(isRemote) ? clip : os?.[0].length ? { paths: os[0], cut: os[1] } : clip;
    if (!src) { await pasteAsFile(dest); return; } // text or a picture becomes a new file
    await startJob(src.cut ? 'move' : 'copy', src.paths, dest);
    if (src.cut) setClip(null);
  };
  const comparePanes = () => {
    const [a, b] = panes.slice(0, 2).map((p) => pathsOf(p)[p.active]);
    if (!split || !a || !b || !isFolder(a) || !isFolder(b)) return toast('Open a folder in each pane to compare them', 'error');
    compareDialog.set({ kind: 'folders', a, b });
  };
  const runUndo = () => {
    const last = undoStack.get().at(-1);
    if (!last) return toast('Nothing to undo');
    undoStack.set((s) => s.slice(0, -1));
    last.run().then(() => toast(`Undone: ${last.label}`), errorToast);
  };
  const saveWorkspace = (name: string) => {
    workspaces.set((ws) => [...ws.filter((w) => w.name !== name), { name, panes: shownPanes.map(pathsOf), split }]);
    toast(`Saved workspace “${name}”`);
  };
  const openWorkspace = (w: Workspace) => {
    setPanes(w.panes.map((x) => paneFrom(x)));
    setSplit(w.split && w.panes.length > 1);
    setActivePane(0);
  };

  // App shortcuts (panes handle their own, dialogs own the keyboard while open).
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (viewing) return;
      if (is(k, 'palette')) { k.preventDefault(); setOverlay((o) => (o === 'palette' ? null : 'palette')); }
      else if (is(k, 'settings')) { k.preventDefault(); setOverlay((o) => (o === 'settings' ? null : 'settings')); }
      else if (overlay) return;
      else if (is(k, 'split')) { k.preventDefault(); toggleSplit(); }
      else if (is(k, 'undo')) { k.preventDefault(); runUndo(); }
      else if (is(k, 'otherPane') && split) { k.preventDefault(); setActivePane((a) => 1 - a); }
      else if (is(k, 'newWindow')) { k.preventDefault(); newWindow().catch(errorToast); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const profs = viewProfiles.use();
  const commands = useMemo<Command[]>(() => {
    const go = (p: string) => () => navigate(p);
    const cur = ((p) => pathsOf(p)[p.active] ?? HOME)(shownPanes[Math.min(activePane, shownPanes.length - 1)]); // the active pane's folder
    const c: Command[] = [
      { id: 'settings', group: 'Commands', label: 'Settings', hint: 'Ctrl ,', icon: <SettingsIcon size={15} />, run: () => setOverlay('settings') },
      { id: 'split', group: 'Commands', label: split ? 'Close split view' : 'Split view', hint: 'Ctrl \\', icon: <Columns2 size={15} />, run: toggleSplit },
      { id: 'undo', group: 'Commands', label: undo.length ? `Undo: ${undo[undo.length - 1].label}` : 'Undo', hint: 'Ctrl Z', icon: <Undo2 size={15} />, run: runUndo },
      { id: 'sidebar', group: 'Commands', label: st.sidebar ? 'Hide sidebar' : 'Show sidebar', icon: <ChevronsLeft size={15} />, run: () => setSetting('sidebar', !st.sidebar) },
      { id: 'preview', group: 'Commands', label: st.previewPane ? 'Hide preview pane' : 'Show preview pane', hint: 'Alt P', icon: <PanelRight size={15} />, run: () => setSetting('previewPane', !st.previewPane) },
      { id: 'hidden', group: 'Commands', label: st.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: <Eye size={15} />, run: () => setSetting('showHidden', !st.showHidden) },
      ...THEMES.map((t) => ({ id: `theme-${t.id}`, group: 'Themes', label: `Theme: ${t.name}`, icon: resolvedTheme(t.id) === 'light' ? <Sun size={15} /> : <Moon size={15} />, run: () => setSetting('theme', t.id) })),
      { id: 'home', group: 'Go to', label: 'Home', icon: <House size={15} />, run: go(HOME) },
      { id: 'recent', group: 'Go to', label: 'Recent files', icon: <Clock size={15} />, run: go('v:recent') },
      ...(places?.quick ?? []).map((q) => ({ id: q.path, group: 'Go to', label: q.name, hint: q.path, icon: <FolderIcon tone={toneFor(q.name, q.path, places?.home ?? '')} size={15} />, run: go(q.path) })),
      ...(places?.cloud ?? []).map((q) => ({ id: q.path, group: 'Go to', label: q.name, hint: q.path, icon: <Cloud size={15} />, run: go(q.path) })),
      ...(places?.drives ?? []).map((d) => ({ id: d.path, group: 'Go to', label: `${d.label} (${d.path.slice(0, 2)})`, icon: <HardDrive size={15} />, run: go(d.path) })),
      ...pinned.get().map((p) => ({ id: `pin:${p}`, group: 'Pinned', label: baseName(p), hint: p, icon: <Pin size={15} />, run: go(p) })),
      ...tagList.map((t) => ({ id: `tag:${t.id}`, group: 'Tags', label: `Tag: ${t.name}`, icon: <Tag size={15} color={t.color} />, run: go(`v:tag:${t.id}`) })),
      ...workspaces.get().map((w) => ({ id: `ws:${w.name}`, group: 'Workspaces', label: `Workspace: ${w.name}`, icon: <Briefcase size={15} />, run: () => openWorkspace(w) })),
      { id: 'remote-add', group: 'Remote', label: 'Add remote connection (SFTP, FTP, WebDAV)…', icon: <Plus size={15} />, run: () => remoteEditor.set('new') },
      ...conns.map((r) => ({ id: `rm:${r.id}`, group: 'Remote', label: r.name, hint: `${r.protocol.toUpperCase()} · ${r.host}`, icon: <Server size={15} />, run: go(remoteHome(r)) })),
      { id: 'cleaner', group: 'Tools', label: 'Clean storage now…', icon: <ChartPie size={15} />, run: () => openTool('cleaner', []) },
      ...(isFolder(cur) ? [
        { id: 'dupes', group: 'Tools', label: `Find duplicates in ${baseName(cur)}`, icon: <Files size={15} />, run: () => openTool('dupes', [cur]) },
        { id: 'storage', group: 'Tools', label: `Analyse storage of ${baseName(cur)}`, icon: <ChartPie size={15} />, run: () => openTool('storage', [cur]) },
      ] : []),
      ...(places?.drives ?? []).map((d) => ({ id: `storage:${d.path}`, group: 'Tools', label: `Analyse storage of ${d.label} (${d.path.slice(0, 2)})`, icon: <ChartPie size={15} />, run: () => openTool('storage', [d.path]) })),
      ...rec.slice(0, 15).map((f) => ({ id: `rf:${f}`, group: 'Recent files', label: baseName(f), hint: parentPath(f), icon: <FolderOpen size={15} />, run: () => openFile(f) })),
      // File actions run in the active pane's list (FileList listens for "delta-cmd").
      ...LIST_COMMANDS.map(([id, label, hint]) => ({ id: `cmd:${id}`, group: 'Selection & files', label, hint, icon: <Copy size={15} />, run: () => dispatchEvent(new CustomEvent('delta-cmd', { detail: id })) })),
      // Power features
      ...(split ? [{ id: 'compare-panes', group: 'Commands', label: 'Compare panes (folder compare & sync)', icon: <GitCompare size={15} />, run: comparePanes }] : []),
      { id: 'shelf', group: 'Commands', label: shelfOpen.get() ? 'Hide shelf' : 'Show shelf (Drop Zone)', icon: <Inbox size={15} />, run: () => shelfOpen.set((o) => !o) },
      ...(['list', 'grid', 'columns'] as const).map((v) => ({ id: `view-${v}`, group: 'Commands', label: `Layout: ${v[0].toUpperCase()}${v.slice(1)}`, icon: <Columns3 size={15} />, run: () => setSetting('defaultView', v) })),
      { id: 'folders', group: 'Commands', label: st.hiddenSections.includes('folders') || !st.sections.folders ? 'Show folder tree in sidebar' : 'Hide folder tree', icon: <FolderTree size={15} />, run: () => { const on = st.hiddenSections.includes('folders') || !st.sections.folders; setSetting('hiddenSections', st.hiddenSections.filter((x) => x !== 'folders')); setSetting('sections', { ...st.sections, folders: on }); } },
      { id: 'git-changed', group: 'Commands', label: 'Git: show only changed files', icon: <GitBranch size={15} />, run: () => showChanged(currentRef.current, navigate).catch(errorToast) },
      { id: 'new-col', group: 'Commands', label: 'New collection', icon: <Library size={15} />, run: () => navigate(`v:col:${newCollection(`Collection ${collections.get().length + 1}`).id}`) },
      ...cols.map((x) => ({ id: `col:${x.id}`, group: 'Collections', label: `Collection: ${x.name}`, icon: <Library size={15} />, run: go(`v:col:${x.id}`) })),
      ...GROUPS.map((g) => ({ id: `group-${g.v}`, group: 'View', label: `Group by: ${g.label}${st.groupBy === g.v ? ' ✓' : ''}`, icon: <Layers size={15} />, run: () => setSetting('groupBy', g.v) })),
      { id: 'folder-sizes', group: 'View', label: st.folderSizes ? 'Hide folder sizes' : 'Show folder sizes', icon: <Calculator size={15} />, run: () => setSetting('folderSizes', !st.folderSizes) },
      { id: 'hover-cards', group: 'View', label: st.hoverCards ? 'Turn off hover info cards' : 'Turn on hover info cards', icon: <MousePointer2 size={15} />, run: () => setSetting('hoverCards', !st.hoverCards) },
      { id: 'save-profile', group: 'View', label: 'Save view as profile…', icon: <Save size={15} />, run: () => dispatchEvent(new Event('save-profile')) },
      ...profs.map((p) => ({ id: `profile:${p.name}`, group: 'View', label: `View profile: ${p.name}`, icon: <Bookmark size={15} />, run: () => dispatchEvent(new CustomEvent('apply-profile', { detail: p.name })) })),
      { id: 'new-window', group: 'Windows & tabs', label: 'New window', hint: 'Ctrl N', icon: <AppWindow size={15} />, run: () => newWindow().catch(errorToast) },
      { id: 'tab-window', group: 'Windows & tabs', label: 'Move tab to a new window', icon: <PanelTop size={15} />, run: () => tabOut(activePane, panes[activePane].active) },
      { id: 'tab-dup', group: 'Windows & tabs', label: 'Duplicate tab', icon: <CopyPlus size={15} />, run: () => editPane(activePane, (p) => duplicateTab(p, p.active)) },
      { id: 'tab-lock', group: 'Windows & tabs', label: 'Lock / unlock tab', icon: <Lock size={15} />, run: () => editPane(activePane, (p) => editTab(p, p.active, (t) => ({ ...t, locked: !t.locked }))) },
      { id: 'share', group: 'Files', label: 'Share selected', icon: <Share2 size={15} />, run: withActive((a) => shareItems(a.selected()), true) },
      { id: 'copy-as-path', group: 'Files', label: 'Copy as path', icon: <Clipboard size={15} />, run: withActive((a) => copyAsPath(a.selected().length ? a.selected() : [a.dir])) },
      { id: 'shortcut', group: 'Files', label: 'Create shortcut', icon: <Copy size={15} />, run: withActive((a) => makeShortcuts(a.selected(), a.reload), true) },
      { id: 'terminal', group: 'Files', label: 'Open in Terminal', icon: <SquareTerminal size={15} />, run: () => isFolder(current) && terminal(current) },
      { id: 'powershell', group: 'Files', label: 'Open PowerShell here', icon: <Terminal size={15} />, run: () => isFolder(current) && terminal(current, 'powershell') },
      { id: 'cmd', group: 'Files', label: 'Open Command Prompt here', icon: <Terminal size={15} />, run: () => isFolder(current) && terminal(current, 'cmd') },
      { id: 'keys', group: 'Commands', label: 'Keyboard shortcuts', icon: <Keyboard size={15} />, run: () => openSettingsAt('keys') },
      { id: 'cmdbar', group: 'Commands', label: 'Customise command bar', icon: <SettingsIcon size={15} />, run: () => openSettingsAt('cmdbar') },
      { id: 'profiles', group: 'Commands', label: 'Profiles, export and import', icon: <UserRound size={15} />, run: () => openSettingsAt('profiles') },
      ...profileCommands(),
    ];
    return c;
  }, [places, split, st.sidebar, st.showHidden, undo, tagList, rec, st.previewPane, cols, st.sections, st.hiddenSections, st.groupBy, st.folderSizes, st.hoverCards, profs, conns, activePane, panes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => paletteCommands.set(commands), [commands]);

  const cutPaths = useMemo(() => new Set(clip?.cut ? clip.paths : []), [clip]);
  const clipInfo = clip && `${clip.paths.length} ${clip.cut ? 'to move' : 'copied'}`;
  const ratio = dragRatio ?? st.splitRatio;
  const current = (() => { const p = shownPanes[Math.min(activePane, shownPanes.length - 1)]; return pathsOf(p)[p.active] ?? HOME; })();
  const currentRef = useRef(current);
  currentRef.current = current;

  // Rail/floating sidebar: open while hovered; stays open while one of its menus is showing.
  const [peek, setPeek] = useState(false);
  const leaveTimer = useRef<number>(0);
  const leaveSide = () => {
    clearTimeout(leaveTimer.current);
    const check = () => { if (document.querySelector('.menu, .side-name input')) leaveTimer.current = window.setTimeout(check, 300); else setPeek(false); };
    leaveTimer.current = window.setTimeout(check, 280);
  };
  const sidebar = (compact: boolean) => (
    <Sidebar
      compact={compact}
      places={places}
      current={current}
      navigate={navigate}
      openFile={openFile}
      openTag={(id) => navigate(`v:tag:${id}`)}
      openRecent={() => navigate('v:recent')}
      focusSearch={() => searchRef.current?.()}
      openPalette={() => setOverlay('palette')}
      openSettings={(page) => { setSettingsPage(page); setOverlay('settings'); }}
      saveWorkspace={saveWorkspace}
      openWorkspace={openWorkspace}
      onError={errorToast}
    />
  );

  // ---- tabs between panes and windows ----
  const editPane = (i: number, f: (p: PaneState) => PaneState) => setPanes((ps) => ps.map((p, j) => (j === i ? f(p) : p)));
  /** A tab leaves this window: onto another Delta window under the pointer, or into a new one. */
  const tabOut = async (from: number, ti: number, dropped = false) => {
    const t = panes[from]?.tabs[ti];
    if (!t) return;
    try {
      const target = dropped ? await windowAtCursor() : null;
      if (target) await emitTo(target, 'tab-in', payload(t));
      else await newWindow({ tabs: [payload(t)] }, dropped);
    } catch (e) { return errorToast(e); }
    // The last tab of an extra window takes the window with it (like a browser).
    if (!isMain && shownPanes.length === 1 && panes[from].tabs.length === 1) return void win.close();
    editPane(from, (p) => removeTab(p, ti));
  };
  /** Where a tab dragged off its strip would land: another pane's tabs, a split edge, or outside. */
  const tabTarget = (from: number, x: number, y: number): { pane: number } | { side: 'left' | 'right' } | 'out' | null => {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'out';
    const strip = document.elementFromPoint(x, y)?.closest('.tabs[data-pane]');
    if (strip) { const k = strip.getAttribute('data-pane') === 'a' ? 0 : 1; return k === from ? null : { pane: k }; }
    const r = panesBox.current?.getBoundingClientRect();
    if (!r || y < r.top || y > r.bottom) return null;
    const rel = (x - r.left) / r.width;
    return rel < 0.22 ? { side: 'left' } : rel > 0.78 ? { side: 'right' } : null;
  };
  const [tabHint, setTabHint] = useState<'left' | 'right' | null>(null);
  const tabDrop = (from: number, ti: number, x: number, y: number) => {
    setTabHint(null);
    const at = tabTarget(from, x, y);
    const t = panes[from]?.tabs[ti];
    if (!at || !t) return;
    if (at === 'out') return void tabOut(from, ti, true);
    const into = 'pane' in at ? at.pane : split ? (at.side === 'left' ? 0 : 1) : null;
    if (into !== null) {
      if (into === from) return;
      setPanes((ps) => ps.map((p, j) => (j === from ? removeTab(p, ti) : j === into ? insertTab(p, t) : p)));
      setActivePane(into);
      return;
    }
    // Not split yet: the tab becomes the new pane on that side.
    const rest = removeTab(panes[from], ti), alone: PaneState = { tabs: [t], active: 0 };
    if ('pane' in at) return;
    setPanes(at.side === 'left' ? [alone, rest] : [rest, alone]);
    setSplit(true);
    setActivePane(at.side === 'left' ? 0 : 1);
  };

  const pane = (i: number) => (
    <Pane
      id={i === 0 ? 'a' : 'b'}
      state={panes[i]}
      setState={(f) => setPanes((ps) => ps.map((p, j) => (j === i ? f(p) : p)))}
      active={activePane === i}
      onActivate={() => activePane !== i && setActivePane(i)}
      places={places}
      cutPaths={cutPaths}
      clipInfo={clipInfo}
      split={split}
      onToggleSplit={i === 1 ? () => { setSplit(false); setActivePane(0); } : toggleSplit}
      registerNavigate={(f) => { navRef.current = f; }}
      registerSearch={(f) => { searchRef.current = f; }}
      onTabDrag={(pt) => { const at = pt && tabTarget(i, pt.x, pt.y); setTabHint(at && at !== 'out' && 'side' in at && !split ? at.side : null); }}
      onTabDrop={(ti, x, y) => tabDrop(i, ti, x, y)}
      onTabOut={(ti) => void tabOut(i, ti)}
      actions={{ openFile, view: (p, from) => setViewing({ path: p, dir: parentPath(p), from }), copy: copyToClip, paste, canPaste: !!clip || osFiles || osData, pin: (p) => pinned.set((ps) => (ps.includes(p) ? ps : [...ps, p])), error: errorToast, beginDrag }}
      showHome={(open) => <Home places={places} onOpen={open} onOpenFile={openFile} />}
      onComparePanes={split ? comparePanes : undefined}
    />
  );

  const motionTransition = st.motion === 'off' ? { duration: 0 } : undefined;
  return (
    <MotionConfig reducedMotion={st.motion === 'full' ? 'user' : 'always'} transition={motionTransition}>
      <div className="app">
        <header className="titlebar" data-tauri-drag-region>
          <motion.img src={icon} alt="" width={20} height={20} className="logo" data-tauri-drag-region initial={{ rotate: -90, scale: 0.4, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={glide} />
          <button className="icon-btn" aria-label={st.sidebar ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSetting('sidebar', !st.sidebar)}>
            <motion.span animate={{ rotate: st.sidebar ? 0 : 180 }} transition={snap} style={{ display: 'grid' }}><ChevronsLeft size={16} /></motion.span>
          </button>
          <span className="title" data-tauri-drag-region>Delta Explorer</span>
          <button className="icon-btn" aria-label="Command palette (Ctrl+K)" title="Command palette (Ctrl+K)" onClick={() => setOverlay('palette')}><PaletteIcon size={15} /></button>
          <div className="win-controls">
            <button aria-label="Minimize" onClick={() => win.minimize()}><Minus size={16} /></button>
            <button aria-label="Maximize" onClick={() => win.toggleMaximize()}><Square size={13} /></button>
            <button aria-label="Close" className="close" onClick={() => win.close()}><X size={17} /></button>
          </div>
        </header>

        <div className={`body side-${st.sidebarSide}`}>
          {/* Sidebar: full (always open), rail (icons; expands over the panes on hover) or floating
              (hidden; slides in when the pointer touches the window edge, like Zen's compact mode). */}
          <AnimatePresence initial={false}>
            {st.sidebar && st.sidebarStyle === 'full' && (
              <motion.div className="side-wrap" key="full" initial={{ width: 0, opacity: 0 }} animate={{ width: 252, opacity: 1, transition: glide }} exit={{ width: 0, opacity: 0, transition: { ...glide, opacity: { duration: 0.12 } } }}>
                {sidebar(false)}
              </motion.div>
            )}
            {st.sidebar && st.sidebarStyle === 'rail' && (
              <motion.div className="side-wrap rail" key="rail" initial={{ width: 0 }} animate={{ width: 64, transition: glide }} exit={{ width: 0 }}>
                <motion.div className={`side-float${peek ? ' open' : ''}`} animate={{ width: peek ? 252 : 64, transition: glide }}
                  onMouseEnter={() => setPeek(true)} onMouseLeave={leaveSide}>
                  {sidebar(!peek)}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
          {st.sidebar && st.sidebarStyle === 'floating' && (
            <>
              <div className="side-edge" onMouseEnter={() => setPeek(true)} aria-hidden />
              <AnimatePresence>
                {peek && (
                  <motion.div className="side-float floating open" key="float"
                    initial={{ x: st.sidebarSide === 'left' ? -280 : 280, opacity: 0.4 }} animate={{ x: 0, opacity: 1, transition: glide }}
                    exit={{ x: st.sidebarSide === 'left' ? -280 : 280, opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
                    onMouseEnter={() => setPeek(true)} onMouseLeave={leaveSide}>
                    {sidebar(false)}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}

          <div className={`panes${split ? ' is-split' : ''}${st.bgImage ? ' has-bg' : ''}`} ref={panesBox} style={{ ['--bg-strength' as string]: st.bgOpacity }}>
            {st.bgImage && <BgLayer s={st} />}
            <AnimatePresence>
              {tabHint && <motion.div key={tabHint} className={`split-hint ${tabHint}`} aria-hidden initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={snap} />}
            </AnimatePresence>
            <div className="pane-slot" style={{ flex: split ? `${ratio} 1 0` : '1 1 0' }}>{pane(0)}</div>
            <AnimatePresence>
              {split && panes[1] && (
                <>
                  <motion.div
                    key="divider"
                    className="divider"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize panes (double-click to reset)"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    onDoubleClick={() => setSetting('splitRatio', 0.5)}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const r = panesBox.current!.getBoundingClientRect();
                      const move = (ev: PointerEvent) => setDragRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - r.left) / r.width)));
                      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setDragRatio((v) => { if (v) setSetting('splitRatio', v); return null; }); };
                      addEventListener('pointermove', move);
                      addEventListener('pointerup', up);
                    }}
                  />
                  <motion.div key="b" className="pane-slot" style={{ flex: `${1 - ratio} 1 0` }}
                    initial={{ opacity: 0, x: 60, flexGrow: 0 }} animate={{ opacity: 1, x: 0, flexGrow: 1 - ratio, transition: glide }} exit={{ opacity: 0, x: 60, flexGrow: 0, transition: { duration: 0.2 } }}>
                    {pane(1)}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>

        <AnimatePresence>
          {viewing && (
            <PhotoViewer key="viewer" {...viewing} sort="name" desc={false} showHidden={st.showHidden} onClose={() => setViewing(null)} onError={errorToast} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {overlay === 'settings' && <Settings key="settings" section={settingsPage} onClose={() => { setOverlay(null); setSettingsPage(undefined); }} />}
          {overlay === 'palette' && <Palette key="palette" commands={commands} onClose={() => setOverlay(null)} onPath={(p) => navigate(p)} />}
        </AnimatePresence>
        <AnimatePresence>{editingRemote && <RemoteDialog key="remote" initial={editingRemote === 'new' ? null : editingRemote} onClose={() => remoteEditor.set(null)} onOpen={(c) => navigate(remoteHome(c))} />}</AnimatePresence>
        <AnimatePresence>{bgPath && <BgEditor key="bg" path={bgPath} ratio={panesBox.current ? panesBox.current.clientWidth / Math.max(1, panesBox.current.clientHeight) : 1.6} />}</AnimatePresence>
        <AnimatePresence>
          {cmp && <CompareDialog key="cmp" {...cmp} />}
          {metaPath && <MetaDialog key="meta" path={metaPath} />}
        </AnimatePresence>
        <Shelf current={current} beginDrag={beginDrag} />
        {ghost}
        <ToolHost navigate={(p) => navigate(p)} />
        <JobsPanel />
        <Toasts />
      </div>
    </MotionConfig>
  );
}

function Toasts() {
  const list = toasts.use();
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {list.map((t) => (
          <motion.div key={t.id} layout className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}
            initial={{ opacity: 0, y: 24, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1, transition: glide }} exit={{ opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.16 } }}>
            <span>{t.text}</span>
            {t.action && <button className="btn small" onClick={() => { t.action!.run(); toasts.set((all) => all.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
            {t.kind === 'error' && <button className="icon-btn small" aria-label="Copy error" onClick={() => navigator.clipboard.writeText(t.text)}><Copy size={14} /></button>}
            <button className="icon-btn small" aria-label="Dismiss" onClick={() => toasts.set((all) => all.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
