import { useState, type ReactNode } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown, ArrowUp, Briefcase, ChevronDown, Clock, Cloud, Command, EyeOff, HardDrive, House, Pencil, Pin, PinOff, Plus, Search, Server, Settings as SettingsIcon, SlidersHorizontal, Tag, Trash2, X,
} from 'lucide-react';
import { baseName, BIN, fmtSize, HOME, remoteHome, remoteRoot, type Places } from './api';
import { FileVisual, FolderIcon, toneFor } from './icons';
import { folderColors, pinned, recent, remoteEditor, remotes, SECTION_NAMES, setSetting, settings, tags, workspaces, type SectionId, type Workspace } from './store';
import { glide, snap } from './motion';
import { FolderTree as FolderTreeIcon, Library } from 'lucide-react';
import { FolderTree } from './FolderTree';
import { CollectionsList } from './powerMenu';

interface Props {
  /** Rail mode: icons only (labels appear when it expands on hover). */
  compact?: boolean;
  places: Places | null;
  /** Path shown in the active pane (drives the sliding highlight). */
  current: string;
  navigate: (p: string, newTab?: boolean) => void;
  openFile: (p: string) => void;
  openTag: (id: string) => void;
  openRecent: () => void;
  focusSearch: () => void;
  openPalette: () => void;
  openSettings: (section?: string) => void;
  saveWorkspace: (name: string) => void;
  openWorkspace: (w: Workspace) => void;
  onError: (e: unknown) => void;
}

