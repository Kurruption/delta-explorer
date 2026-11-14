import { useId, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { baseName, pasteClip, recycle } from './api';
import { toast, undoable } from './store';

/** Small one-field dialog (Select by pattern, Create several folders). Enter submits; in the multi-line box, Ctrl+Enter. */
export function PromptDialog({ title, label, hint, placeholder, multiline, submit, onSubmit, onClose }: {
  title: string; label: string; hint?: ReactNode; placeholder?: string; multiline?: boolean; submit: string;
  onSubmit: (value: string) => void; onClose: () => void;
}) {
  const [v, setV] = useState('');
  const id = useId();
  const go = () => { if (v.trim()) { onSubmit(v); onClose(); } };
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.form className="modal confirm prompt" role="dialog" aria-modal aria-labelledby={`${id}t`}
        initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onSubmit={(e) => { e.preventDefault(); go(); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); go(); } }}>
        <h3 id={`${id}t`}>{title}</h3>
        <label className="br-field wide">
          <span>{label}</span>
          {multiline
            ? <textarea autoFocus rows={7} value={v} placeholder={placeholder} spellCheck={false} onChange={(e) => setV(e.target.value)} />
            : <input autoFocus value={v} placeholder={placeholder} spellCheck={false} onChange={(e) => setV(e.target.value)} />}
        </label>
        {hint && <p className="muted small">{hint}</p>}
        <div className="confirm-buttons">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>{submit}</button>
        </div>
      </motion.form>
    </motion.div>
  );
}

/** Command palette entries handled by the active pane's FileList: [id, label, shortcut hint]. */
export const LIST_COMMANDS: [string, string, string?][] = [
  ['batchRename', 'Rename selected items…', 'F2'],
  ['invert', 'Invert selection', 'Ctrl I'],
  ['pattern', 'Select by pattern…'],
  ['folders', 'Create several folders…'],
  ['pasteFile', 'Paste clipboard text or picture as a file'],
  ['copyName', 'Copy name'],
  ['copyParent', 'Copy parent folder path'],
];

/** Clipboard text -> .txt, picture -> .png in `dir` (undoable). Resolves to the new file, or null if there was nothing to paste. */
export async function pasteAsFile(dir: string) {
  const made = await pasteClip(dir);
  if (!made) { toast('The clipboard has no files, text or picture to paste'); return null; }
  undoable({ label: `Paste “${baseName(made)}”`, run: () => recycle([made]) }, `Pasted as “${baseName(made)}”`);
  return made;
}
