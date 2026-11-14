// Photo EXIF and audio tags (read-only details; audio tags editable and saved safely by Rust).
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Info, Save, X } from 'lucide-react';
import { baseName, properties, readMeta, writeAudioTags, type AudioTags, type Meta } from './api';
import { errorToast, metaDialog, toast } from './store';

const FIELDS: [keyof AudioTags, string][] = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['track', 'Track'], ['genre', 'Genre']];

export function MetaDialog({ path }: { path: string }) {
  const [m, setM] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<AudioTags | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => metaDialog.set(null);
  const load = () => readMeta(path).then((x) => { setM(x); setTags(x.tags); }, (e) => setError(String(e)));
  useEffect(() => { load(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!tags && !!m?.tags && FIELDS.some(([k]) => tags[k] !== m.tags![k]);
  const save = () => {
    if (!tags) return;
    setSaving(true);
    writeAudioTags(path, tags).then(() => { toast('Tags saved'); load(); }, errorToast).finally(() => setSaving(false));
  };
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="modal meta-dialog" role="dialog" aria-modal aria-labelledby="meta-title" initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <header className="power-head">
          <h3 id="meta-title" title={path}>{baseName(path)}</h3>
          <button className="icon-btn" aria-label="Close" autoFocus onClick={close}><X size={16} /></button>
        </header>
        <div className="meta-body">
          {error ? <p className="danger-text" role="alert">{error}</p> : !m ? <p className="muted"><span className="spinner" /> Reading…</p> : (
            <>
              {!m.kind && <p className="muted">No photo or audio details in this file.</p>}
              {m.fields.length > 0 && <dl className="meta-grid">{m.fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
              {tags && (
                <form className="meta-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
                  {FIELDS.map(([k, label]) => (
                    <label key={k}>
                      <span>{label}</span>
                      <input value={k === 'track' ? (tags.track || '') : tags[k]} inputMode={k === 'track' ? 'numeric' : undefined}
                        onChange={(e) => setTags({ ...tags, [k]: k === 'track' ? Math.max(0, Math.min(9999, parseInt(e.target.value, 10) || 0)) : e.target.value })} />
                    </label>
                  ))}
                </form>
              )}
            </>
          )}
        </div>
        <footer className="power-foot">
          <button className="btn" onClick={() => properties(path).catch(errorToast)}><Info size={14} />Windows Properties</button>
          <span className="grow" />
          {tags && <button className="btn primary" disabled={!dirty || saving} onClick={save}><Save size={14} />{saving ? 'Saving…' : 'Save tags'}</button>}
        </footer>
      </motion.div>
    </motion.div>
  );
}
