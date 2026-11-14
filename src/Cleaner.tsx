// Storage cleaner: settings, the preview/confirm dialog, and the schedule that runs while Delta is open.
// Rust decides what qualifies and deletes (src-tauri/src/cleaner.rs); we only send the rules.
import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Trash2, X } from 'lucide-react';
import { fmtSize, restore } from './api';
import { Segmented } from './Settings';
import { errorToast, openTool, persisted, toast } from './store';

export interface Custom { dir: string; days: number; pattern: string }
export interface CleanerConfig {
  enabled: boolean;
  schedule: 'startup' | 'daily' | 'weekly';
  lastRun: number;
  temp: boolean;
  bin: boolean; binDays: number;
  downloads: boolean; downloadsDays: number;
  delta: boolean;
  custom: Custom[];
  /** Targets the user has confirmed once; automatic runs only clean these. */
  approved: string[];
}
export const cleaner = persisted<CleanerConfig>('cleaner', cleanerDefaults(), (s) => ({ ...cleanerDefaults(), ...s }));
function cleanerDefaults(): CleanerConfig {
  return { enabled: false, schedule: 'weekly', lastRun: 0, temp: true, bin: true, binDays: 30, downloads: false, downloadsDays: 60, delta: true, custom: [], approved: [] };
}
const set = (p: Partial<CleanerConfig>) => cleaner.set((c) => ({ ...c, ...p }));

interface Target { key: string; dir?: string; days: number; pattern?: string }
interface Group { key: string; permanent: boolean; items: { path: string; size: number }[]; total: number; error: string | null }
interface Outcome { freed: number; removed: number; skipped: number; recycled: string[] }
const preview = (targets: Target[]) => invoke<Group[]>('cleaner_preview', { targets });
const run = (targets: Target[]) => invoke<Outcome>('cleaner_run', { targets });

/** The enabled targets as rules for Rust. */
export function targetsOf(c: CleanerConfig): Target[] {
  return [
    ...(c.temp ? [{ key: 'temp', days: 1 }] : []),
    ...(c.delta ? [{ key: 'delta', days: 0 }] : []),
    ...(c.bin ? [{ key: 'bin', days: c.binDays }] : []),
    ...(c.downloads ? [{ key: 'downloads', days: c.downloadsDays }] : []),
    ...c.custom.map((x) => ({ key: `custom:${x.dir.toLowerCase()}`, dir: x.dir, days: x.days, pattern: x.pattern })),
  ];
}
const NAMES: Record<string, string> = { temp: 'Windows temp files', delta: 'Delta’s own temp files', bin: 'Recycle Bin', downloads: 'Downloads' };
const nameOf = (key: string) => NAMES[key] ?? key.replace(/^custom:/, '');

const DAY = 86_400_000;
const due = (c: CleanerConfig, startup: boolean) => c.enabled && (c.schedule === 'startup' ? startup : Date.now() - c.lastRun >= (c.schedule === 'daily' ? DAY : 7 * DAY));

function report(o: Outcome) {
  const msg = `Storage cleaner freed ${fmtSize(o.freed)}${o.skipped ? ` (${o.skipped} in-use files skipped)` : ''}`;
  if (o.recycled.length) toast(msg, 'info', { label: 'Undo', run: () => void restore(o.recycled).then((n) => toast(`Restored ${n} items`), errorToast) });
  else toast(msg);
}

/** Runs the cleaner on schedule while Delta is open (checked at startup and hourly). */
export function useCleanerSchedule() {
  useEffect(() => {
    const check = (startup: boolean) => {
      const c = cleaner.get();
      if (!due(c, startup)) return;
      set({ lastRun: Date.now() });
      const all = targetsOf(c);
      const ok = all.filter((t) => c.approved.includes(t.key));
      if (ok.length) run(ok).then((o) => o.removed && report(o), errorToast);
      if (ok.length < all.length) toast('Storage cleaner has new places to review before it cleans them', 'info', { label: 'Review', run: () => openTool('cleaner', []) });
    };
    check(true);
    const t = setInterval(() => check(false), 3_600_000);
    return () => clearInterval(t);
  }, []);
}

