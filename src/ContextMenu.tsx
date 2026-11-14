import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { snap } from './motion';

type Action = {
  label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean;
  run?: () => void; sub?: () => Promise<MenuItem[]> | MenuItem[];
};
export type MenuItem = Action | 'sep';

/**
 * Delta context menu: icon + label + shortcut rows, a type-to-filter box (from Atlas), drill-in submenus.
 * Motion: springs open from the cursor, the highlight slides between rows, submenus slide sideways.
 * Render inside <AnimatePresence> so it can animate out.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const [stack, setStack] = useState<{ title: string; items: MenuItem[] }[]>([]);
  const [dir, setDir] = useState(1);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const level = stack.length ? stack[stack.length - 1] : null;
  const list = level ? level.items : items;
  const shown = q
    ? list.filter((i): i is Action => i !== 'sep' && !i.disabled && i.label.toLowerCase().includes(q.toLowerCase()))
    : list.filter((i, n, a) => i !== 'sep' || (n > 0 && a[n - 1] !== 'sep' && n < a.length - 1)); // no leading/double/trailing separators
  const actionable = shown.filter((i): i is Action => i !== 'sep' && !i.disabled);

  // Keep on screen; grow from the corner nearest the cursor.
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    const flipX = x + r.width + 8 > innerWidth, flipY = y + r.height + 8 > innerHeight;
    setPos({
      left: Math.max(8, flipX ? x - r.width : x),
      top: Math.max(8, flipY ? Math.max(8, innerHeight - r.height - 8) : y),
      origin: `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`,
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    addEventListener('mousedown', close);
    addEventListener('blur', onClose);
    return () => { removeEventListener('mousedown', close); removeEventListener('blur', onClose); };
  }, [onClose]);

  const back = () => { setDir(-1); setStack((s) => s.slice(0, -1)); setQ(''); setHi(0); input.current?.focus(); };
  const run = async (i: Action) => {
    if (i.sub) {
      setLoading(true);
      try {
        const sub = await i.sub();
        setDir(1); setStack((s) => [...s, { title: i.label, items: sub }]); setQ(''); setHi(0); input.current?.focus();
      } finally { setLoading(false); }
      return;
    }
    onClose();
    i.run?.();
  };

  return (
    <motion.div
      ref={box}
      className="menu"
      role="menu"
      layout
      style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: x, top: y, visibility: 'hidden' }}
      initial={{ opacity: 0, scale: 0.92, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: snap }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
      transition={snap}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { if (level) back(); else onClose(); }
        else if (e.key === 'ArrowLeft' && level && !q) back();
        else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % actionable.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + actionable.length) % actionable.length); }
        else if ((e.key === 'Enter' || (e.key === 'ArrowRight' && actionable[hi]?.sub)) && actionable[hi]) { e.preventDefault(); void run(actionable[hi]); }
      }}
    >
      <label className="menu-search">
        <Search size={14} aria-hidden />
        <input ref={input} autoFocus placeholder="Type to filter…" aria-label="Filter actions" value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} />
      </label>
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.div
          key={stack.length}
          custom={dir}
          variants={{
            enter: (d: number) => ({ x: d * 28, opacity: 0 }),
            center: { x: 0, opacity: 1, transition: { ...snap, staggerChildren: 0.012 } },
            leave: (d: number) => ({ x: d * -28, opacity: 0, transition: { duration: 0.12 } }),
          }}
          initial={stack.length || q ? 'enter' : 'center'}
          animate="center"
          exit="leave"
        >
          {level && (
            <button className="menu-item menu-back" onClick={back}>
              <span className="menu-icon"><ChevronLeft size={15} /></span>
              <span className="menu-label">{level.title}</span>
            </button>
          )}
          {loading && <div className="menu-empty">Loading…</div>}
          {shown.map((i, n) =>
            i === 'sep' ? (
              <div key={`s${n}`} className="menu-sep" role="separator" />
            ) : (
              <motion.button
                key={`${i.label}${n}`}
                variants={{ enter: { opacity: 0, y: -3 }, center: { opacity: 1, y: 0 } }}
                role={i.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={i.checked}
                aria-haspopup={i.sub ? 'menu' : undefined}
                className={`menu-item${i.danger ? ' danger' : ''}${actionable[hi] === i ? ' hi' : ''}`}
                disabled={i.disabled}
                onMouseEnter={() => setHi(actionable.indexOf(i))}
                onClick={() => void run(i)}
              >
                {actionable[hi] === i && <motion.span layoutId="menu-hi" className="menu-hi-bg" transition={snap} />}
                <span className="menu-icon">{i.icon}</span>
                <span className="menu-label">{i.label}</span>
                {i.checked && <Check size={14} className="menu-check" aria-hidden />}
                {i.shortcut && <kbd>{i.shortcut}</kbd>}
                {i.sub && <ChevronRight size={14} className="menu-chev" aria-hidden />}
              </motion.button>
            ),
          )}
          {q && actionable.length === 0 && <div className="menu-empty">No matching actions</div>}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
