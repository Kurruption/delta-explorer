// Details view: columns (choose / reorder / resize / sort), media columns, folder sizes, hover cards, view options.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Bookmark, Calculator, Columns3, Layers, MousePointer2, Save, Trash2, RotateCcw } from 'lucide-react';
import {
  baseName, cancelFolderSizes, countItems, fmtAgo, fmtDate, fmtSize, folderSizes as askFolderSizes, kindOf, mediaInfo,
  type DirSize, type Entry, type Media, type SortKey,
} from './api';
import type { MenuItem } from './ContextMenu';
import { groupLabel, type GroupBy } from './layout';
import { DEFAULT_COLUMNS, errorToast, memory, toast, type Col, type ColId, type ViewProfile } from './store';

export const COLS: Record<ColId, { label: string; sort?: SortKey; num?: boolean; w: number }> = {
  name: { label: 'Name', sort: 'name', w: 220 },
  modified: { label: 'Date modified', sort: 'modified', w: 150 },
  created: { label: 'Date created', sort: 'created', w: 150 },
  accessed: { label: 'Date accessed', sort: 'accessed', w: 150 },
  type: { label: 'Type', sort: 'kind', w: 130 },
  ext: { label: 'Extension', sort: 'kind', w: 80 },
  size: { label: 'Size', sort: 'size', num: true, w: 90 },
  attrs: { label: 'Attributes', sort: 'attrs', w: 80 },
  dims: { label: 'Dimensions', num: true, w: 100 },
  duration: { label: 'Length', num: true, w: 80 },
};
const GAP = 12, PAD = 44; // .row gap; row inset + padding on both sides
export const gridTemplate = (cols: Col[]) => cols.map((c) => (c.id === 'name' ? `minmax(${c.w}px, 1fr)` : `${c.w}px`)).join(' ');
export const colsWidth = (cols: Col[]) => cols.reduce((n, c) => n + c.w, 0) + GAP * (cols.length - 1) + PAD;
export const GROUPS: { v: GroupBy; label: string }[] = [
  { v: 'none', label: 'None' }, { v: 'type', label: 'Type' }, { v: 'modified', label: 'Date modified' }, { v: 'size', label: 'Size' }, { v: 'letter', label: 'First letter' },
];
export const labelOf = (by: GroupBy, key: string) => groupLabel(by, key, (x) => kindOf({ name: `x.${x}`, isDir: false } as Entry));

// ---------------- media columns (dimensions / length), filled for visible rows only ----------------
const MEDIA = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|ico|tiff?|heic|heif|mp4|m4v|mkv|mov|avi|wmv|webm|mpe?g|3gp|mts|m2ts|mp3|m4a|flac|wav|ogg|opus|wma|aac|aiff?)$/i;
export const isMedia = (name: string) => MEDIA.test(name);
const mediaCache = new Map<string, Media | null>(); // "path|mtime" -> info; null = asked, not back yet
/** Bumped when media info arrives so lists re-render. */
export const mediaVer = memory(0);
export const mediaOf = (path: string, mtime: number) => mediaCache.get(`${path}|${mtime}`) ?? null;
/** One IPC call for every item not asked yet (the caller passes a whole viewport). */
export function wantMedia(items: { path: string; mtime: number }[]) {
  const ask = items.filter((x) => !mediaCache.has(`${x.path}|${x.mtime}`)).slice(0, 500);
  if (!ask.length) return;
  if (mediaCache.size > 50_000) mediaCache.clear();
  for (const x of ask) mediaCache.set(`${x.path}|${x.mtime}`, null);
  mediaInfo(ask.map((x) => x.path)).then(
    (r) => { r.forEach((m, i) => mediaCache.set(`${ask[i].path}|${ask[i].mtime}`, m)); mediaVer.set((v) => v + 1); },
    () => ask.forEach((x) => mediaCache.delete(`${x.path}|${x.mtime}`)),
  );
}
const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const fmtDims = (m: Media | null) => (m?.width ? `${m.width} × ${m.height}` : '');