// ---------------- settings ----------------
type RowT = (p: { title: string; desc?: ReactNode; children: ReactNode }) => ReactNode;
type ToggleT = (p: { on: boolean; onChange: (v: boolean) => void; label: string }) => ReactNode;
export function CleanerSettings({ Row, Toggle }: { Row: RowT; Toggle: ToggleT }) {
  const c = cleaner.use();
  const [dir, setDir] = useState('');
  const days = (v: number, f: (n: number) => void, label: string) => (
    <input className="num-input" type="number" min={0} max={3650} value={v} aria-label={label} onChange={(e) => f(Math.max(0, Math.min(3650, +e.target.value || 0)))} />
  );
  const add = () => {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) return;
    invoke('cleaner_check', { dir: d }).then(() => { set({ custom: [...c.custom, { dir: d, days: 30, pattern: '' }] }); setDir(''); }, errorToast);
  };
  const upd = (i: number, p: Partial<Custom>) => set({ custom: c.custom.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <>
      <Row title="Clean automatically" desc="Runs while Delta is open. New places are always shown to you first; anything not temporary goes to the Recycle Bin.">
        <Toggle label="Clean automatically" on={c.enabled} onChange={(v) => set({ enabled: v })} />
      </Row>
      <Row title="When" desc={c.lastRun ? `Last run ${new Date(c.lastRun).toLocaleString()}` : 'Not run yet'}>
        <Segmented id="cl-when" value={c.schedule} onChange={(v) => set({ schedule: v })} options={[{ v: 'startup', label: 'On startup' }, { v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }]} />
      </Row>
      <Row title="Windows temp files" desc="Older than 1 day; files in use are skipped. Deleted for good."><Toggle label="Windows temp files" on={c.temp} onChange={(v) => set({ temp: v })} /></Row>
      <Row title="Delta’s own temp files" desc="Files unpacked from archives you browsed. Deleted for good."><Toggle label="Delta temp files" on={c.delta} onChange={(v) => set({ delta: v })} /></Row>
      <Row title="Recycle Bin" desc={<>Empty items deleted more than {days(c.binDays, (n) => set({ binDays: n }), 'Recycle Bin days')} days ago</>}><Toggle label="Recycle Bin" on={c.bin} onChange={(v) => set({ bin: v })} /></Row>
      <Row title="Downloads" desc={<>Files older than {days(c.downloadsDays, (n) => set({ downloadsDays: n }), 'Downloads days')} days, to the Recycle Bin</>}><Toggle label="Downloads" on={c.downloads} onChange={(v) => set({ downloads: v })} /></Row>
      {c.custom.map((x, i) => (
        <Row key={x.dir + i} title={x.dir} desc={<>Files older than {days(x.days, (n) => upd(i, { days: n }), `${x.dir} days`)} days matching <input className="pat-input" value={x.pattern} placeholder="any name (e.g. *.log;*.tmp)" aria-label={`${x.dir} pattern`} onChange={(e) => upd(i, { pattern: e.target.value })} />, to the Recycle Bin</>}>
          <button className="icon-btn" aria-label={`Remove ${x.dir}`} onClick={() => set({ custom: c.custom.filter((_, j) => j !== i) })}><X size={15} /></button>
        </Row>
      ))}
      <Row title="Add a folder" desc="Drive roots, Windows, Program Files and your user folder itself can’t be added.">
        <form className="cl-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\path\to\folder" aria-label="Folder to clean" spellCheck={false} />
          <button className="btn small" aria-label="Add folder"><Plus size={14} /></button>
        </form>
      </Row>
      <Row title="Preview / clean now" desc="See exactly what would be removed first"><button className="btn" onClick={() => openTool('cleaner', [])}>Preview…</button></Row>
    </>
  );
}

// ---------------- preview + confirm ----------------
export function CleanerDialog({ close }: { close: () => void }) {
  const c = cleaner.use();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const targets = targetsOf(c);
  useEffect(() => {
    preview(targets).then((g) => { setGroups(g); setPick(new Set(g.filter((x) => x.items.length).map((x) => x.key))); }, (e) => { errorToast(e); close(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = targets.filter((t) => pick.has(t.key));
  const total = (groups ?? []).filter((g) => pick.has(g.key)).reduce((a, g) => a + g.total, 0);
  const go = () => {
    setBusy(true);
    run(chosen).then((o) => {
      cleaner.set((x) => ({ ...x, lastRun: Date.now(), approved: [...new Set([...x.approved, ...chosen.map((t) => t.key)])] }));
      report(o);
      close();
    }, (e) => { setBusy(false); errorToast(e); });
  };
  return (
    <>
      <header className="tool-head"><div><h3 id="tool-title">Storage cleaner</h3><span className="muted small">Nothing is removed until you press Clean</span></div>
        <button className="icon-btn" aria-label="Close" onClick={close}><X size={16} /></button></header>
      <div className="tool-body">
        {!targets.length && <p className="muted">No places are turned on. Choose them in Settings → Storage cleaner.</p>}
        {!groups && targets.length > 0 && <div className="tool-working"><span className="spinner" aria-hidden /> Looking for old files…</div>}
        {groups && (
          <div className="dupe-list">
            {groups.map((g) => (
              <details key={g.key}>
                <summary>
                  <input type="checkbox" checked={pick.has(g.key)} disabled={!g.items.length} aria-label={`Clean ${nameOf(g.key)}`}
                    onChange={() => setPick((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} />
                  {nameOf(g.key)} <span className="muted small">{g.error ?? `${g.items.length} items · ${fmtSize(g.total)} · ${g.permanent ? 'deleted for good' : 'to the Recycle Bin'}`}</span>
                </summary>
                {g.items.slice(0, 300).map((i) => <div key={i.path} className="dupe-file"><span /><span className="dupe-path" title={i.path}>{i.path}</span><span className="muted small">{fmtSize(i.size)}</span><span /></div>)}
                {g.items.length > 300 && <p className="muted small">…and {g.items.length - 300} more</p>}
              </details>
            ))}
          </div>
        )}
        <footer className="tool-foot"><span className="grow" /><button className="btn" onClick={close}>Cancel</button>
          <button className="btn danger-solid" disabled={busy || !(groups ?? []).some((g) => pick.has(g.key) && g.items.length)} onClick={go}><Trash2 size={14} /> Clean {fmtSize(total)}</button></footer>
      </div>
    </>
  );
}
