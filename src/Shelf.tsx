// Drop Zone: a tray docked to the window edge. Park files on it while you navigate, then drag them out
// (copies; Shift moves) or use Copy/Move here. Kept until cleared (persisted).
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, ClipboardCopy, FolderInput, Inbox, Trash, X } from 'lucide-react';
import { baseName, isFolder, parentPath, startJob } from './api';
import { FileVisual } from './icons';
import { errorToast, memory, shelf } from './store';
import { glide, snap } from './motion';

/** Open/closed, so the command palette can show it. */
export const shelfOpen = memory(false);

export function Shelf({ current, beginDrag }: { current: string; beginDrag: (paths: string[], from: string, x: number, y: number, copyDefault?: boolean) => void }) {
  const items = shelf.use();
  const open = shelfOpen.use();
  const [press, setPress] = useState<{ x: number; y: number; paths: string[] } | null>(null);
  const here = isFolder(current);
  const drag = (m: React.MouseEvent) => {
    if (!press || !(m.buttons & 1) || Math.hypot(m.clientX - press.x, m.clientY - press.y) < 5) return;
    setPress(null);
    beginDrag(press.paths, parentPath(press.paths[0]), m.clientX, m.clientY, true);
  };
  const run = (kind: 'copy' | 'move') => {
    startJob(kind, items, current).catch(errorToast);
    if (kind === 'move') shelf.set([]);
  };
  const what = items.length === 1 ? `“${baseName(items[0])}”` : `${items.length} items`;

  return (
    <div className={`shelf${items.length || open ? '' : ' empty'}`} data-drop="shelf" onMouseMove={drag} onMouseUp={() => setPress(null)}>
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <motion.section key="open" className="shelf-card" aria-label="Shelf" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0, transition: glide }} exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}>
            <header>
              <Inbox size={15} className="accent" /><strong>Shelf</strong><span className="muted small">{items.length || ''}</span>
              <button className="icon-btn small" aria-label="Clear shelf" title="Clear shelf" disabled={!items.length} onClick={() => shelf.set([])}><Trash size={14} /></button>
              <button className="icon-btn small" aria-label="Collapse shelf" title="Collapse" onClick={() => shelfOpen.set(false)}><ChevronRight size={15} /></button>
            </header>
            {items.length ? (
              <>
                <ul className="shelf-list" onMouseDown={(m) => m.button === 0 && m.target === m.currentTarget && setPress({ x: m.clientX, y: m.clientY, paths: items })}>
                  {items.map((p) => (
                    <li key={p} title={`${p}\nDrag out to copy (Shift: move)`} onMouseDown={(m) => m.button === 0 && setPress({ x: m.clientX, y: m.clientY, paths: [p] })}>
                      <FileVisual name={baseName(p)} path={p} mtime={0} size={18} grid={false} />
                      <span className="label">{baseName(p)}</span>
                      <button className="icon-btn small" aria-label={`Remove ${baseName(p)} from the shelf`} onMouseDown={(m) => m.stopPropagation()} onClick={() => shelf.set((s) => s.filter((x) => x !== p))}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
                <footer>
                  <button className="btn small" disabled={!here} title={here ? `Copy ${what} to ${baseName(current)}` : 'Open a folder first'} onClick={() => run('copy')}><ClipboardCopy size={14} />Copy here</button>
                  <button className="btn small" disabled={!here} title={here ? `Move ${what} to ${baseName(current)}` : 'Open a folder first'} onClick={() => run('move')}><FolderInput size={14} />Move here</button>
                </footer>
              </>
            ) : <p className="muted small shelf-hint">Drop files here to park them while you browse.</p>}
          </motion.section>
        ) : (
          <motion.button key="tab" className="shelf-tab" aria-label={`Open shelf (${items.length} items)`} title="Shelf: drop files here to park them"
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, transition: snap }} exit={{ opacity: 0, scale: 0.8 }}
            onMouseDown={(m) => m.button === 0 && items.length && setPress({ x: m.clientX, y: m.clientY, paths: items })}
            onClick={() => shelfOpen.set(true)}>
            <Inbox size={16} />{items.length > 0 && <span className="shelf-count">{items.length}</span>}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
