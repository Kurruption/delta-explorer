import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { CornerDownLeft, Search } from 'lucide-react';
import { glide, snap } from './motion';

export interface Command { id: string; label: string; hint?: string; icon?: ReactNode; group: string; run: () => void }

/** Fuzzy match: every query character in order; tighter, earlier matches score higher. */
export function score(q: string, text: string) {
  if (!q) return 1;
  const t = text.toLowerCase(), s = q.toLowerCase();
  const direct = t.indexOf(s);
  if (direct >= 0) return 1000 - direct;
  let ti = 0, gaps = 0;
  for (const c of s) {
    const at = t.indexOf(c, ti);
    if (at < 0) return 0;
    gaps += at - ti;
    ti = at + 1;
  }
  return 500 - gaps;
}

/** Ctrl+K: jump anywhere, run any command. Typing a path offers to go there. */
export function Palette({ commands, onClose, onPath }: { commands: Command[]; onClose: () => void; onPath: (p: string) => void }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const looksLikePath = /^[a-z]:\\/i.test(q.trim());
  const shown = useMemo(() => {
    const r = commands.map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.hint ?? '') * 0.6) })).filter((x) => x.s > 0);
    r.sort((a, b) => b.s - a.s);
    const out = r.slice(0, 40).map((x) => x.c);
    if (looksLikePath) out.unshift({ id: 'path', label: `Go to ${q.trim()}`, group: 'Path', icon: <CornerDownLeft size={15} />, run: () => onPath(q.trim()) });
    return out;
  }, [q, commands, looksLikePath, onPath]);

  useEffect(() => setHi(0), [q]);
  const run = (c: Command) => { onClose(); c.run(); };

  return (
    <motion.div className="modal-backdrop palette-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal palette" role="dialog" aria-modal aria-label="Command palette"
        initial={{ opacity: 0, y: -16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1, transition: glide }} exit={{ opacity: 0, y: -10, scale: 0.98, transition: { duration: 0.12 } }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter' && shown[hi]) run(shown[hi]);
        }}>
        <label className="palette-input">
          <Search size={17} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search commands, folders, tags… or type a path" aria-label="Command" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={shown[hi] ? `pc-${hi}` : undefined} />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-list" id="palette-list" role="listbox">
          {shown.map((c, i) => (
            <div key={c.id} id={`pc-${i}`}>
              {(i === 0 || shown[i - 1].group !== c.group) && <div className="palette-group">{c.group}</div>}
              <button role="option" aria-selected={i === hi} className={`palette-item${i === hi ? ' hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => run(c)}>
                {i === hi && <motion.span layoutId="pal-hi" className="palette-hi" transition={snap} />}
                <span className="menu-icon">{c.icon}</span>
                <span className="menu-label">{c.label}</span>
                {c.hint && <span className="muted small palette-hint">{c.hint}</span>}
              </button>
            </div>
          ))}
          {!shown.length && <div className="menu-empty">Nothing matches “{q}”</div>}
        </div>
      </motion.div>
    </motion.div>
  );
}