// ---------------- folder sizes (computed in Rust, arriving as events) ----------------
/** Lowercase path -> size, or 'busy' while it's being walked. */
export const dirSizes = memory<Record<string, DirSize | 'busy'>>({});
const pending = new Map<string, Set<string>>(); // request key (pane) -> paths asked
const announce = new Set<string>(); // "Calculate size" requests: toast the result
listen<DirSize & { path: string }>('folder-size', ({ payload: { path, ...size } }) => {
  const k = path.toLowerCase();
  for (const s of pending.values()) s.delete(k);
  dirSizes.set((m) => ({ ...m, [k]: size }));
  if (announce.delete(k)) toast(`“${baseName(path)}”: ${fmtSize(size.bytes)} · ${size.files.toLocaleString()} files, ${size.dirs.toLocaleString()} folders`);
}).catch(() => { /* not running in Tauri */ });

/** Walks folders in the background. `key` groups requests so a pane can cancel its own (stopSizing). */
export function sizeFolders(key: string, paths: string[], fresh = false) {
  const cur = dirSizes.get();
  const ask = fresh ? paths : paths.filter((p) => !(p.toLowerCase() in cur));
  if (!ask.length) return;
  const mine = pending.get(key) ?? new Set();
  pending.set(key, mine);
  dirSizes.set((m) => { const n = { ...m }; for (const p of ask) { n[p.toLowerCase()] = 'busy'; mine.add(p.toLowerCase()); } return n; });
  askFolderSizes(key, ask, fresh).catch(errorToast);
}
/** Context menu "Calculate size": not cancelled by navigating, and reports when done. */
export const calculateSize = (paths: string[]) => { paths.forEach((p) => announce.add(p.toLowerCase())); sizeFolders('manual', paths, true); };
export function stopSizing(key: string) {
  const mine = pending.get(key);
  pending.delete(key);
  cancelFolderSizes(key).catch(() => {});
  if (mine?.size) dirSizes.set((m) => { const n = { ...m }; for (const k of mine) if (n[k] === 'busy') delete n[k]; return n; });
}
/** Bytes of a file, or of a folder whose size is known. */
export const sizeOf = (e: Entry, path: string, sizes: Record<string, DirSize | 'busy'>) => {
  if (!e.isDir) return e.size;
  const s = sizes[path.toLowerCase()];
  return s && s !== 'busy' ? s.bytes : 0;
};

// ---------------- cells ----------------
const ATTRS: [number, string][] = [[0x1, 'R'], [0x2, 'H'], [0x4, 'S'], [0x20, 'A']];
export const attrText = (a: number) => ATTRS.filter(([b]) => a & b).map(([, c]) => c).join('');
const ext = (name: string) => (name.includes('.') && !name.startsWith('.') ? name.split('.').pop()!.toLowerCase() : '');
const date = (s: number) => <span className="muted" role="gridcell" title={fmtDate(s)}>{fmtAgo(s)}</span>;

/** One non-name cell of a Details row. `real` is the item's own name (not a full path). */
export function cell(id: ColId, e: Entry, real: string, path: string, sizes: Record<string, DirSize | 'busy'>): ReactNode {
  const text = (t: ReactNode, num = false, title?: string) => <span className={`muted${num ? ' num' : ''}`} role="gridcell" title={title}>{t}</span>;
  switch (id) {
    case 'modified': return date(e.modified);
    case 'created': return date(e.created);
    case 'accessed': return date(e.accessed);
    case 'type': return text(kindOf({ ...e, name: real }));
    case 'ext': return text(e.isDir ? '' : ext(real));
    case 'attrs': return text(attrText(e.attrs));
    case 'size': {
      if (!e.isDir) return text(fmtSize(e.size), true);
      const s = sizes[path.toLowerCase()];
      return text(s === 'busy' ? <span className="size-busy" aria-label="Calculating size">…</span> : s ? fmtSize(s.bytes) : '', true, s && s !== 'busy' ? `${s.files.toLocaleString()} files, ${s.dirs.toLocaleString()} folders` : undefined);
    }
    case 'dims': return text(e.isDir ? '' : fmtDims(mediaOf(path, e.modified)), true);
    case 'duration': { const m = mediaOf(path, e.modified); return text(m?.durationMs ? fmtDuration(m.durationMs) : '', true); }
    default: return text('');
  }
}

