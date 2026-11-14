// Folder compare & sync, and two-file compare. Sync always shows every planned action first;
// mirror deletions need one more confirm. Replaced and deleted files go to the Recycle Bin.
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowLeftRight, ArrowRight, Check, Equal, FileSearch, RefreshCw, Trash2, X } from 'lucide-react';
import {
  baseName, compareContents, compareDirs, diffFiles, fmtDate, fmtSize, planSync, startSync,
  type CmpItem, type CmpKind, type CmpSide, type FileDiff, type SyncAction, type SyncMode,
} from './api';
import { Segmented } from './Settings';
import { compareDialog, errorToast, toast } from './store';

const KINDS: Record<CmpKind, string> = {
  onlyLeft: 'Only left', onlyRight: 'Only right', newerLeft: 'Newer left', newerRight: 'Newer right', differs: 'Different', identical: 'Identical', conflict: 'File vs folder',
};
const MAX_SHOWN = 3000;

export function CompareDialog({ kind, a, b }: { kind: 'folders' | 'files'; a: string; b: string }) {
  const close = () => compareDialog.set(null);
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="modal power" role="dialog" aria-modal aria-label={kind === 'folders' ? 'Compare folders' : 'Compare files'}
        initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        {kind === 'folders' ? <Folders a={a} b={b} close={close} /> : <Files a={a} b={b} close={close} />}
      </motion.div>
    </motion.div>
  );
}

const side = (s: CmpSide | null) => (!s ? '—' : s.isDir ? 'Folder' : `${fmtSize(s.size)} · ${fmtDate(s.modified)}`);

function Head({ title, a, b, close, extra }: { title: string; a: string; b: string; close: () => void; extra?: React.ReactNode }) {
  return (
    <header className="power-head">
      <h3>{title}</h3>
      <span className="power-paths small"><span title={a}>L: {a}</span><span title={b}>R: {b}</span></span>
      {extra}
      <button className="icon-btn" aria-label="Close" autoFocus onClick={close}><X size={16} /></button>
    </header>
  );
}