/** Dorion-style grouped sidebar with Atlas sections. */
export function Sidebar(p: Props) {
  const st = settings.use();
  const pins = pinned.use();
  const rec = recent.use();
  const tagList = tags.use();
  const spaces = workspaces.use();
  const conns = remotes.use();
  const colors = folderColors.use();
  const [naming, setNaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const home = p.places?.home ?? '';
  const open = st.sections;

  const toggle = (id: string) => setSetting('sections', { ...open, [id]: !open[id] });
  // Right-click a section title: reorder or hide it (bring it back in Settings → Sidebar).
  const headMenu = (id: SectionId, e: React.MouseEvent) => {
    e.preventDefault();
    const order = st.sectionOrder.filter((x) => !st.hiddenSections.includes(x));
    const i = order.indexOf(id);
    const move = (d: number) => {
      const all = [...st.sectionOrder];
      const other = order[i + d];
      const a = all.indexOf(id), b = all.indexOf(other);
      [all[a], all[b]] = [all[b], all[a]];
      setSetting('sectionOrder', all);
    };
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'Move up', icon: <ArrowUp size={15} />, disabled: i <= 0, run: () => move(-1) },
      { label: 'Move down', icon: <ArrowDown size={15} />, disabled: i >= order.length - 1, run: () => move(1) },
      'sep',
      { label: `Hide ${SECTION_NAMES[id]}`, icon: <EyeOff size={15} />, run: () => setSetting('hiddenSections', [...st.hiddenSections, id]) },
      { label: 'Customize sidebar…', icon: <SlidersHorizontal size={15} />, run: () => p.openSettings('sidebar') },
    ] });
  };
  const section = (id: SectionId, title: string, icon: ReactNode, body: ReactNode, extra?: ReactNode) => (
    <motion.section className="side-group" key={id} layout transition={snap}>
      <div className="side-head-row" onContextMenu={(e) => headMenu(id, e)}>
        <button className="side-head" aria-expanded={!!open[id]} onClick={() => toggle(id)}>
          {icon}<span>{title}</span>
          <motion.span className="chev" animate={{ rotate: open[id] ? 0 : -90 }} transition={snap}><ChevronDown size={15} /></motion.span>
        </button>
        {extra}
      </div>
      <AnimatePresence initial={false}>
        {open[id] && (
          <motion.div
            className="side-collapse"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: glide }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }}
          >
            <div className="side-panel">{body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
  const item = (key: string, label: string, icon: ReactNode, onClick: (e: React.MouseEvent) => void, opts: { active?: boolean; drop?: string; extra?: ReactNode; title?: string; onAux?: () => void } = {}) => (
    <button
      key={key}
      className={`side-item${opts.active ? ' active' : ''}`}
      data-drop={opts.drop}
      onClick={onClick}
      onAuxClick={(e) => e.button === 1 && opts.onAux?.()}
      title={opts.title}
      aria-current={opts.active ? 'page' : undefined}
    >
      {opts.active && <motion.span layoutId="side-pill" className="side-pill" transition={snap} />}
      {icon}<span className="side-label">{label}</span>{opts.extra}
    </button>
  );
  const folder = (path: string, label: string, icon: ReactNode, extra?: ReactNode) =>
    item(path, label, icon, (e) => p.navigate(path, e.ctrlKey), { active: path.toLowerCase() === p.current.toLowerCase(), drop: path === HOME ? undefined : path, extra, title: path, onAux: () => p.navigate(path, true) });

  const recentFiles = rec.slice(0, 6);

  const sections: Record<SectionId, ReactNode> = {
    pinned: pins.length > 0 && section('pinned', 'Pinned', <Pin size={16} />, pins.map((x) =>
      folder(x, baseName(x), <FolderIcon tone={toneFor(baseName(x), x, home)} color={colors[x.toLowerCase()]} size={16} />,
        <span className="side-x" role="button" tabIndex={0} aria-label={`Unpin ${baseName(x)}`} onClick={(e) => { e.stopPropagation(); pinned.set((ps) => ps.filter((y) => y !== x)); }}><PinOff size={13} /></span>),
    )),
    places: p.places && section('places', 'Places', <FolderIcon size={16} />, <>
      {p.places.quick.map((q) => folder(q.path, q.name, <FolderIcon tone={toneFor(q.name, q.path, home)} size={16} />))}
      {item('bin', 'Recycle Bin', <Trash2 size={16} />, (e) => p.navigate(BIN, e.ctrlKey), { drop: 'recycle', active: p.current === BIN, onAux: () => p.navigate(BIN, true) })}
    </>),
    cloud: p.places && p.places.cloud.length > 0 && section('cloud', 'Cloud', <Cloud size={16} />, p.places.cloud.map((c) => folder(c.path, c.name, <Cloud size={16} className="accent" />))),
    drives: p.places && section('drives', 'Drives', <HardDrive size={16} />, p.places.drives.map((d) =>
      folder(d.path, `${d.label} (${d.path.slice(0, 2)})`, <HardDrive size={16} />,
        d.total > 0 && (
          <span className="side-usage" title={`${fmtSize(d.free)} free of ${fmtSize(d.total)}`}>
            <motion.span initial={{ width: 0 }} animate={{ width: `${(1 - d.free / d.total) * 100}%` }} transition={{ ...glide, delay: 0.15 }} />
          </span>
        )),
    )),
    recent: section('recent', 'Recent', <Clock size={16} />, recentFiles.length ? <>
      {recentFiles.map((f) => item(`r:${f}`, baseName(f), <FileVisual name={baseName(f)} path={f} mtime={0} size={16} grid={false} />, () => p.openFile(f), { title: f }))}
      {rec.length > recentFiles.length && item('r:all', 'Show all', <Clock size={16} />, p.openRecent, { active: p.current === 'v:recent' })}
    </> : <span className="side-empty muted small">Files you open show up here</span>),
    tags: section('tags', 'Tags', <Tag size={16} />, tagList.map((t) =>
      item(`t:${t.id}`, t.name, <span className="tag-dot big" style={{ background: t.color }} />, () => p.openTag(t.id), { active: p.current === `v:tag:${t.id}` }),
    )),
    workspaces: section('workspaces', 'Workspaces', <Briefcase size={16} />, <>
      {spaces.map((w) => item(`w:${w.name}`, w.name, <Briefcase size={16} />, () => p.openWorkspace(w), {
        title: `${w.panes.flat().length} tabs`,
        extra: <span className="side-x" role="button" tabIndex={0} aria-label={`Delete workspace ${w.name}`} onClick={(e) => { e.stopPropagation(); workspaces.set((ws) => ws.filter((x) => x !== w)); }}><X size={13} /></span>,
      }))}
      {naming !== null ? (
        <form className="side-name" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) p.saveWorkspace(naming.trim()); setNaming(null); }}>
          <input autoFocus value={naming} placeholder="Workspace name" aria-label="Workspace name" onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
        </form>
      ) : item('w:+', 'Save current tabs', <Plus size={16} />, () => setNaming(''))}
    </>),
    collections: section('collections', 'Collections', <Library size={16} />, <CollectionsList current={p.current} navigate={p.navigate} />),
    folders: p.places && section('folders', 'Folders', <FolderTreeIcon size={16} />, <FolderTree drives={p.places.drives} current={p.current} navigate={p.navigate} />),
    remote: section('remote', 'Remote', <Server size={16} />, <>
      {conns.map((c) => item(`rm:${c.id}`, c.name, <Server size={16} />, (e) => p.navigate(remoteHome(c), e.ctrlKey), {
        active: p.current.startsWith(remoteRoot(remoteHome(c))), drop: remoteHome(c), title: `${c.protocol.toUpperCase()} · ${c.user ? `${c.user}@` : ''}${c.host}${c.path}`, onAux: () => p.navigate(remoteHome(c), true),
        extra: <span className="side-x" role="button" tabIndex={0} aria-label={`Edit ${c.name}`} onClick={(e) => { e.stopPropagation(); remoteEditor.set(c); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); remoteEditor.set(c); } }}><Pencil size={13} /></span>,
      }))}
      {item('rm:+', 'Add connection', <Plus size={16} />, () => remoteEditor.set('new'))}
    </>),
  };

  return (
    <nav className={`sidebar${p.compact ? ' compact' : ''}`} aria-label="Sidebar">
      <div className="side-panel top">
        {folder(HOME, 'Home', <House size={16} />)}
        {item('search', 'Search', <Search size={16} />, p.focusSearch, { extra: <kbd>Ctrl F</kbd> })}
        {item('palette', 'Command palette', <Command size={16} />, p.openPalette, { extra: <kbd>Ctrl K</kbd> })}
      </div>

      {st.sectionOrder.filter((id) => !st.hiddenSections.includes(id)).map((id) => sections[id])}

      <div className="side-foot">
        <button className="side-settings" onClick={() => p.openSettings()} aria-label="Settings (Ctrl+,)">
          <motion.span whileHover={{ rotate: 60 }} transition={snap} className="gear"><SettingsIcon size={17} /></motion.span>
          <span>Settings</span>
          <kbd>Ctrl ,</kbd>
        </button>
      </div>
      <AnimatePresence>{menu && <ContextMenu key="m" {...menu} onClose={() => setMenu(null)} />}</AnimatePresence>
    </nav>
  );
}
