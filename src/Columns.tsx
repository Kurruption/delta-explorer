// Miller columns (macOS Finder-style): one column per folder from the drive down to the open folder,
// plus an info column for a selected file. The open folder is the tab's location, so Back/Up/breadcrumbs just work.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, ExternalLink, FileText, FolderOpen } from 'lucide-react';
import {
  baseName, displayName, fmtDate, fmtSize, HOME, joinPath, kindOf, listDir, META_FILE, normPath, openPath, parentPath, VIEWABLE, type Entry, type SortKey,
} from './api';
import type { ListActions } from './FileList';
import { FileVisual, FolderIcon, toneFor } from './icons';
import { addRecent, folderColors, metaDialog, settings } from './store';
import { GitBadge, gitOf, useGit } from './git';

const ROW = 26;
const COL_W = 236;
/** Columns hold at most this many items (each loads in pages of 1000). */
const MAX = 20_000;

interface Props {
  id: string;
  path: string;
  home: string;
  sort: SortKey;
  desc: boolean;
  reloadKey: number;
  actions: ListActions;
  onInfo: (i: { total: number; selected: number; selectedSize: number; path: string; loaded: boolean }) => void;
}

export function Columns({ id, path, home, sort, desc, reloadKey, actions, onInfo }: Props) {
  const st = settings.use();
  const colors = folderColors.use();
  // Drive root ... open folder.
  const chain = useMemo(() => {
    const c: string[] = [];
    for (let p = path; p !== HOME && c.length < 64; ) { c.unshift(p); const q = parentPath(p); if (q === p) break; p = q; }
    return c;
  }, [path]);
  const last = chain.length - 1;
  const [data, setData] = useState<Record<string, Entry[]>>({});
  const [file, setFile] = useState<string | null>(null);
  const [fcol, setFcol] = useState(last);
  const box = useRef<HTMLDivElement>(null);
  const opts = { sort, desc, showHidden: st.showHidden };
  const key = (d: string) => normPath(d);

  const load = async (dir: string, refresh = false) => {
    try {
      const first = await listDir(dir, 0, 1000, { ...opts, refresh });
      let all = first.entries;
      while (all.length < Math.min(first.total, MAX)) all = all.concat((await listDir(dir, all.length, 1000, opts)).entries);
      setData((d) => ({ ...d, [key(dir)]: all }));
    } catch (e) {
      setData((d) => ({ ...d, [key(dir)]: [] }));
      if (dir === path) actions.error(e);
    }
  };
  // Load columns that aren't loaded yet; sort/hidden/reload changes reload everything.
  const loadedFor = useRef('');
  useEffect(() => {
    const sig = `${sort}|${desc}|${st.showHidden}|${reloadKey}`;
    const all = sig !== loadedFor.current;
    loadedFor.current = sig;
    if (all) setData({});
    for (const d of chain) if (all || !data[key(d)]) load(d, all);
  }, [chain, sort, desc, st.showHidden, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Watcher: refresh the columns whose folders changed.
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const un = listen<string[]>('fs-changed', ({ payload }) => chainRef.current.filter((d) => payload.includes(key(d))).forEach((d) => loadRef.current(d, true)));
    return () => { un.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A file is only selected while its folder is the open one.
  const fileSel = file && key(parentPath(file)) === key(path) ? file : null;
  useEffect(() => { setFcol((f) => Math.min(f, last)); }, [last]);
  const entries = data[key(path)];
  useEffect(() => { onInfo({ total: entries?.length ?? 0, selected: fileSel ? 1 : 0, selectedSize: 0, path, loaded: !!entries }); }, [entries, fileSel, path]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Index of the highlighted item in column i. */
  const selIn = (i: number) => {
    const list = data[key(chain[i])] ?? [];
    const want = i < last ? baseName(chain[i + 1]) : fileSel ? baseName(fileSel) : null;
    return want === null ? -1 : list.findIndex((e) => e.name.toLowerCase() === want.toLowerCase());
  };
  const pick = (i: number, e: Entry) => {
    const p = joinPath(chain[i], e.name);
    setFcol(i);
    if (e.isDir) { setFile(null); if (key(p) !== key(path)) actions.navigate(p); }
    else { setFile(p); if (i !== last) actions.navigate(chain[i]); }
  };
  const open = (p: string, isDir: boolean, newTab = false) => {
    if (isDir) return actions.navigate(p, newTab);
    addRecent(p);
    if (st.photosInViewer && VIEWABLE.test(p)) actions.view(p);
    else openPath(p).catch(actions.error);
  };

  const onKey = (k: React.KeyboardEvent) => {
    const list = data[key(chain[fcol])] ?? [];
    const cur = selIn(fcol);
    const move = (i: number) => { if (list.length) pick(fcol, list[Math.max(0, Math.min(list.length - 1, i))]); };
    const right = () => {
      const next = fcol < last ? data[key(chain[fcol + 1])] : undefined;
      if (next?.length) { setFcol(fcol + 1); pick(fcol + 1, next[0]); }
    };
    if (k.key === 'ArrowDown') move(cur + 1);
    else if (k.key === 'ArrowUp') move(cur < 0 ? 0 : cur - 1);
    else if (k.key === 'Home') move(0);
    else if (k.key === 'End') move(list.length - 1);
    else if (k.key === 'PageDown') move(cur + 15);
    else if (k.key === 'PageUp') move(cur - 15);
    else if (k.key === 'ArrowRight') right();
    else if (k.key === 'ArrowLeft') { if (fcol > 0) { setFile(null); setFcol(fcol - 1); actions.navigate(chain[fcol]); } }
    else if (k.key === 'Enter' && cur >= 0) { const e = list[cur]; if (e.isDir && !(k.ctrlKey || k.metaKey)) right(); else open(joinPath(chain[fcol], e.name), e.isDir, true); }
    else return;
    k.preventDefault();
    k.stopPropagation();
  };

  // Horizontal scroll follows the active column (and keeps the column it opened in view).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const cols = chain.length + (fileSel ? 1 : 0);
    const right = Math.min(cols, fcol + 2) * COL_W;
    if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: 'smooth' });
    else if (fcol * COL_W < el.scrollLeft) el.scrollTo({ left: fcol * COL_W, behavior: 'smooth' });
  }, [fcol, chain.length, fileSel]);

  const sel = fileSel ? (data[key(path)] ?? []).find((e) => joinPath(path, e.name) === fileSel) : undefined;
  return (
    <div className="miller" ref={box} tabIndex={0} onKeyDown={onKey} role="tree" aria-label={`Columns: ${baseName(path)}`}>
      {chain.map((dir, i) => (
        <Column key={key(dir)} id={`${id}-c${i}`} dir={dir} home={home} entries={data[key(dir)]} sel={selIn(i)} active={i === fcol} colors={colors}
          showExt={st.showExtensions}
          onPick={(e) => { box.current?.focus(); pick(i, e); }}
          onOpen={(e) => open(joinPath(dir, e.name), e.isDir, e.isDir)}
          onDrag={(e, x, y) => actions.beginDrag([joinPath(dir, e.name)], dir, x, y)} />
      ))}
      {sel && fileSel && (
        <aside className="miller-info" aria-label="File info">
          <div className="miller-thumb"><FileVisual name={sel.name} path={fileSel} mtime={sel.modified} size={150} grid /></div>
          <strong className="miller-name">{displayName(sel.name, false, st.showExtensions)}</strong>
          <dl>
            <dt>Type</dt><dd>{kindOf(sel)}</dd>
            <dt>Size</dt><dd>{fmtSize(sel.size)}</dd>
            <dt>Modified</dt><dd>{fmtDate(sel.modified)}</dd>
          </dl>
          <div className="miller-actions">
            <button className="btn small" onClick={() => open(fileSel, false)}><ExternalLink size={14} />Open</button>
            {META_FILE.test(sel.name) && <button className="btn small" onClick={() => metaDialog.set(fileSel)}><FileText size={14} />Metadata</button>}
          </div>
        </aside>
      )}
    </div>
  );
}