// ---------------- header: sort, Shift+sort, drag to reorder, drag edges to resize, right-click to choose ----------------
export function DetailsHeader({ cols, onLive, onCommit, sort, desc, then, onSort, openMenu }: {
  cols: Col[];
  /** Live widths while dragging an edge (null when done). */
  onLive: (c: Col[] | null) => void;
  onCommit: (c: Col[]) => void;
  sort: SortKey; desc: boolean; then: { key: SortKey; desc: boolean } | null;
  onSort: (k: SortKey, add: boolean) => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
}) {
  const [drag, setDrag] = useState<{ id: ColId; dx: number } | null>(null);
  const suppress = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const reorder = (id: ColId, to: number) => {
    const from = cols.findIndex((x) => x.id === id);
    const next = [...cols];
    const [c] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to > from ? to - 1 : to)), 0, c);
    onCommit(next);
  };
  const startMove = (m: React.MouseEvent, c: Col) => {
    if (m.button !== 0) return;
    const x0 = m.clientX;
    let moved = false;
    const cells = [...rowRef.current!.querySelectorAll<HTMLElement>('.col-h')].map((el) => el.getBoundingClientRect());
    const move = (e: MouseEvent) => {
      const dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < 5) return;
      moved = true;
      setDrag({ id: c.id, dx });
    };
    const up = (e: MouseEvent) => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      setDrag(null);
      if (!moved) return;
      suppress.current = true; // the click that follows the drop isn't a sort
      const to = cells.findIndex((r) => e.clientX < r.left + r.width / 2);
      reorder(c.id, to < 0 ? cols.length : to);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
  const resize = (id: ColId, w: number) => cols.map((x) => (x.id === id ? { ...x, w: Math.max(48, Math.round(w)) } : x));
  const startResize = (m: React.MouseEvent, c: Col) => {
    m.preventDefault(); m.stopPropagation();
    const x0 = m.clientX;
    let last = cols;
    const move = (e: MouseEvent) => { last = resize(c.id, c.w + e.clientX - x0); onLive(last); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); onLive(null); onCommit(last); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };

  // Right-click (or the menu key on a focused header): choose columns; on a header also move / size it from the keyboard.
  const menu = (m: React.MouseEvent, c?: Col) => {
    m.preventDefault(); m.stopPropagation();
    const i = c ? cols.indexOf(c) : -1;
    const own: MenuItem[] = c ? [
      { label: `Move “${COLS[c.id].label}” left`, disabled: i <= 0, run: () => reorder(c.id, i - 1) },
      { label: `Move “${COLS[c.id].label}” right`, disabled: i >= cols.length - 1, run: () => reorder(c.id, i + 2) },
      { label: 'Wider', run: () => onCommit(resize(c.id, c.w + 30)) },
      { label: 'Narrower', run: () => onCommit(resize(c.id, c.w - 30)) },
      'sep',
    ] : [];
    openMenu(m.clientX, m.clientY, [...own, ...columnItems(cols, onCommit)]);
  };

  return (
    <div ref={rowRef} className="row head dcols" role="row" style={{ minWidth: colsWidth(cols) }} onContextMenu={(m) => menu(m)}>
      {cols.map((c) => {
        const d = COLS[c.id];
        const on = !!d.sort && sort === d.sort;
        const two = !!d.sort && !on && then?.key === d.sort;
        return (
          <div key={c.id} className={`col-h${d.num ? ' num' : ''}${drag?.id === c.id ? ' dragging' : ''}`} style={drag?.id === c.id ? { translate: `${drag.dx}px 0` } : undefined}>
            <button
              className="col" role="columnheader" aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'} aria-disabled={!d.sort}
              title={d.sort ? `Sort by ${d.label.toLowerCase()} · Shift+click: then by this · drag to move` : 'Drag to move'}
              onMouseDown={(m) => startMove(m, c)}
              onContextMenu={(m) => menu(m, c)}
              onClick={(m) => { if (suppress.current) { suppress.current = false; return; } if (d.sort) onSort(d.sort, m.shiftKey); }}
            >
              <span className="label">{d.label}</span>
              {on && (desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
              {two && <span className="sort2" aria-label="second sort">{then!.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />}2</span>}
            </button>
            <span className="col-resize" onMouseDown={(m) => startResize(m, c)} onDoubleClick={() => onCommit(resize(c.id, COLS[c.id].w))} title="Drag to resize · double-click to reset" />
          </div>
        );
      })}
    </div>
  );
}

/** Checklist of every column, plus reset. */
export function columnItems(cols: Col[], set: (c: Col[]) => void): MenuItem[] {
  return [
    ...(Object.keys(COLS) as ColId[]).map((id) => ({
      label: COLS[id].label,
      checked: cols.some((c) => c.id === id),
      disabled: id === 'name',
      run: () => set(cols.some((c) => c.id === id) ? cols.filter((c) => c.id !== id) : [...cols, { id, w: COLS[id].w }]),
    })),
    'sep' as const,
    { label: 'Reset columns', icon: <RotateCcw size={15} />, run: () => set(DEFAULT_COLUMNS) },
  ];
}

/** Toolbar → View options: group by, columns, folder sizes, hover cards, view profiles. */
export function viewMenu(o: {
  groupBy: GroupBy; setGroup: (g: GroupBy) => void;
  cols: Col[]; setCols: (c: Col[]) => void;
  folderSizes: boolean; hoverCards: boolean; toggle: (k: 'folderSizes' | 'hoverCards') => void;
  profiles: ViewProfile[]; apply: (p: ViewProfile) => void; save: () => void; remove: (name: string) => void;
}): MenuItem[] {
  return [
    { label: `Group by: ${GROUPS.find((g) => g.v === o.groupBy)?.label}`, icon: <Layers size={15} />, sub: () => GROUPS.map((g) => ({ label: g.label, checked: o.groupBy === g.v, run: () => o.setGroup(g.v) })) },
    { label: 'Columns', icon: <Columns3 size={15} />, sub: () => columnItems(o.cols, o.setCols) },
    { label: 'Show folder sizes', icon: <Calculator size={15} />, checked: o.folderSizes, run: () => o.toggle('folderSizes') },
    { label: 'Hover info cards', icon: <MousePointer2 size={15} />, checked: o.hoverCards, run: () => o.toggle('hoverCards') },
    'sep',
    ...o.profiles.map((p) => ({ label: p.name, icon: <Bookmark size={15} />, run: () => o.apply(p) })),
    { label: 'Save view as profile…', icon: <Save size={15} />, run: o.save },
    ...(o.profiles.length ? [{ label: 'Delete profile', icon: <Trash2 size={15} />, sub: () => o.profiles.map((p) => ({ label: p.name, danger: true, run: () => o.remove(p.name) })) }] : []),
  ];
}

/** Small "name it" dialog (saving a view profile). */
export function NameDialog({ title, initial = '', onDone }: { title: string; initial?: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <motion.form className="modal confirm" role="dialog" aria-modal aria-label={title} initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDone(null); }}
        onSubmit={(e) => { e.preventDefault(); if (v.trim()) onDone(v.trim()); }}>
        <h3>{title}</h3>
        <input className="name-input" autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Name" placeholder="e.g. Photos, Downloads triage" maxLength={60} />
        <div className="confirm-buttons">
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>Save</button>
        </div>
      </motion.form>
    </motion.div>
  );
}

