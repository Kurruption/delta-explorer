import { useEffect, useState } from 'react';
import { CircleAlert, Plus, RotateCcw, X } from 'lucide-react';
import { ACTIONS, comboOf, conflicts, FIXED, keymap, keysOf, pretty, setKeys, type ActionId } from './keymap';

/** Settings → Shortcuts: every action, its keys, record new ones, conflicts, reset. */
export function ShortcutEditor() {
  const map = keymap.use();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [q, setQ] = useState('');
  const clash = conflicts(map);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null);
      const c = comboOf(e);
      if (!c) return; // just a modifier so far
      const cur = keysOf(recording, map);
      if (!cur.includes(c)) setKeys(recording, [...cur, c]);
      setRecording(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [recording, map]);

  const ids = (Object.keys(ACTIONS) as ActionId[]).filter((id) => !q || ACTIONS[id].label.toLowerCase().includes(q.toLowerCase()) || keysOf(id, map).some((k) => k.toLowerCase().includes(q.toLowerCase())));
  const groups = [...new Set(ids.map((id) => ACTIONS[id].group))];
  return (
    <div className="keys">
      <div className="keys-top">
        <input className="text" placeholder="Find an action or key…" aria-label="Find a shortcut" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={!Object.keys(map).length} onClick={() => keymap.set({})}><RotateCcw size={14} /> Reset all</button>
      </div>
      {clash.size > 0 && (
        <p className="key-warn" role="alert"><CircleAlert size={14} /> {clash.size === 1 ? 'One key does' : `${clash.size} keys do`} two things: {[...clash].map(([k, a]) => `${pretty(k)} (${a.map((x) => ACTIONS[x].label).join(' / ')})`).join(', ')}</p>
      )}
      {groups.map((g) => (
        <section key={g}>
          <h3>{g}</h3>
          {ids.filter((id) => ACTIONS[id].group === g).map((id) => {
            const keys = keysOf(id, map);
            return (
              <div key={id} className={`key-row${id in map ? ' changed' : ''}`}>
                <span>{ACTIONS[id].label}</span>
                <span className="key-chips">
                  {keys.map((k) => (
                    <span key={k} className={`key-chip${clash.has(k) ? ' clash' : ''}`} title={clash.has(k) ? `Also: ${clash.get(k)!.filter((x) => x !== id).map((x) => ACTIONS[x].label).join(', ')}` : undefined}>
                      <kbd>{pretty(k)}</kbd>
                      <button className="icon-btn small" aria-label={`Remove ${pretty(k)} from ${ACTIONS[id].label}`} onClick={() => setKeys(id, keys.filter((x) => x !== k))}><X size={12} /></button>
                    </span>
                  ))}
                  <button className={`btn small${recording === id ? ' primary' : ''}`} aria-label={`Add a key for ${ACTIONS[id].label}`} onClick={() => setRecording(recording === id ? null : id)}>
                    {recording === id ? 'Press keys… (Esc cancels)' : <Plus size={13} />}
                  </button>
                  {id in map && <button className="icon-btn small" aria-label={`Reset ${ACTIONS[id].label}`} title="Back to default" onClick={() => setKeys(id, ACTIONS[id].keys)}><RotateCcw size={13} /></button>}
                </span>
              </div>
            );
          })}
        </section>
      ))}
      <section>
        <h3>Fixed</h3>
        {FIXED.map(([a, k]) => <div key={a} className="key-row"><span>{a}</span><kbd>{k}</kbd></div>)}
      </section>
    </div>
  );
}