function Folders({ a: a0, b: b0, close }: { a: string; b: string; close: () => void }) {
  const [[a, b], setSides] = useState([a0, b0]);
  const [items, setItems] = useState<CmpItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hide, setHide] = useState<Set<CmpKind>>(new Set(['identical']));
  const [checked, setChecked] = useState<Map<string, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<SyncMode>('leftToRight');
  const [plan, setPlan] = useState<SyncAction[] | null>(null);
  const [confirm, setConfirm] = useState(false);

  const run = () => { setItems(null); setError(null); setChecked(new Map()); setPlan(null); compareDirs(a, b).then(setItems, (e) => setError(String(e))); };
  useEffect(run, [a, b]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = {} as Record<CmpKind, number>;
    for (const i of items ?? []) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const shown = (items ?? []).filter((i) => !hide.has(i.kind));
  // Same size but different dates: contents may still be equal. Checked on demand (byte compare in Rust).
  const unsure = (items ?? []).filter((i) => (i.kind === 'newerLeft' || i.kind === 'newerRight') && i.left?.size === i.right?.size && !checked.has(i.rel));
  const checkContents = () => {
    setBusy(true);
    const rels = unsure.map((i) => i.rel);
    compareContents(a, b, rels).then((same) => {
      const m = new Map(checked);
      rels.forEach((r, k) => m.set(r, same[k]));
      setChecked(m);
      setItems((all) => all!.map((i) => (m.get(i.rel) ? { ...i, kind: 'identical' } : i)));
      const n = same.filter(Boolean).length;
      toast(`${n} of ${rels.length} turned out identical`);
    }, errorToast).finally(() => setBusy(false));
  };
  const preview = () => planSync(items ?? [], mode).then((p) => { setPlan(p); setConfirm(false); }, errorToast);
  const deletes = plan?.filter((x) => x.op === 'delete').length ?? 0;
  const go = () => {
    if (!plan?.length) return;
    if (deletes && !confirm) return setConfirm(true);
    startSync(a, b, plan).then(() => { toast('Sync started'); close(); }, errorToast);
  };

  const swap = <button className="icon-btn" aria-label="Swap sides" title="Swap left and right" onClick={() => setSides([b, a])}><ArrowLeftRight size={16} /></button>;
  if (plan) {
    const what = (x: SyncAction) => x.op === 'delete' ? 'Recycle' : x.op === 'replace' ? 'Replace' : 'Copy';
    return (
      <>
        <Head title="Sync preview" a={a} b={b} close={close} />
        <p className="power-note muted small">
          {plan.length ? `${plan.length} actions. Nothing has changed yet. Replaced files and deletions go to the Recycle Bin.` : 'Nothing to do: the folders already match for this mode.'}
        </p>
        <div className="power-table" role="table" aria-label="Planned actions">
          {plan.slice(0, MAX_SHOWN).map((x, i) => (
            <div key={i} role="row" className={`power-row plan ${x.op}`}>
              <span className={`cmp-kind ${x.op === 'delete' ? 'bad' : ''}`}>{x.op === 'delete' ? <Trash2 size={13} /> : x.toRight ? <ArrowRight size={13} /> : <ArrowLeft size={13} />}{what(x)}</span>
              <span className="label" title={x.rel}>{x.rel}</span>
              <span className="muted small">{x.op === 'delete' ? `on the ${x.toRight ? 'right' : 'left'}` : x.toRight ? 'left → right' : 'right → left'}</span>
            </div>
          ))}
          {plan.length > MAX_SHOWN && <p className="muted small power-note">…and {plan.length - MAX_SHOWN} more</p>}
        </div>
        <footer className="power-foot">
          {confirm && <span className="danger-text small" role="alert">{deletes} item{deletes > 1 ? 's' : ''} on the right will go to the Recycle Bin. Click again to confirm.</span>}
          <span className="grow" />
          <button className="btn" onClick={() => setPlan(null)}>Back</button>
          <button className={`btn ${confirm ? 'danger-solid' : 'primary'}`} disabled={!plan.length} onClick={go}>
            <RefreshCw size={14} />{confirm ? `Yes, sync and recycle ${deletes}` : `Run sync (${plan.length})`}
          </button>
        </footer>
      </>
    );
  }
  return (
    <>
      <Head title="Compare folders" a={a} b={b} close={close} extra={swap} />
      <div className="cmp-chips" role="group" aria-label="Show">
        {(Object.keys(KINDS) as CmpKind[]).filter((k) => counts[k]).map((k) => (
          <button key={k} className={`chip cmp-${k}`} aria-pressed={!hide.has(k)} onClick={() => setHide((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
            {KINDS[k]} <b>{counts[k]}</b>
          </button>
        ))}
        <span className="grow" />
        {unsure.length > 0 && <button className="btn small" disabled={busy} onClick={checkContents} title="Same size, different date: compare the bytes"><FileSearch size={14} />Check contents ({unsure.length})</button>}
        <button className="btn small" onClick={run}><RefreshCw size={14} />Rescan</button>
      </div>
      <div className="power-table" role="table" aria-label="Differences">
        {error ? <p className="danger-text power-note" role="alert">{error}</p> : !items ? <p className="muted power-note"><span className="spinner" /> Comparing…</p> : !shown.length ? (
          <p className="muted power-note"><Check size={14} /> {items.length ? 'No differences shown' : 'Both folders are empty'}</p>
        ) : shown.slice(0, MAX_SHOWN).map((i) => (
          <div key={i.rel} role="row" className="power-row">
            <span className={`cmp-kind cmp-${i.kind}`}>{i.kind === 'identical' ? <Equal size={13} /> : null}{KINDS[i.kind]}
              {checked.get(i.rel) === false && <em className="small"> · contents differ</em>}
              {(i.kind === 'newerLeft' || i.kind === 'newerRight') && i.left?.size === i.right?.size && !checked.has(i.rel) && <em className="small muted"> · same size</em>}
            </span>
            <span className="label" title={i.rel}>{i.rel}</span>
            <span className="muted small">{side(i.left)}</span>
            <span className="muted small">{side(i.right)}</span>
          </div>
        ))}
        {shown.length > MAX_SHOWN && <p className="muted small power-note">…and {shown.length - MAX_SHOWN} more</p>}
      </div>
      <footer className="power-foot">
        <Segmented id="sync-mode" value={mode} onChange={setMode} options={[
          { v: 'leftToRight', label: 'Left → Right' }, { v: 'rightToLeft', label: 'Right → Left' }, { v: 'both', label: 'Both ways' }, { v: 'mirror', label: 'Mirror L → R' },
        ]} />
        <span className="grow" />
        <button className="btn primary" disabled={!items?.length} onClick={preview}>Preview sync…</button>
      </footer>
    </>
  );
}

function Files({ a, b, close }: { a: string; b: string; close: () => void }) {
  const [d, setD] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { diffFiles(a, b).then(setD, (e) => setError(String(e))); }, [a, b]);
  const verdict = d && (d.identical ? <span className="ok-text"><Check size={14} /> Identical</span> : <span className="danger-text">Different</span>);
  return (
    <>
      <Head title={`${baseName(a)} ↔ ${baseName(b)}`} a={a} b={b} close={close} extra={verdict} />
      {error ? <p className="danger-text power-note" role="alert">{error}</p> : !d ? <p className="muted power-note"><span className="spinner" /> Comparing…</p> : d.text ? (
        <>
          <p className="power-note muted small">{d.identical ? 'Same bytes.' : `${d.removed} lines changed or removed on the left, ${d.added} changed or added on the right.`}{d.truncated && ' Diff cut short: too many lines.'}</p>
          <div className="power-table diff" role="table" aria-label="Line differences">
            {d.rows.map((r, i) => r.tag === 'skip' ? (
              <div key={i} role="row" className="diff-row skip muted small">⋯ {r.l} unchanged lines</div>
            ) : (
              <div key={i} role="row" className={`diff-row ${r.tag}`}>
                <span className="ln">{r.l ?? ''}</span><code className={r.tag === 'del' || r.tag === 'chg' ? 'minus' : ''}>{r.a}</code>
                <span className="ln">{r.r ?? ''}</span><code className={r.tag === 'add' || r.tag === 'chg' ? 'plus' : ''}>{r.b}</code>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="power-note">
          <p className="muted small">{d.sizeA > 4 << 20 || d.sizeB > 4 << 20 ? 'Too large for a line diff;' : 'Binary files;'} compared by size and SHA-256.</p>
          <dl className="hash-grid">
            <dt>Left</dt><dd>{fmtSize(d.sizeA)}<code>{d.hashA}</code></dd>
            <dt>Right</dt><dd>{fmtSize(d.sizeB)}<code>{d.hashB}</code></dd>
          </dl>
        </div>
      )}
    </>
  );
}