// ---------------- hover card ----------------
export function HoverCard({ e, path, x, y }: { e: Entry; path: string; x: number; y: number }) {
  mediaVer.use();
  const sizes = dirSizes.use();
  const [count, setCount] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 18 });
  useEffect(() => {
    if (e.isDir) countItems(path).then(setCount, () => {});
    else if (isMedia(e.name)) wantMedia([{ path, mtime: e.modified }]);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, x + 14 + r.width > innerWidth - 8 ? x - r.width - 10 : x + 14), top: Math.max(8, y + 18 + r.height > innerHeight - 8 ? y - r.height - 10 : y + 18) });
  }, [x, y]);
  const real = baseName(e.name);
  const m = mediaOf(path, e.modified);
  const ds = sizes[path.toLowerCase()];
  const rows: [string, ReactNode][] = [
    ['Type', kindOf({ ...e, name: real })],
    ...(!e.isDir ? [['Size', `${fmtSize(e.size)}${e.size >= 1024 ? ` (${e.size.toLocaleString()} bytes)` : ''}`] as [string, string]] : ds && ds !== 'busy' ? [['Size', fmtSize(ds.bytes)] as [string, string]] : []),
    ...(e.isDir ? [['Items', count === null ? '…' : count.toLocaleString()] as [string, string]] : []),
    ...(m?.width ? [['Dimensions', fmtDims(m)] as [string, string]] : []),
    ...(m?.durationMs ? [['Length', fmtDuration(m.durationMs)] as [string, string]] : []),
    ['Modified', fmtDate(e.modified)],
    ['Created', fmtDate(e.created)],
  ];
  return (
    <div ref={box} className="hover-card" role="tooltip" style={pos}>
      <div className="hc-name">{real}</div>
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}
