import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { motion } from 'motion/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { bgEditor, setSetting, settings, toast, type Settings as S } from './store';
import { Segmented } from './Settings';

type Look = Pick<S, 'bgImage' | 'bgOpacity' | 'bgBlur' | 'bgZoom' | 'bgX' | 'bgY' | 'bgFit'>;
const KEYS = ['bgImage', 'bgOpacity', 'bgBlur', 'bgZoom', 'bgX', 'bgY', 'bgFit'] as const;

/** The picture itself, cropped by zoom + focal point. Used behind the panes and in the editor preview. */
export function BgLayer({ s, preview = false }: { s: Look; preview?: boolean }) {
  const whole = s.bgFit === 'whole';
  return (
    <div className={preview ? 'bg-frame-img' : 'app-bg'} aria-hidden style={{ opacity: preview ? 1 : s.bgOpacity }}>
      <img src={`${convertFileSrc(s.bgImage, 'thumb')}?k=f&m=0`} alt="" draggable={false} style={{
        objectFit: whole ? 'contain' : 'cover',
        objectPosition: `${s.bgX}% ${s.bgY}%`,
        transformOrigin: `${s.bgX}% ${s.bgY}%`,
        // Blur leaves soft see-through edges; a little extra zoom hides them.
        transform: `scale(${(whole ? 1 : s.bgZoom) * (s.bgBlur ? 1.06 : 1)})`,
        filter: s.bgBlur ? `blur(${s.bgBlur}px)` : undefined,
      }} />
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Crop and tune a background picture. Changes show live behind the dialog; Cancel puts everything back. */
export function BgEditor({ path, ratio }: { path: string; ratio: number }) {
  const before = useRef<Look>(Object.fromEntries(KEYS.map((k) => [k, settings.get()[k]])) as Look);
  const st = settings.use();
  const drag = useRef<{ x: number; y: number; bx: number; by: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (st.bgImage !== path) {
      // A new picture starts centred and un-zoomed, at a strength that keeps file names readable.
      settings.set((s) => ({ ...s, bgImage: path, bgZoom: 1, bgX: 50, bgY: 50, bgFit: 'fill', bgOpacity: Math.min(s.bgOpacity, 0.35) }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => bgEditor.set(null);
  const cancel = () => { settings.set((s) => ({ ...s, ...before.current })); close(); };
  const done = () => { close(); if (before.current.bgImage !== path) toast('Background set'); };
  const reset = () => settings.set((s) => ({ ...s, bgZoom: 1, bgX: 50, bgY: 50, bgFit: 'fill', bgOpacity: 0.25, bgBlur: 0 }));

  const W = 520, H = Math.round(W / ratio);
  const down = (e: RPointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, bx: st.bgX, by: st.bgY };
    setDragging(true);
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Dragging the picture right shows more of its left side; the more it's zoomed, the finer the move.
    const k = 100 / Math.max(1, st.bgZoom) / 1.5;
    setSetting('bgX', clamp(d.bx - ((e.clientX - d.x) / W) * k * 1.5, 0, 100));
    setSetting('bgY', clamp(d.by - ((e.clientY - d.y) / H) * k * 1.5, 0, 100));
  };
  const up = () => { drag.current = null; setDragging(false); };

  const slider = (label: string, key: 'bgZoom' | 'bgOpacity' | 'bgBlur', min: number, max: number, step: number, show: (v: number) => string, disabled = false) => (
    <label className={`bg-row${disabled ? ' is-disabled' : ''}`}>
      <span>{label}</span>
      <input type="range" className="slider" min={min} max={max} step={step} value={st[key]} disabled={disabled} aria-label={label}
        style={{ ['--fill' as string]: `${((st[key] - min) / (max - min)) * 100}%` }} onChange={(e) => setSetting(key, +e.target.value)} />
      <span className="slider-val">{show(st[key])}</span>
    </label>
  );

  return (
    <motion.div className="modal-backdrop bg-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <motion.div className="modal bg-editor" role="dialog" aria-modal aria-labelledby="bg-title"
        initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); if (e.key === 'Enter') done(); }}>
        <h3 id="bg-title">Background picture</h3>
        <p className="muted small">{st.bgFit === 'fill' ? 'Drag the picture to choose what shows. Zoom to crop in closer.' : 'The whole picture is shown, with space around it if the shapes differ.'}</p>
        <div className={`bg-frame${dragging ? ' is-dragging' : ''}${st.bgFit === 'fill' ? ' can-drag' : ''}`} style={{ width: W, height: H }}
          onPointerDown={st.bgFit === 'fill' ? down : undefined} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onWheel={(e) => st.bgFit === 'fill' && setSetting('bgZoom', clamp(+(st.bgZoom - e.deltaY / 800).toFixed(2), 1, 3))}>
          <BgLayer s={st} preview />
          <div className="bg-frame-grid" aria-hidden />
        </div>
        <div className="bg-controls">
          <label className="bg-row"><span>Fit</span>
            <Segmented id="bgfit" value={st.bgFit} onChange={(v) => setSetting('bgFit', v)} options={[{ v: 'fill', label: 'Fill & crop' }, { v: 'whole', label: 'Whole picture' }]} />
          </label>
          {slider('Zoom', 'bgZoom', 1, 3, 0.01, (v) => `${Math.round(v * 100)}%`, st.bgFit === 'whole')}
          {slider('Strength', 'bgOpacity', 0.04, 0.6, 0.01, (v) => `${Math.round(v * 100)}%`)}
          {slider('Blur', 'bgBlur', 0, 40, 1, (v) => `${v}px`)}
        </div>
        <div className="confirm-buttons bg-buttons">
          <button className="btn" onClick={reset}>Reset</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className="btn primary" autoFocus onClick={done}>Done</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
