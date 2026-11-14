import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { failOrElevate, isDenied } from './elevate';
import { AnimatePresence, motion } from 'motion/react';
import { Archive, Check, CircleAlert, Copy, FolderInput, FolderOutput, RefreshCw, X } from 'lucide-react';
import { baseName, cancelJob, deleteForever, type ConflictChoice, type ConflictSide, fmtDate, fmtSize, type JobUpdate, parentPath, recycle, resolveConflict, restore, startJob } from './api';
import { errorToast, memory, movePathRefs, pushUndo, toast, undoable } from './store';
import { glide, snap } from './motion';

export const jobs = memory<JobUpdate[]>([]);

/** Starts a job and resolves once it has ended (listening first, so a very fast job isn't missed). */
async function finished(start: () => Promise<number>) {
  const ended = new Set<number>();
  let id = -1, done = () => {};
  const over = new Promise<void>((r) => { done = r; });
  const un = await listen<JobUpdate>('job', ({ payload: j }) => {
    if (j.state === 'running' || j.state === 'conflict') return;
    ended.add(j.id);
    if (j.id === id) done();
  });
  try {
    id = await start();
    if (!ended.has(id)) await over;
  } finally { un(); }
}

/** What undoing a finished job means. Replaced items come back from the Recycle Bin afterwards. */
function undoFor(j: JobUpdate) {
  const back = async () => { if (j.replaced?.length) await restore(j.replaced); };
  if (j.kind === 'move' && j.moved.length) {
    return async () => {
      // Move each item back to the folder it came from (one job per original folder).
      const byParent = new Map<string, string[]>();
      for (const [from, to] of j.moved) byParent.set(parentPath(from), [...(byParent.get(parentPath(from)) ?? []), to]);
      for (const [dir, items] of byParent) await finished(() => startJob('move', items, dir));
      await back(); // the names are free again now
    };
  }
  if (j.created.length) return async () => { // copies, zips, extracted folders
    // A copy that replaced something is removed for good (its source still exists); recycling it would put a
    // second item with the same name in the bin, and restoring would bring back the copy instead of the original.
    const key = (p: string) => p.toLowerCase();
    const was = new Set((j.replaced ?? []).map(key));
    const over = j.kind === 'copy' ? j.created.filter((p) => was.has(key(p))) : [];
    if (over.length) await deleteForever(over);
    const rest = j.created.filter((p) => !over.includes(p));
    if (rest.length) await recycle(rest);
    await back();
  };
  return null;
}

/** Listens for job progress once, for the whole app. */
export function useJobEvents() {
  useEffect(() => {
    // Jobs are sent only to the window that started them.
    const un = getCurrentWindow().listen<JobUpdate>('job',({ payload: j }) => {
      jobs.set((all) => (all.some((x) => x.id === j.id) ? all.map((x) => (x.id === j.id ? j : x)) : [...all, j]));
      if (j.state === 'running' || j.state === 'conflict') return;
      for (const [from, to] of j.moved) movePathRefs(from, to); // tags and pins follow moved items
      const undo = undoFor(j);
      const verb = j.label.replace(/^Copying/, 'Copy').replace(/^Moving/, 'Move').replace(/^Compressing/, 'Compress').replace(/^Extracting/, 'Extract');
      if (j.state === 'done' && undo) undoable({ label: verb, run: undo }, j.label.replace(/^(\w+)ing/, (_m, v: string) => ({ Copy: 'Copied', Mov: 'Moved', Compress: 'Compressed', Extract: 'Extracted' })[v] ?? v));
      // Access denied: offer the rest as administrator (items that already moved/copied are left out).
      if (j.state === 'error' && isDenied(j.error) && j.items?.length && j.dest) {
        const moved = new Set(j.moved.map(([from]) => from.toLowerCase()));
        const rest = j.items.filter((p) => !moved.has(p.toLowerCase())).slice(j.kind === 'copy' ? Math.max(0, j.created.length - 1) : 0);
        failOrElevate(j.error, { op: j.kind === 'move' ? 'move' : 'copy', items: rest, dest: j.dest }, j.kind === 'move' ? 'Moved' : 'Copied');
      } else {
        // Some items failed, the rest went through: what did happen stays undoable (Ctrl+Z), the toast offers a retry.
        const retry = j.state === 'error' && j.failed?.length && j.dest
          ? { label: `Retry ${j.failed.length} failed`, run: () => void startJob(j.kind, j.failed.map(([p]) => p), j.dest!).catch(errorToast) }
          : undefined;
        if (retry && undo) pushUndo({ label: verb, run: undo });
        if (j.state === 'error') toast(j.error ?? 'Something went wrong', 'error', retry ?? (j.moved.length && undo ? { label: `Move ${j.moved.length} back`, run: () => void undo() } : undefined));
      }
      if (j.state === 'cancelled' && undo && j.created.length) toast(`${j.label}: cancelled`, 'info', { label: 'Remove partial copy', run: () => void undo() });
      // Finished cards linger briefly so the result is readable, then slide away.
      setTimeout(() => jobs.set((all) => all.filter((x) => x.id !== j.id)), j.state === 'error' ? 400 : 2600);
    });
    return () => { un.then((f) => f()); };
  }, []);
}

