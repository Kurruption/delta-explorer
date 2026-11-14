import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Check, Plus, X } from 'lucide-react';
import { baseName, renameApply, renamePreview, type RenameRecipe } from './api';
import { Segmented } from './Settings';
import { DEFAULT_RECIPE, numberClashes, undoPairs } from './quick';
import { movePathRefs, persisted, toast, undoable } from './store';

/** What the dialog offers: one new name, case, extension, date, extra text. Saved as presets. */
interface Opts { name: string; case: RenameRecipe['case']; extMode: RenameRecipe['extMode']; ext: string; date: RenameRecipe['date']; dateFormat: string; dateAt: RenameRecipe['dateAt']; prefix: string; suffix: string }
const BLANK: Opts = { name: '', case: 'keep', extMode: 'keep', ext: '', date: 'none', dateFormat: 'YYYY-MM-DD', dateAt: 'start', prefix: '', suffix: '' };
const presets = persisted<{ name: string; opts: Opts }[]>('renamePresets2', []);
const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'YYYY-MM-DD hh.mm.ss', 'DD-MM-YYYY', 'YYYY-MM'];

/** The Rust recipe for these options (no numbering: clashing names get " (1)", " (2)"… below). */
const toRecipe = (o: Opts): RenameRecipe => ({
  ...DEFAULT_RECIPE,
  ...(o.name.trim() ? { find: '^.*$', replace: o.name.trim().replace(/\$/g, '$$$$'), regex: true } : {}),
  case: o.case, extMode: o.extMode, ext: o.ext, date: o.date, dateFormat: o.dateFormat, dateAt: o.dateAt, prefix: o.prefix, suffix: o.suffix, sep: ' ',
});

/** Runs a batch rename (also used to undo one) and keeps tags/pins following the items. */
async function run(pairs: [string, string][]) {
  const r = await renameApply(pairs);
  for (const [from, to] of r.done) movePathRefs(from, to);
  return r;
}

