import { useRef, useState } from 'react';
import { Check, Download, Trash2, Upload, UserRound } from 'lucide-react';
import { writeExport } from './api';
import type { Command } from './Palette';
import { diff, makeBundle, parseBundle, readProfiles, applyData, deleteProfile, snapshot, switchProfile, type Bundle, type Change } from './profiles';
import { errorToast, toast } from './store';

/** "Profile: Work" commands for the palette. */
export const profileCommands = (): Command[] => {
  const p = readProfiles();
  return [...new Set([p.active, ...p.list.map((x) => x.name)])].filter((n) => n !== p.active).map((n) => ({
    id: `profile:${n}`, group: 'Profiles', label: `Switch to profile: ${n}`, icon: <UserRound size={15} />, run: () => switchProfile(n),
  }));
};

/** Settings → Profiles & backup. */
export function ProfilesPanel() {
  const [profiles, setProfiles] = useState(readProfiles);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<{ file: string; bundle: Bundle; changes: Change[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const names = [...new Set([profiles.active, ...profiles.list.map((x) => x.name)])];

  const exportAll = () => {
    const day = new Date().toISOString().slice(0, 10);
    writeExport(`Delta Explorer settings ${day}.json`, JSON.stringify(makeBundle(snapshot()), null, 2)).then((p) => toast(`Exported to ${p}`), errorToast);
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      if (f.size > 20 << 20) throw new Error('That file is too big to be a Delta settings file.');
      const bundle = parseBundle(await f.text());
      setPreview({ file: f.name, bundle, changes: diff(snapshot(), bundle.data) });
    } catch (e) { errorToast(e instanceof Error ? e.message : e); }
    if (file.current) file.current.value = '';
  };
  const create = () => {
    const n = name.trim();
    if (!n || n.length > 40) return;
    if (names.includes(n)) return toast(`There's already a profile called “${n}”`, 'error');
    switchProfile(n);
    setProfiles(readProfiles());
    setName('');
    toast(`Now using profile “${n}” (a copy of your current setup)`);
  };

  return <>
    <h3>Backup</h3>
    <p className="muted small">Everything Delta remembers (settings, shortcuts, pins, tags, folder colours, workspaces) in one .json file.</p>
    <div className="profile-actions">
      <button className="btn" onClick={exportAll}><Download size={14} /> Export to Downloads</button>
      <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Import…</button>
      <input ref={file} type="file" accept=".json,application/json" hidden aria-hidden onChange={(e) => void pick(e.target.files?.[0])} />
    </div>
    {preview && (
      <div className="import-preview" role="region" aria-label="Import preview">
        <strong>Import “{preview.file}”?</strong>
        <span className="muted small">Exported {new Date(preview.bundle.exported).toLocaleString()}. Anything not listed stays as it is.</span>
        <ul>
          {preview.changes.map((c) => (
            <li key={c.key} className={`chg ${c.kind}`}><span>{c.name}</span><span className="muted small">{c.kind === 'added' ? `new · ${c.detail}` : c.detail}</span></li>
          ))}
        </ul>
        <div className="confirm-buttons">
          <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
          <button className="btn primary" disabled={preview.changes.every((c) => c.kind === 'unchanged')} onClick={() => applyData(preview.bundle.data, false)}>Import and reload</button>
        </div>
      </div>
    )}
    <h3>Profiles</h3>
    <p className="muted small">Separate setups you can switch between (e.g. Work and Home). Switching reloads Delta.</p>
    <div className="profile-list" role="list">
      {names.map((n) => (
        <div key={n} className="profile-row" role="listitem">
          <UserRound size={15} className="muted" />
          <span className="reorder-name">{n}</span>
          {n === profiles.active ? <span className="muted small"><Check size={13} /> In use</span> : <>
            <button className="btn small" onClick={() => switchProfile(n)}>Switch</button>
            <button className="icon-btn small" aria-label={`Delete profile ${n}`} onClick={() => { try { deleteProfile(n); setProfiles(readProfiles()); } catch (e) { errorToast((e as Error).message); } }}><Trash2 size={14} /></button>
          </>}
        </div>
      ))}
    </div>
    <form className="profile-actions" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <input className="text" value={name} maxLength={40} placeholder="New profile name" aria-label="New profile name" onChange={(e) => setName(e.target.value)} />
      <button className="btn" type="submit" disabled={!name.trim()}>Create from current setup</button>
    </form>
  </>;
}