const ICON = { copy: Copy, move: FolderInput, zip: Archive, extract: FolderOutput, sync: RefreshCw };

/** Bottom-right stack of running jobs: progress, current file, cancel; a check when done. */
export function JobsPanel() {
  const list = jobs.use();
  const waiting = list.find((j) => j.state === 'conflict' && j.conflict);
  return (
    <>
    <AnimatePresence>{waiting && <ConflictDialog key={`${waiting.id}:${waiting.conflict!.src.path}`} job={waiting} />}</AnimatePresence>
    <div className="jobs" aria-live="polite">
      <AnimatePresence initial={false}>
        {list.map((j) => {
          const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : j.state === 'done' ? 100 : 0;
          const Icon = ICON[j.kind];
          return (
            <motion.div
              key={j.id}
              layout
              className={`job ${j.state}`}
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: glide }}
              exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.2 } }}
            >
              <div className="job-head">
                <span className="job-icon"><Icon size={15} /></span>
                <span className="job-label">{j.label}</span>
                <AnimatePresence mode="popLayout" initial={false}>
                  {j.state === 'running' || j.state === 'conflict' ? (
                    <motion.button key="x" className="icon-btn small" aria-label={`Cancel: ${j.label}`} onClick={() => cancelJob(j.id)} exit={{ opacity: 0, scale: 0.6 }}>
                      <X size={14} />
                    </motion.button>
                  ) : (
                    <motion.span key="s" className="job-state" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: snap }}>
                      {j.state === 'done' ? <Check size={15} /> : j.state === 'error' ? <CircleAlert size={15} /> : <X size={15} />}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={j.label}>
                <motion.span animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
              </div>
              <div className="job-meta muted small">
                <span className="job-current">{j.state === 'conflict' ? 'Waiting for your choice…' : j.state === 'running' ? baseName(j.current) || 'Preparing…' : j.state === 'done' ? 'Done' : j.state === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
                {j.total > 0 && <span>{fmtSize(j.done)} / {fmtSize(j.total)}</span>}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
    </>
  );
}

/**
 * A copy/move hit an existing name: the job waits until this is answered. Replace sends the existing item to
 * the Recycle Bin; a folder and a file never replace each other.
 */
function ConflictDialog({ job }: { job: JobUpdate }) {
  const c = job.conflict!;
  const [all, setAll] = useState(false);
  const [compare, setCompare] = useState(false);
  const [sent, setSent] = useState(false);
  const mixed = c.src.isDir !== c.dst.isDir;
  const answer = (ch: ConflictChoice) => {
    if (sent) return;
    setSent(true);
    resolveConflict(job.id, ch, all).catch(errorToast);
  };
  const side = (title: string, s: ConflictSide, o: ConflictSide) => (
    <div className="cf-side">
      <strong>{title}</strong>
      <span>{s.isDir ? 'Folder' : 'File'} · {fmtSize(s.size)}{s.size !== o.size && <em>{s.size > o.size ? ' larger' : ' smaller'}</em>}</span>
      <span>{fmtDate(s.modified) || 'Unknown date'}{s.modified !== o.modified && <em>{s.modified > o.modified ? ' newer' : ' older'}</em>}</span>
      <span className="muted small cf-path" title={s.path}>{parentPath(s.path)}</span>
    </div>
  );
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="modal confirm cf" role="alertdialog" aria-modal aria-labelledby={`cf-${job.id}`} aria-describedby={`cf-${job.id}-d`}
        initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancelJob(job.id); }}>
        <h3 id={`cf-${job.id}`}>“{baseName(c.dst.path)}” is already in {baseName(parentPath(c.dst.path))}</h3>
        <p className="muted" id={`cf-${job.id}-d`}>
          {mixed ? 'One is a folder and the other a file, so it can’t be replaced.' : 'Replace moves the one that’s there now to the Recycle Bin.'}
        </p>
        <AnimatePresence initial={false}>
          {compare && (
            <motion.div className="cf-compare" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
              {side(job.kind === 'move' ? 'Being moved' : 'Being copied', c.src, c.dst)}
              {side('Already there', c.dst, c.src)}
            </motion.div>
          )}
        </AnimatePresence>
        <label className="br-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Do this for all remaining conflicts</label>
        <div className="confirm-buttons cf-buttons">
          <button className="btn" aria-pressed={compare} onClick={() => setCompare(!compare)}>Compare</button>
          <span className="cf-gap" />
          <button className="btn" disabled={sent} onClick={() => cancelJob(job.id)}>Cancel</button>
          <button className="btn" disabled={sent} onClick={() => answer('skip')}>Skip</button>
          <button className="btn" disabled={sent || mixed} title={mixed ? 'A folder and a file can’t replace each other' : undefined} onClick={() => answer('replace')}>Replace</button>
          <button className="btn primary" autoFocus disabled={sent} onClick={() => answer('keepBoth')}>Keep both</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