/** Batch rename: one new name for everything (auto-numbered), plus case, extension, date and extra text. Live preview; one undo step. */
export function BatchRename({ paths, onClose, onDone }: { paths: string[]; onClose: () => void; onDone: (newPaths: string[]) => void }) {
  const [o, setO] = useState<Opts>(BLANK);
  const [rows, setRows] = useState<{ to: string; problem: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const saved = presets.use();
  const uid = useId();
  const set = <K extends keyof Opts>(k: K, v: Opts[K]) => setO((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    let live = true;
    const bad = /[<>:"/\\|?*]/.test(o.name) ? 'A name can’t contain < > : " / \\ | ? *' : null;
    const t = setTimeout(() => renamePreview(paths, toRecipe(o)).then((x) => {
      if (!live) return;
      const named = numberClashes(x.map((r) => r.to), o.extMode === 'remove');
      setRows(x.map((r, i) => ({ to: named[i], problem: bad ?? (named[i] === r.to ? r.problem : null) })));
      setError(null);
    }, (e) => live && (setRows(null), setError(String(e)))), 90);
    return () => { live = false; clearTimeout(t); };
  }, [paths, o]);

  const changes = useMemo(() => (rows ? rows.map((x, i) => [paths[i], x.to] as [string, string]).filter(([p, to]) => baseName(p) !== to) : []), [rows, paths]);
  const problems = rows?.filter((x) => x.problem).length ?? 0;
  const can = !busy && !error && !!rows && problems === 0 && changes.length > 0;

  const apply = async () => {
    if (!can) return;
    setBusy(true);
    try {
      const res = await run(changes);
      if (res.done.length) {
        const n = res.done.length;
        undoable({ label: `Rename ${n} item${n > 1 ? 's' : ''}`, run: () => run(undoPairs(res.done)).then((u) => { if (u.failed.length) throw new Error(`${u.failed.length} couldn't be renamed back: ${u.failed[0][1]}`); }) },
          `Renamed ${n} item${n > 1 ? 's' : ''}`);
      }
      if (res.failed.length) toast(`${res.failed.length} couldn't be renamed: ${baseName(res.failed[0][0])}: ${res.failed[0][1]}`, 'error');
      onDone(res.done.map(([, to]) => to));
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const savePreset = (n: string) => {
    const name = n.trim();
    if (!name) return setNaming(null);
    presets.set((ps) => [...ps.filter((x) => x.name !== name), { name, opts: o }]);
    setNaming(null);
    toast(`Saved preset “${name}”`);
  };
  const section = (title: string, children: ReactNode, hint?: string) => (
    <section className="rn-card">
      <h4>{title}{hint && <span className="muted"> · {hint}</span>}</h4>
      {children}
    </section>
  );
  const text = (label: string, k: 'prefix' | 'suffix' | 'ext' | 'dateFormat', placeholder = '', list?: string) => (
    <label className="rn-field">
      <span>{label}</span>
      <input value={o[k]} placeholder={placeholder} spellCheck={false} list={list} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rn-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Presets: a side panel attached to the dialog's left edge */}
      <motion.aside className="rn-side" aria-label="Presets" initial={{ x: 24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }}>
        <h4>Presets</h4>
        <div className="rn-side-list">
          {saved.length === 0 && <p className="muted small">Save your settings to reuse them here.</p>}
          {saved.map((p) => (
            <div key={p.name} className="rn-preset">
              <button className="rn-preset-use" onClick={() => setO({ ...BLANK, ...p.opts })} title="Use this preset">{p.name}</button>
              <button className="icon-btn small" aria-label={`Delete preset ${p.name}`} onClick={() => presets.set((ps) => ps.filter((x) => x.name !== p.name))}><X size={13} /></button>
            </div>
          ))}
        </div>
        {naming === null
          ? <button className="btn small rn-side-save" onClick={() => setNaming('')}><Plus size={13} />Save current</button>
          : <form className="rn-side-form" onSubmit={(e) => { e.preventDefault(); savePreset(naming); }}>
              <input autoFocus value={naming} placeholder="Preset name" onChange={(e) => setNaming(e.target.value)} onBlur={() => savePreset(naming)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
              <button className="icon-btn small" type="submit" aria-label="Save preset"><Check size={14} /></button>
            </form>}
      </motion.aside>
      <motion.div className="modal rn" role="dialog" aria-modal aria-labelledby={`${uid}t`}
        initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <header className="rn-head">
          <h3 id={`${uid}t`}>Rename {paths.length} item{paths.length === 1 ? '' : 's'}</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="rn-body">
          <div className="rn-ops">

            <label className="rn-name">
              <span>New name</span>
              <input autoFocus value={o.name} placeholder="Keep current names" spellCheck={false} onChange={(e) => set('name', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} />
              <small className="muted">{paths.length > 1 ? 'Same names are numbered for you: “Holiday (1).jpg”, “Holiday (2).jpg”…' : 'The extension stays unless you change it below.'}</small>
            </label>

            {section('Case', <Segmented id={`${uid}case`} value={o.case} onChange={(v) => set('case', v)} options={[{ v: 'keep', label: 'Keep' }, { v: 'lower', label: 'lower' }, { v: 'upper', label: 'UPPER' }, { v: 'title', label: 'Title' }]} />)}
            {section('Extension', <>
              <Segmented id={`${uid}ext`} value={o.extMode} onChange={(v) => set('extMode', v)} options={[{ v: 'keep', label: 'Keep' }, { v: 'change', label: 'Change' }, { v: 'remove', label: 'Remove' }]} />
              {o.extMode === 'change' && text('New extension', 'ext', 'jpg')}
            </>)}
            {section('Date', <>
              <Segmented id={`${uid}date`} value={o.date} onChange={(v) => set('date', v)} options={[{ v: 'none', label: 'None' }, { v: 'modified', label: 'Modified' }, { v: 'created', label: 'Created' }]} />
              {o.date !== 'none' && <div className="rn-row">
                {text('Format', 'dateFormat', 'YYYY-MM-DD', `${uid}fmts`)}
                <datalist id={`${uid}fmts`}>{DATE_FORMATS.map((f) => <option key={f} value={f} />)}</datalist>
                <Segmented id={`${uid}at`} value={o.dateAt} onChange={(v) => set('dateAt', v)} options={[{ v: 'start', label: 'Before' }, { v: 'end', label: 'After' }]} />
              </div>}
            </>)}
            {section('Add text', <div className="rn-row">{text('Before', 'prefix', 'e.g. 2026 ')}{text('After', 'suffix', 'e.g.  final')}</div>)}
          </div>

          <div className="rn-preview" role="table" aria-label="Preview">
            <div className="rn-prow head" role="row"><span role="columnheader">Now</span><span aria-hidden /><span role="columnheader">After</span></div>
            <div className="rn-rows">
              {paths.map((p, i) => {
                const x = rows?.[i];
                const same = !x || x.to === baseName(p);
                return (
                  <div key={p} className={`rn-prow${x?.problem ? ' bad' : ''}${same ? ' same' : ''}`} role="row" title={x?.problem ?? undefined}>
                    <span role="cell">{baseName(p)}</span>
                    <ArrowRight size={13} aria-hidden />
                    <span role="cell">{x?.to ?? '…'}{x?.problem && <small className="rn-why">{x.problem}</small>}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <footer className="rn-foot">
          <span className={`small ${error || problems ? 'rn-err' : 'muted'}`} role="status">
            {error ?? (problems ? `${problems} name${problems > 1 ? 's' : ''} can't be used` : changes.length ? `${changes.length} of ${paths.length} will be renamed` : 'Type a new name, or pick an option')}
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!can} onClick={() => void apply()}>Rename {changes.length || ''}</button>
        </footer>
      </motion.div>
      </div>
    </motion.div>
  );
}
