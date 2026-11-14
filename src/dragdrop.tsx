import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useSpring } from 'motion/react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Copy, MoveRight, Trash2 } from 'lucide-react';
import { baseName, driveOf, normPath, parentPath, recycle, restore, startDrag, startJob, isRemote } from './api';
import { addToCollection, addToShelf, undoable } from './store';
import { snap } from './motion';

// Any element with data-drop="<folder path>" (or "recycle") is a drop target: folder rows, sidebar items,
// breadcrumbs, tabs, Home tiles, the list background (= current folder).
type Drag = { paths: string[]; from: string; x: number; y: number; target: string | null; copy: boolean; copyDefault?: boolean };

/** Is dropping `paths` (from folder `from`) onto `t` meaningful? Not onto itself, its own folder, or inside itself. */
function valid(t: string, paths: string[], from: string | null) {
  if (t === 'shelf' || t.startsWith('col:')) return true; // shelf / collections only reference files
  if (t === 'recycle') return !paths.some((p) => isRemote(p) || p.startsWith('archive:')); // servers have no Recycle Bin
  const n = normPath(t);
  if (from && normPath(from) === n) return false;
  return !paths.some((p) => { const q = normPath(p); return n === q || n.startsWith(q + '\\'); });
}

function targetAt(x: number, y: number, paths: string[], from: string | null): [Element | null, string | null] {
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]') ?? null;
  const t = el?.getAttribute('data-drop') || null;
  return t && valid(t, paths, from) ? [el, t] : [null, null];
}

/**
 * Drag & drop controller.
 * - Inside the app: pointer-driven drag (Explorer rules: same drive moves, other drive copies; Ctrl copies, Shift moves).
 * - Leaving the window hands the drag to Windows (OLE), so Explorer, chat apps and editors receive real files.
 * - Files dropped in from other apps are copied into the folder under the pointer.
 */
