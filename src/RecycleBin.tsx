import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArchiveRestore, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import { binList, binPurge, binRestore, fmtAgo, fmtDate, fmtSize, type BinItem } from './api';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { FileVisual, FolderIcon } from './icons';
import { toast } from './store';
import { glide, snap } from './motion';

/** Delta's own Recycle Bin: restore or permanently delete, without leaving the app. */
export function RecycleBin({ onError }: { onError: (e: unknown) => void }) {
  const [items, setItems] = useState<BinItem[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[]; all: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => binList().then((l) => { setItems(l); setSel((s) => new Set([...s].filter((id) => l.some((i) => i.id === id)))); }, onError), [onError]);
  useEffect(() => {
    load();
    addEventListener('focus', load); // things deleted from other apps show up when you come back
    return () => removeEventListener('focus', load);
  }, [load]);

  const run = async (what: Promise<void>, done: string) => {
    setBusy(true);
    try { await what; toast(done); } catch (e) { onError(e); } finally { setBusy(false); load(); }
  };
  const restore = (ids: string[]) => ids.length && run(binRestore(ids), ids.length > 1 ? `Restored ${ids.length} items` : 'Restored');
  const purge = (ids: string[]) => setConfirm({ ids, all: items !== null && ids.length === items.length });

  const click = (i: number, e: React.MouseEvent) => {
    const id = items![i].id;
    if (e.shiftKey && anchor >= 0) {
      const s = new Set(e.ctrlKey ? sel : []);
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) s.add(items![k].id);
      setSel(s);
    } else if (e.ctrlKey) {
      const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s); setAnchor(i);
    } else { setSel(new Set([id])); setAnchor(i); }
  };

  const total = items?.reduce((n, i) => n + (i.size ?? 0), 0) ?? 0;
  const ids = [...sel];

  return (
    <div className="bin" onKeyDown={(k) => {
      if (k.key === 'Delete' && ids.length) purge(ids);
      else if (k.key === 'Enter' && ids.length) restore(ids);
      else if ((k.ctrlKey || k.metaKey) && k.key.toLowerCase() === 'a' && items) { k.preventDefault(); setSel(new Set(items.map((i) => i.id))); }
    }} tabIndex={0}>
      <div className="bin-bar">
        <Trash2 size={18} className="accent" />
        <div className="bin-title">
          <strong>Recycle Bin</strong>
          <span className="muted small">{items ? `${items.length} item${items.length === 1 ? '' : 's'} · ${fmtSize(total)}` : 'Loading…'}</span>
        </div>
        <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load}><RotateCw size={16} /></button>
        <button className="btn" disabled={busy || !ids.length} onClick={() => restore(ids)}><ArchiveRestore size={15} /> Restore{ids.length > 1 ? ` ${ids.length}` : ''}</button>
        <button className="btn" disabled={busy || !items?.length} onClick={() => restore(items!.map((i) => i.id))}>Restore all</button>
        <button className="btn danger" disabled={busy || !items?.length} onClick={() => purge(items!.map((i) => i.id))}><Trash2 size={15} /> Empty</button>
      </div>
      <div className="row head bin-row" role="row">
        <span className="col">Name</span><span className="col">Original location</span><span className="col">Deleted</span><span className="col num">Size</span>
      </div>
      <div className="bin-list" role="grid" aria-label="Recycle Bin" aria-multiselectable onMouseDown={(e) => e.target === e.currentTarget && setSel(new Set())}>
        <AnimatePresence initial={false}>
          {items?.map((it, i) => (
            <motion.div
              key={it.id}
              layout
              role="row"
              aria-selected={sel.has(it.id)}
              className={`row bin-row${sel.has(it.id) ? ' sel' : ''}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { ...glide, delay: Math.min(i, 20) * 0.012 } }}
              exit={{ opacity: 0, x: 30, height: 0, transition: { duration: 0.2 } }}
              onMouseDown={(e) => e.button === 0 && click(i, e)}
              onDoubleClick={() => restore([it.id])}
              onContextMenu={(e) => {
                e.preventDefault();
                const target = sel.has(it.id) ? ids : [it.id];
                if (!sel.has(it.id)) setSel(new Set([it.id]));
                setMenu({ x: e.clientX, y: e.clientY, items: [
                  { label: target.length > 1 ? `Restore ${target.length} items` : 'Restore', icon: <ArchiveRestore size={15} />, shortcut: 'Enter', run: () => restore(target) },
                  'sep',
                  { label: 'Delete permanently', icon: <Trash2 size={15} />, shortcut: 'Del', danger: true, run: () => purge(target) },
                ] });
              }}
              title={`${it.original}\\${it.name}`}
            >
              <span className="name" role="gridcell">
                {it.isDir ? <FolderIcon size={18} /> : <FileVisual name={it.name} path={it.id} mtime={0} size={18} grid={false} />}
                <span className="label">{it.name}</span>
              </span>
              <span className="muted label" role="gridcell">{it.original}</span>
              <span className="muted" role="gridcell" title={fmtDate(it.deleted)}>{fmtAgo(it.deleted)}</span>
              <span className="muted num" role="gridcell">{it.size === null ? '' : fmtSize(it.size)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {items?.length === 0 && (
          <motion.div className="empty bin-empty" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={glide}>
            <Trash2 size={42} strokeWidth={1.4} />
            <span>The Recycle Bin is empty</span>
          </motion.div>
        )}
      </div>

      <AnimatePresence>{menu && <ContextMenu key="m" {...menu} onClose={() => setMenu(null)} />}</AnimatePresence>
      <AnimatePresence>
        {confirm && (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
            <motion.div className="modal confirm" role="alertdialog" aria-modal aria-labelledby="confirm-title"
              initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0, transition: snap }} exit={{ opacity: 0, scale: 0.97 }}
              onKeyDown={(e) => e.key === 'Escape' && setConfirm(null)}>
              <TriangleAlert size={28} className="danger-icon" />
              <h3 id="confirm-title">{confirm.all ? 'Empty the Recycle Bin?' : `Delete ${confirm.ids.length > 1 ? `${confirm.ids.length} items` : 'this item'} permanently?`}</h3>
              <p className="muted">This can’t be undone. The files are gone for good.</p>
              <div className="confirm-buttons">
                <button className="btn" autoFocus onClick={() => setConfirm(null)}>Cancel</button>
                <button className="btn danger-solid" onClick={() => { const c = confirm; setConfirm(null); run(binPurge(c.ids), c.all ? 'Recycle Bin emptied' : 'Deleted permanently'); }}>
                  {confirm.all ? 'Empty Recycle Bin' : 'Delete permanently'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
