// Tool dialogs: Checksums, Duplicate finder, Storage analyser, Compress options, Extract to folder.
// Rust does the work (src-tauri/src/tools.rs); these only display progress and results.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, Copy, ExternalLink, FolderOpen, FolderSearch, Trash2, X } from 'lucide-react';
import {
  baseName, checksums, findDupes, fmtDate, fmtSize, newToolId, openPath, parentPath, recycle, restore, startArchiveJob, startExtractJob, storageScan, storageView,
  toolCancel, type ArchiveFormat, type DupGroup, type StorageNode, type StorageSummary, type Sums, type ToolProgress,
} from './api';
import { Segmented } from './Settings';
import { CleanerDialog } from './Cleaner';
import { squarify } from './treemap';
import { errorToast, openTool, settings, tool, toast, undoable, type ToolKind } from './store';

const LEVELS = { fast: 1, balanced: 6, smallest: 9 } as const;

/** Mounted once in App: shows whichever tool dialog is open. */
export function ToolHost({ navigate }: { navigate: (p: string) => void }) {
  const t = tool.use();
  const close = () => tool.set(null);
  return (
    <AnimatePresence>
      {t && (
        <motion.div key={t.kind + t.paths.join('|')} className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <motion.div className={`modal tool tool-${t.kind}`} role="dialog" aria-modal aria-labelledby="tool-title"
            initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
            <Body kind={t.kind} paths={t.paths} close={close} navigate={(p) => { close(); navigate(p); }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Body({ kind, paths, close, navigate }: { kind: ToolKind; paths: string[]; close: () => void; navigate: (p: string) => void }) {
  if (kind === 'checksums') return <ChecksumsDialog path={paths[0]} close={close} />;
  if (kind === 'dupes') return <DupesDialog root={paths[0]} close={close} navigate={navigate} />;
  if (kind === 'storage') return <StorageDialog root={paths[0]} close={close} navigate={navigate} />;
  if (kind === 'compress') return <CompressDialog paths={paths} close={close} />;
  if (kind === 'cleaner') return <CleanerDialog close={close} />;
  return <ExtractToDialog paths={paths} close={close} />;
}

function Head({ title, sub, close }: { title: string; sub?: string; close: () => void }) {
  return (
    <header className="tool-head">
      <div><h3 id="tool-title">{title}</h3>{sub && <span className="muted small tool-sub" title={sub}>{sub}</span>}</div>
      <button className="icon-btn" aria-label="Close" onClick={close}><X size={16} /></button>
    </header>
  );
}

/** Runs a cancellable Rust scan; cancels it if the dialog closes first. */
function useScan<T>(run: (id: number) => Promise<T>) {
  const [res, setRes] = useState<{ data?: T; error?: string }>({});
  const [prog, setProg] = useState<ToolProgress | null>(null);
  const id = useMemo(newToolId, []);
  useEffect(() => {
    let live = true;
    const un = listen<ToolProgress>('tool-progress', ({ payload }) => payload.id === id && setProg(payload));
    run(id).then((data) => live && setRes({ data }), (e) => live && setRes({ error: String(e) }));
    return () => { live = false; toolCancel(id).catch(() => {}); un.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...res, prog, id, running: res.data === undefined && res.error === undefined };
}

function Working({ label, prog, unit }: { label: string; prog: ToolProgress | null; unit: string }) {
  return (
    <div className="tool-working" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <div>
        <strong>{label}</strong>
        <span className="muted small tool-current">{prog ? `${fmtSize(prog.done)} ${unit} · ${prog.current}` : 'Starting…'}</span>
      </div>
    </div>
  );
}

// ---------------- checksums ----------------
function ChecksumsDialog({ path, close }: { path: string; close: () => void }) {
  const s = useScan<Sums>((id) => checksums(id, path));
  const [cmp, setCmp] = useState('');
  const want = cmp.trim().toLowerCase().replace(/\s+/g, '');
  const hit = s.data && want ? (Object.entries(s.data) as [string, string][]).find(([, v]) => v === want)?.[0] : undefined;
  return (
    <>
      <Head title="Checksums" sub={path} close={close} />
      <div className="tool-body">
        {s.running && <Working label="Reading the file…" prog={s.prog} unit="read" />}
        {s.error && <p className="tool-error" role="alert">{s.error}</p>}
        {s.data && (
          <dl className="sums">
            {(['md5', 'sha1', 'sha256'] as const).map((k) => (
              <div key={k} className={hit === k ? 'match' : ''}>
                <dt>{{ md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256' }[k]}</dt>
                <dd><code>{s.data![k]}</code></dd>
                <button className="icon-btn small" aria-label={`Copy ${k}`} title="Copy" onClick={() => navigator.clipboard.writeText(s.data![k]).then(() => toast('Copied'), errorToast)}><Copy size={14} /></button>
              </div>
            ))}
          </dl>
        )}
        <label className="tool-field">
          <span>Compare with…</span>
          <input value={cmp} onChange={(e) => setCmp(e.target.value)} placeholder="Paste a checksum from the download page" spellCheck={false} disabled={!s.data} />
        </label>
        {s.data && want && (
          <p className={`verdict ${hit ? 'ok' : 'bad'}`} role="status">
            {hit ? <><Check size={15} /> Match ({{ md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256' }[hit]})</> : <><X size={15} /> Mismatch: this file is different</>}
          </p>
        )}
      </div>
    </>
  );
}

// ---------------- duplicates ----------------
function DupesDialog({ root, close, navigate }: { root: string; close: () => void; navigate: (p: string) => void }) {
  const s = useScan<DupGroup[]>((id) => findDupes(id, root));
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { if (s.data) setGroups(s.data); }, [s.data]);
  const list = groups ?? [];
  const wasted = list.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
  const selSize = list.reduce((a, g) => a + g.size * g.files.filter((f) => sel.has(f.path)).length, 0);
  const extras = (newest: boolean) => {
    const n = new Set<string>();
    for (const g of list) {
      const keep = g.files.reduce((k, f) => ((newest ? f.modified > k.modified : f.modified < k.modified) ? f : k), g.files[0]);
      for (const f of g.files) if (f !== keep) n.add(f.path);
    }
    setSel(n);
  };
  const toggle = (p: string) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const allGone = list.some((g) => g.files.every((f) => sel.has(f.path)));
  const recycleSel = () => {
    const p = [...sel];
    recycle(p).then(() => {
      setGroups(list.map((g) => ({ ...g, files: g.files.filter((f) => !sel.has(f.path)) })).filter((g) => g.files.length > 1));
      setSel(new Set());
      undoable({ label: `Delete ${p.length} duplicates`, run: () => restore(p) }, `Moved ${p.length} duplicates to the Recycle Bin`);
    }, errorToast);
  };
  return (
    <>
      <Head title="Duplicate files" sub={root} close={close} />
      <div className="tool-body">
        {s.running && <Working label="Looking for duplicates…" prog={s.prog} unit="compared" />}
        {s.error && <p className="tool-error" role="alert">{s.error}</p>}
        {groups && (list.length === 0 ? <p className="muted">No duplicate files here.</p> : (
          <>
            <div className="tool-bar">
              <span><strong>{list.length}</strong> groups · <strong>{fmtSize(wasted)}</strong> wasted</span>
              <span className="grow" />
              <button className="btn small" onClick={() => extras(true)}>Keep newest</button>
              <button className="btn small" onClick={() => extras(false)}>Keep oldest</button>
              <button className="btn small" disabled={!sel.size} onClick={() => setSel(new Set())}>Clear</button>
            </div>
            <div className="dupe-list">
              {list.map((g, i) => (
                <details key={g.files[0].path} open={i < 3}>
                  <summary>{baseName(g.files[0].path)} <span className="muted small">{g.files.length} copies · {fmtSize(g.size)} each</span></summary>
                  {g.files.map((f) => (
                    <label key={f.path} className="dupe-file">
                      <input type="checkbox" checked={sel.has(f.path)} onChange={() => toggle(f.path)} />
                      <span className="dupe-path" title={f.path}>{f.path}</span>
                      <span className="muted small">{fmtDate(f.modified)}</span>
                      <button className="icon-btn small" aria-label={`Show ${baseName(f.path)} in its folder`} title="Show in folder" onClick={(e) => { e.preventDefault(); navigate(parentPath(f.path)); }}><FolderSearch size={14} /></button>
                    </label>
                  ))}
                </details>
              ))}
            </div>
            <footer className="tool-foot">
              {allGone && <span className="tool-error small">Keep at least one copy in every group.</span>}
              <span className="grow" />
              <button className="btn danger-solid" disabled={!sel.size || allGone} onClick={recycleSel}><Trash2 size={14} /> Move {sel.size || ''} to Recycle Bin{sel.size ? ` (${fmtSize(selSize)})` : ''}</button>
            </footer>
          </>
        ))}
      </div>
    </>
  );
}

// ---------------- storage ----------------
const TYPE_COLORS: [RegExp, string][] = [
  [/^(png|jpe?g|gif|webp|bmp|svg|ico|heic|avif|tiff?|raw|cr2|nef|dng|psd)$/, '#4C86F0'],
  [/^(mp4|mkv|mov|avi|webm|wmv|m4v)$/, '#9150E8'],
  [/^(mp3|wav|flac|ogg|m4a|aac|opus)$/, '#D94B95'],
  [/^(zip|7z|rar|tar|gz|tgz|xz|bz2|iso|cab|pck|pak)$/, '#C98A2E'],
  [/^(exe|msi|dll|sys|appx|msix)$/, '#22B39B'],
  [/^(pdf|docx?|odt|rtf|txt|md|xlsx?|csv|pptx?)$/, '#7472B8'],
  [/^(rs|ts|tsx|js|json|py|c|cpp|h|cs|go|java|html|css)$/, '#6D63E8'],
];
const extOf = (n: string) => (n.includes('.') ? n.split('.').pop()!.toLowerCase() : '');
const colorFor = (n: StorageNode) => (n.isDir ? 'var(--accent)' : !n.path ? 'var(--surface-3)' : TYPE_COLORS.find(([re]) => re.test(extOf(n.name)))?.[1] ?? '#7C7F8A');

function StorageDialog({ root, close, navigate }: { root: string; close: () => void; navigate: (p: string) => void }) {
  const s = useScan<StorageSummary>((id) => storageScan(id, root));
  const [tab, setTab] = useState<'map' | 'folders' | 'files' | 'types' | 'empty'>('map');
  const [gone, setGone] = useState<Set<string>>(new Set());
  const del = (p: string) => recycle([p]).then(() => { setGone((g) => new Set(g).add(p)); undoable({ label: `Delete “${baseName(p)}”`, run: () => restore([p]) }, `Moved “${baseName(p)}” to the Recycle Bin`); }, errorToast);
  const actions = (n: { path: string; isDir: boolean }) => (
    <span className="row-actions">
      <button className="icon-btn small" title="Open" aria-label={`Open ${baseName(n.path)}`} onClick={() => (n.isDir ? navigate(n.path) : openPath(n.path).catch(errorToast))}>{n.isDir ? <FolderOpen size={14} /> : <ExternalLink size={14} />}</button>
      <button className="icon-btn small" title="Show in folder" aria-label={`Show ${baseName(n.path)} in its folder`} onClick={() => navigate(parentPath(n.path))}><FolderSearch size={14} /></button>
      <button className="icon-btn small danger" title="Move to Recycle Bin" aria-label={`Move ${baseName(n.path)} to the Recycle Bin`} onClick={() => del(n.path)}><Trash2 size={14} /></button>
    </span>
  );
  const d = s.data;
  return (
    <>
      <Head title="Storage" sub={root} close={close} />
      <div className="tool-body">
        {s.running && <Working label="Measuring every folder…" prog={s.prog} unit="counted" />}
        {s.error && <p className="tool-error" role="alert">{s.error}</p>}
        {d && (
          <>
            <div className="tool-bar">
              <span><strong>{fmtSize(d.total)}</strong> in {d.files.toLocaleString()} files, {d.folders.toLocaleString()} folders{d.skipped ? ` · ${d.skipped} folders couldn’t be read` : ''}</span>
              <span className="grow" />
              <button className="btn small" onClick={() => openTool('cleaner', [])}>Clean up…</button>
              <Segmented id="stab" value={tab} onChange={setTab} options={[{ v: 'map', label: 'Map' }, { v: 'folders', label: 'Folders' }, { v: 'files', label: 'Files' }, { v: 'types', label: 'Types' }, { v: 'empty', label: `Empty (${d.empty.length})` }]} />
            </div>
            {tab === 'map' && <Treemap id={s.id} root={d.root} actions={actions} gone={gone} />}
            {(tab === 'folders' || tab === 'files') && (
              <ul className="size-list">
                {(tab === 'folders' ? d.largestFolders : d.largestFiles).filter((n) => !gone.has(n.path)).map((n) => (
                  <li key={n.path}>
                    <span className="size-bar" style={{ width: `${(n.size / Math.max(1, d.total)) * 100}%`, background: colorFor(n) }} aria-hidden />
                    <span className="size-name" title={n.path}>{n.path}</span>
                    <span className="num muted">{fmtSize(n.size)}</span>
                    {actions(n)}
                  </li>
                ))}
              </ul>
            )}
            {tab === 'types' && (
              <ul className="size-list">
                {d.types.slice(0, 60).map((t) => (
                  <li key={t.ext}>
                    <span className="size-bar" style={{ width: `${(t.size / Math.max(1, d.total)) * 100}%`, background: colorFor({ name: `x.${t.ext}`, path: 'x', size: 0, isDir: false, count: 0 }) }} aria-hidden />
                    <span className="size-name">{t.ext ? `.${t.ext}` : 'No extension'} <span className="muted small">{t.count.toLocaleString()} files</span></span>
                    <span className="num muted">{fmtSize(t.size)}</span>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'empty' && (d.empty.length ? (
              <ul className="size-list">
                {d.empty.filter((p) => !gone.has(p)).map((p) => <li key={p}><span className="size-name" title={p}>{p}</span>{actions({ path: p, isDir: true })}</li>)}
              </ul>
            ) : <p className="muted">No empty folders.</p>)}
          </>
        )}
      </div>
    </>
  );
}

/** Squarified treemap of one folder; click a folder to zoom in, the breadcrumb zooms out. */
function Treemap({ id, root, actions, gone }: { id: number; root: string; actions: (n: StorageNode) => ReactNode; gone: Set<string> }) {
  const [dir, setDir] = useState(root);
  const [nodes, setNodes] = useState<StorageNode[]>([]);
  const [picked, setPicked] = useState<StorageNode | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setPicked(null); storageView(id, dir).then(setNodes, errorToast); }, [id, dir]);
  const tiles = squarify(nodes.filter((n) => !gone.has(n.path)), { x: 0, y: 0, w: size.w, h: size.h });
  const rel = dir.slice(root.length).split('\\').filter(Boolean);
  const crumbs = [{ name: baseName(root) || root, path: root }, ...rel.map((n, i) => ({ name: n, path: root.replace(/\\$/, '') + '\\' + rel.slice(0, i + 1).join('\\') }))];
  return (
    <div className="treemap-wrap">
      <nav className="tm-crumbs" aria-label="Treemap location">
        {crumbs.map((c, i) => (
          <span key={c.path}>{i > 0 && <ChevronRight size={12} className="muted" aria-hidden />}<button className={`crumb${i === crumbs.length - 1 ? ' current' : ''}`} onClick={() => setDir(c.path)}>{c.name}</button></span>
        ))}
      </nav>
      <div className="treemap" ref={box} role="list" aria-label={`What takes space in ${baseName(dir)}`}>
        {tiles.map((t) => (
          <button key={t.item.path || 'rest'} role="listitem" className={`tm-tile${picked === t.item ? ' picked' : ''}`}
            style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: colorFor(t.item) }}
            title={`${t.item.name}\n${fmtSize(t.item.size)}`}
            aria-label={`${t.item.name}, ${fmtSize(t.item.size)}${t.item.isDir ? ', folder' : ''}`}
            onClick={() => (t.item.isDir ? setDir(t.item.path) : t.item.path && setPicked(t.item))}>
            {t.w > 60 && t.h > 28 && <span>{t.item.name}<small>{fmtSize(t.item.size)}</small></span>}
          </button>
        ))}
      </div>
      <div className="tm-picked muted small">
        {picked ? <><span className="size-name">{picked.path} · {fmtSize(picked.size)}</span>{actions(picked)}</> : 'Click a folder to zoom in, a file to act on it.'}
      </div>
    </div>
  );
}

// ---------------- compress / extract to ----------------
function CompressDialog({ paths, close }: { paths: string[]; close: () => void }) {
  const st = settings.use();
  const [format, setFormat] = useState<ArchiveFormat>('zip');
  const [level, setLevel] = useState<keyof typeof LEVELS>(st.compression);
  const [pw, setPw] = useState('');
  const go = () => { startArchiveJob(paths, format, LEVELS[level], format === 'tarGz' ? undefined : pw).then(close, errorToast); };
  return (
    <>
      <Head title={`Compress ${paths.length > 1 ? `${paths.length} folders` : `“${baseName(paths[0])}”`}`} close={close} />
      <form className="tool-body tool-form" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <div className="tool-field"><span>Format</span><Segmented id="cfmt" value={format} onChange={setFormat} options={[{ v: 'zip', label: 'ZIP' }, { v: 'sevenZ', label: '7z' }, { v: 'tarGz', label: 'tar.gz' }]} /></div>
        <div className="tool-field"><span>Compression</span><Segmented id="clvl" value={level} onChange={setLevel} options={[{ v: 'fast', label: 'Fast' }, { v: 'balanced', label: 'Balanced' }, { v: 'smallest', label: 'Smallest' }]} /></div>
        {format !== 'tarGz' && (
          <label className="tool-field"><span>Password (optional)</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="AES-256 encryption" /></label>
        )}
        <p className="muted small">{format === 'zip' ? 'ZIP opens everywhere and uses all your CPU cores.' : format === 'sevenZ' ? '7z makes smaller files but takes longer.' : 'tar.gz is the usual choice for Linux and macOS.'} Photos, videos and other already-compressed files are stored as is.</p>
        <footer className="tool-foot"><span className="grow" /><button type="button" className="btn" onClick={close}>Cancel</button><button className="btn primary" autoFocus>Compress</button></footer>
      </form>
    </>
  );
}

function ExtractToDialog({ paths, close }: { paths: string[]; close: () => void }) {
  const [dest, setDest] = useState(parentPath(paths[0]));
  return (
    <>
      <Head title="Extract to folder" sub={paths.length > 1 ? `${paths.length} archives` : paths[0]} close={close} />
      <form className="tool-body tool-form" onSubmit={(e) => { e.preventDefault(); startExtractJob(paths, 'to', dest.trim().replace(/^"|"$/g, '')).then(close, errorToast); }}>
        <label className="tool-field"><span>Folder</span><input value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} autoFocus onFocus={(e) => e.currentTarget.select()} /></label>
        <p className="muted small">A new folder named after the archive is made inside it, so nothing there is overwritten.</p>
        <footer className="tool-foot"><span className="grow" /><button type="button" className="btn" onClick={close}>Cancel</button><button className="btn primary">Extract</button></footer>
      </form>
    </>
  );
}