function Column({ id, dir, home, entries, sel, active, colors, showExt, onPick, onOpen, onDrag }: {
  id: string; dir: string; home: string; entries?: Entry[]; sel: number; active: boolean; colors: Record<string, string>; showExt: boolean;
  onPick: (e: Entry) => void; onOpen: (e: Entry) => void; onDrag: (e: Entry, x: number, y: number) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, h: 600 });
  const git = useGit(dir);
  const press = useRef<{ x: number; y: number; e: Entry } | null>(null);
  useEffect(() => {
    const c = el.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setVp((v) => ({ ...v, h: c.clientHeight })));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  // Keep the highlighted row in view (keyboard moves, and ancestors on first show).
  useLayoutEffect(() => {
    const c = el.current;
    if (!c || sel < 0) return;
    const top = sel * ROW;
    if (top < c.scrollTop) c.scrollTop = top;
    else if (top + ROW > c.scrollTop + c.clientHeight) c.scrollTop = top + ROW - c.clientHeight;
  }, [sel, entries]);
  const list = entries ?? [];
  const from = Math.max(0, Math.floor(vp.top / ROW) - 5);
  const to = Math.min(list.length, Math.ceil((vp.top + vp.h) / ROW) + 5);
  const rows = [];
  for (let i = from; i < to; i++) {
    const e = list[i];
    const p = joinPath(dir, e.name);
    const g = gitOf(git, e.name);
    rows.push(
      <div key={e.name} id={`${id}-r${i}`} role="treeitem" aria-selected={i === sel} aria-expanded={e.isDir ? i === sel : undefined}
        className={`miller-row${i === sel ? ' sel' : ''}${e.hidden || g === 'ignored' ? ' dim' : ''}`} style={{ top: i * ROW }}
        data-drop={e.isDir ? p : undefined} title={e.name}
        onMouseDown={(m) => { if (m.button === 0) { press.current = { x: m.clientX, y: m.clientY, e }; onPick(e); } }}
        onMouseMove={(m) => { const pr = press.current; if (pr && m.buttons & 1 && Math.hypot(m.clientX - pr.x, m.clientY - pr.y) > 5) { press.current = null; onDrag(pr.e, m.clientX, m.clientY); } }}
        onMouseUp={() => { press.current = null; }}
        onDoubleClick={() => !e.isDir && onOpen(e)}
        onAuxClick={(m) => m.button === 1 && e.isDir && onOpen(e)}>
        {e.isDir ? <FolderIcon tone={toneFor(e.name, p, home)} color={colors[p.toLowerCase()]} size={16} /> : <FileVisual name={e.name} path={p} mtime={e.modified} size={16} grid={false} />}
        <span className="label">{displayName(e.name, e.isDir, showExt)}</span>
        <GitBadge s={g} />
        {e.isDir && <ChevronRight size={13} className="muted miller-chev" aria-hidden />}
      </div>,
    );
  }
  return (
    <div className={`miller-col${active ? ' active' : ''}`} ref={el} data-drop={dir} role="group" aria-label={baseName(dir)}
      onScroll={(e) => { const top = e.currentTarget.scrollTop; setVp((v) => ({ ...v, top })); }}>
      <div style={{ height: list.length * ROW + 8, position: 'relative' }}>{rows}</div>
      {entries && !list.length && <div className="miller-empty muted small"><FolderOpen size={14} /> Empty</div>}
    </div>
  );
}