export function useDragDrop(onError: (e: unknown) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const hot = useRef<Element | null>(null);
  const mark = (el: Element | null) => {
    if (hot.current === el) return;
    hot.current?.classList.remove('drop-hot');
    el?.classList.add('drop-hot');
    hot.current = el;
  };

  const beginDrag = useCallback((paths: string[], from: string, x: number, y: number, copyDefault = false) => setDrag({ paths, from, x, y, target: null, copy: false, copyDefault }), []);

  // Internal drag lifecycle.
  const active = !!drag;
  const dragRef = useRef(drag);
  dragRef.current = drag;
  useEffect(() => {
    if (!active) return;
    const end = () => { mark(null); setDrag(null); };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current!;
      if (e.clientX <= 2 || e.clientY <= 2 || e.clientX >= innerWidth - 3 || e.clientY >= innerHeight - 3) {
        end(); // left the window: Windows takes over the drag (button is still held)
        if (!d.paths.some(isRemote)) startDrag(d.paths).catch(onError); // server files aren't on disk to hand over
        return;
      }
      const [el, target] = targetAt(e.clientX, e.clientY, d.paths, d.from);
      mark(el);
      const copy = target !== 'recycle' && !!target && (d.copyDefault ? !e.shiftKey : e.ctrlKey || d.from.startsWith('archive:') || (!e.shiftKey && driveOf(target) !== driveOf(d.from))); // shelf drags copy unless Shift
      setDrag({ ...d, x: e.clientX, y: e.clientY, target, copy });
    };
    const onUp = () => {
      const d = dragRef.current!;
      end();
      if (!d.target) return;
      if (d.target === 'shelf') return addToShelf(d.paths);
      if (d.target.startsWith('col:')) return addToCollection(d.target.slice(4), d.paths);
      if (d.target === 'recycle') {
        const p = d.paths;
        const what = p.length > 1 ? `${p.length} items` : `“${baseName(p[0])}”`;
        recycle(p).then(() => undoable({ label: `Delete ${what}`, run: () => restore(p) }, `Moved ${what} to the Recycle Bin`), onError);
      } else {
        startJob(d.copy ? 'copy' : 'move', d.paths, d.target).catch(onError); // progress + undo via the jobs panel; the watcher refreshes views
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && end();
    addEventListener('mousemove', onMove);
    addEventListener('mouseup', onUp);
    addEventListener('keydown', onKey);
    document.body.classList.add('dragging');
    return () => {
      removeEventListener('mousemove', onMove);
      removeEventListener('mouseup', onUp);
      removeEventListener('keydown', onKey);
      document.body.classList.remove('dragging');
    };
  }, [active, onError]);

  // Files dragged in from other apps (and our own drag-out coming back).
  useEffect(() => {
    let incoming: string[] = [];
    const un = getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      if (p.type === 'leave') { mark(null); incoming = []; return; }
      if (p.type === 'enter') incoming = p.paths;
      const dpr = window.devicePixelRatio || 1;
      // Never recycle files dropped in from outside by accident: only real folders accept external drops.
      const from = incoming.length && incoming.every((x) => normPath(parentPath(x)) === normPath(parentPath(incoming[0]))) ? parentPath(incoming[0]) : null;
      const [el, target] = targetAt(p.position.x / dpr, p.position.y / dpr, incoming, from);
      const t = target === 'recycle' ? null : target;
      mark(t ? el : null);
      if (p.type === 'drop') {
        mark(null);
        if (t === 'shelf') addToShelf(p.paths);
        else if (t?.startsWith('col:')) addToCollection(t.slice(4), p.paths);
        else if (t && p.paths.length) startJob('copy', p.paths, t).catch(onError);
        incoming = [];
      }
    });
    return () => { un.then((f) => f()); };
  }, [onError]);

  // The badge follows the pointer on a spring, so it trails slightly and feels physical.
  const gx = useSpring(0, { stiffness: 900, damping: 60, mass: 0.4 });
  const gy = useSpring(0, { stiffness: 900, damping: 60, mass: 0.4 });
  useEffect(() => { if (drag) { gx.set(drag.x + 14); gy.set(drag.y + 16); } }, [drag?.x, drag?.y]); // eslint-disable-line react-hooks/exhaustive-deps
  const startedAt = useRef<{ x: number; y: number } | null>(null);
  if (drag && !startedAt.current) { startedAt.current = { x: drag.x, y: drag.y }; gx.jump(drag.x + 14); gy.jump(drag.y + 16); }
  if (!drag) startedAt.current = null;

  const text = drag && (drag.target === 'shelf' ? 'Add to shelf' : drag.target?.startsWith('col:') ? 'Add to collection' : drag.target === 'recycle'
    ? `Delete ${drag.paths.length > 1 ? `${drag.paths.length} items` : baseName(drag.paths[0])}`
    : drag.target
      ? `${drag.copy ? 'Copy' : 'Move'} ${drag.paths.length > 1 ? `${drag.paths.length} items` : baseName(drag.paths[0])} to ${baseName(drag.target)}`
      : drag.paths.length > 1 ? `${drag.paths.length} items` : baseName(drag.paths[0]));
  const mode = !drag?.target || drag.target === 'shelf' || drag.target.startsWith('col:') ? 'idle' : drag.target === 'recycle' ? 'del' : drag.copy ? 'copy' : 'move';

  const ghost = (
    <AnimatePresence>
      {drag && (
        <motion.div
          key="ghost"
          className={`drag-ghost ${mode}`}
          style={{ x: gx, y: gy }}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1, transition: snap }}
          exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12 } }}
          aria-hidden
        >
          {drag.paths.length > 1 && <span className="ghost-count">{drag.paths.length}</span>}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={mode} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: snap }} exit={{ scale: 0.5, opacity: 0 }} className="ghost-icon">
              {mode === 'del' ? <Trash2 size={14} /> : mode === 'copy' ? <Copy size={14} /> : <MoveRight size={14} />}
            </motion.span>
          </AnimatePresence>
          <motion.span layout className="ghost-text">{text}</motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return { beginDrag, ghost };
}
