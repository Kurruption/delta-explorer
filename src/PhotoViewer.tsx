import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { glide } from './motion';
import { ChevronLeft, ChevronRight, Crop, Maximize, Minimize, Pencil, RotateCcw, RotateCw, Save, Scan, Undo2, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { undoable } from './store';
import { baseName, imageUrl, joinPath, listDir, revertReplace, SAVABLE, saveImage, VIEWABLE, type SortKey } from './api';

type Tool = 'none' | 'crop' | 'pencil';
type Rect = { x: number; y: number; w: number; h: number };
type Ask = { text: string; buttons: { label: string; primary?: boolean; run: () => void }[] } | null;

const COLORS = ['#8B83FF', '#FF4D5E', '#FFD43B', '#2BD9A0', '#FFFFFF', '#111111'];
const MAX_UNDO = 15;
const mimeFor = (p: string) => (/\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg');
const cloneCanvas = (c: HTMLCanvasElement) => { const n = document.createElement('canvas'); n.width = c.width; n.height = c.height; n.getContext('2d')!.drawImage(c, 0, 0); return n; };

/**
 * Delta Viewer: a small built-in photo viewer. View, zoom, pan, next/previous in the folder,
 * and a few honest edits: rotate, crop, pencil, undo, save (replace or copy).
 */
export function PhotoViewer({ path, dir, from, sort, desc, showHidden, onClose, onError }: {
  path: string; dir: string; from?: DOMRect; sort: SortKey; desc: boolean; showHidden: boolean; onClose: () => void; onError: (e: unknown) => void;
}) {
  const [list, setList] = useState<string[]>([path]);
  const [cur, setCur] = useState(path);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('none');
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(6);
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const [crop, setCrop] = useState<Rect | null>(null);
  const [dirty, setDirty] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const [note, setNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bumps after every pixel change, triggers a redraw
  const work = useRef<HTMLCanvasElement | null>(null); // the image being edited, full resolution
  const history = useRef<HTMLCanvasElement[]>([]);
  const display = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'pan' | 'pen' | 'crop'; x: number; y: number; ix: number; iy: number } | null>(null);

  // Sibling images, in the folder's current order, for next/previous.
  useEffect(() => {
    let stop = false;
    (async () => {
      const names: string[] = [];
      for (let off = 0; ; off += 1000) {
        const p = await listDir(dir, off, 1000, { sort, desc, showHidden });
        names.push(...p.entries.filter((e) => !e.isDir && VIEWABLE.test(e.name)).map((e) => joinPath(p.path, e.name)));
        if (off + 1000 >= p.total) break;
      }
      if (!stop && names.length) setList(names);
    })().catch(() => { /* keep single-image mode */ });
    return () => { stop = true; };
  }, [dir, sort, desc, showHidden]);

  const fit = useCallback(() => {
    const st = stage.current, w = work.current;
    if (!st || !w) return;
    const s = Math.min(st.clientWidth / w.width, st.clientHeight / w.height, 1);
    setView({ s, tx: (st.clientWidth - w.width * s) / 2, ty: (st.clientHeight - w.height * s) / 2 });
  }, []);

  // Load the current image into the work canvas.
  useEffect(() => {
    let stop = false;
    setLoaded(false); setFailed(null); setCrop(null); setTool('none'); setDirty(false); history.current = [];
    const img = new Image();
    img.crossOrigin = 'anonymous'; // served by thumb://, must not taint the canvas or saving is blocked
    img.src = imageUrl(cur);
    img.decode().then(() => {
      if (stop) return;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      work.current = c;
      setLoaded(true);
      fit();
      setVersion((v) => v + 1);
      // Switching photos: the new one slides in from the side you moved towards.
      if (swapDir.current) {
        display.current?.animate(
          [{ opacity: 0, transform: `translateX(${swapDir.current * 40}px) scale(.98)` }, { opacity: 1, transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' },
        );
        swapDir.current = 0;
      }
    }, () => !stop && setFailed(`Can't display ${baseName(cur)}`));
    return () => { stop = true; };
  }, [cur, fit]);

  // Draw: the image with the view transform, plus the crop overlay.
  useEffect(() => {
    const cv = display.current, st = stage.current, w = work.current;
    if (!cv || !st) return;
    const dpr = devicePixelRatio || 1;
    cv.width = st.clientWidth * dpr; cv.height = st.clientHeight * dpr;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, st.clientWidth, st.clientHeight);
    if (!w || !loaded) return;
    g.imageSmoothingQuality = 'high';
    g.drawImage(w, view.tx, view.ty, w.width * view.s, w.height * view.s);
    if (tool === 'crop' && crop) {
      const r = { x: view.tx + crop.x * view.s, y: view.ty + crop.y * view.s, w: crop.w * view.s, h: crop.h * view.s };
      g.fillStyle = 'rgb(0 0 0 / .55)';
      g.beginPath(); g.rect(0, 0, st.clientWidth, st.clientHeight); g.rect(r.x, r.y, r.w, r.h); g.fill('evenodd');
      g.strokeStyle = '#B4ACFF'; g.lineWidth = 2; g.strokeRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = 'rgb(255 255 255 / .35)'; g.lineWidth = 1; // rule of thirds
      for (const f of [1 / 3, 2 / 3]) {
        g.beginPath(); g.moveTo(r.x + r.w * f, r.y); g.lineTo(r.x + r.w * f, r.y + r.h); g.moveTo(r.x, r.y + r.h * f); g.lineTo(r.x + r.w, r.y + r.h * f); g.stroke();
      }
    }
  }, [view, crop, tool, loaded, version]);

  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const ro = new ResizeObserver(() => { fit(); setVersion((v) => v + 1); });
    ro.observe(st);
    return () => ro.disconnect();
  }, [fit]);

  // ---- edits ----
  const snapshot = () => {
    if (!work.current) return;
    history.current.push(cloneCanvas(work.current));
    if (history.current.length > MAX_UNDO) history.current.shift();
    setDirty(true);
  };
  const undo = () => {
    const prev = history.current.pop();
    if (!prev) return;
    work.current = prev;
    setDirty(history.current.length > 0);
    fit();
    setVersion((v) => v + 1);
  };
  const rotate = (dir: 1 | -1) => {
    const w = work.current;
    if (!w) return;
    snapshot();
    const c = document.createElement('canvas');
    c.width = w.height; c.height = w.width;
    const g = c.getContext('2d')!;
    g.translate(c.width / 2, c.height / 2); g.rotate((dir * Math.PI) / 2); g.drawImage(w, -w.width / 2, -w.height / 2);
    g.setTransform(1, 0, 0, 1, 0, 0); // later pencil strokes use this same context
    work.current = c;
    fit();
    setVersion((v) => v + 1);
  };
  const applyCrop = () => {
    const w = work.current;
    if (!w || !crop || crop.w < 2 || crop.h < 2) { setTool('none'); setCrop(null); return; }
    snapshot();
    const c = document.createElement('canvas');
    c.width = Math.round(crop.w); c.height = Math.round(crop.h);
    c.getContext('2d')!.drawImage(w, Math.round(crop.x), Math.round(crop.y), c.width, c.height, 0, 0, c.width, c.height);
    work.current = c;
    setCrop(null); setTool('none');
    fit();
    setVersion((v) => v + 1);
  };

  // ---- saving ----
  const doSave = async (mode: 'overwrite' | 'copy') => {
    const w = work.current;
    if (!w) return;
    setAsk(null);
    // GIF/BMP/AVIF/ICO can't be written by the browser: those always save as a PNG copy.
    const target = SAVABLE.test(cur) ? cur : cur.replace(/\.[^.\\]+$/, '.png');
    const blob = await new Promise<Blob | null>((res) => w.toBlob(res, mimeFor(target), 0.92));
    if (!blob) return onError('Could not encode the image');
    try {
      const written = await saveImage(target, blob, SAVABLE.test(cur) ? mode : 'copy');
      history.current = [];
      setDirty(false);
      if (mode === 'copy' || !SAVABLE.test(cur)) setNote(`Saved as ${baseName(written)}`);
      else {
        // The original went to the Recycle Bin (Rust does that before replacing), so this is fully undoable.
        const file = cur;
        undoable(
          { label: `Replace ${baseName(file)}`, run: () => revertReplace(file).then((edited) => { setNote(`Original restored · your edit is ${baseName(edited)}`); setCur(file); }) },
          `Replaced ${baseName(file)} · the original is in the Recycle Bin`,
        );
      }
    } catch (e) { onError(e); }
  };
  const save = () => {
    if (!dirty) return;
    if (!SAVABLE.test(cur)) return void doSave('copy');
    setAsk({
      text: `Replace ${baseName(cur)}? The original goes to the Recycle Bin, so you can undo this.`,
      buttons: [
        { label: 'Save as copy', primary: true, run: () => doSave('copy') },
        { label: 'Replace original', run: () => doSave('overwrite') },
        { label: 'Cancel', run: () => setAsk(null) },
      ],
    });
  };
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 2500); return () => clearTimeout(t); }, [note]);

  // ---- navigation (asks before throwing away edits) ----
  const guard = (then: () => void) => {
    if (!dirty) return then();
    setAsk({ text: 'Discard your changes to this photo?', buttons: [{ label: 'Discard', primary: true, run: () => { setAsk(null); then(); } }, { label: 'Keep editing', run: () => setAsk(null) }] });
  };
  const idx = list.indexOf(cur);
  const swapDir = useRef(0);
  const step = (d: number) => list.length > 1 && guard(() => { swapDir.current = d; setCur(list[(idx + d + list.length) % list.length]); });
  // Full screen: the window goes full screen and the viewer covers the title bar too.
  const [full, setFull] = useState(false);
  const toggleFull = async () => {
    const w = getCurrentWindow();
    const next = !(await w.isFullscreen());
    await w.setFullscreen(next);
    setFull(next);
  };
  const leaveFull = () => full && getCurrentWindow().setFullscreen(false).then(() => setFull(false));
  useEffect(() => () => { getCurrentWindow().setFullscreen(false); }, []); // never leave the window stuck full screen
  useEffect(() => { const t = setTimeout(() => { fit(); setVersion((v) => v + 1); }, 220); return () => clearTimeout(t); }, [full, fit]);
  const close = () => guard(() => { leaveFull(); onClose(); });

  // ---- pointer ----
  const toImage = (x: number, y: number) => ({ ix: (x - view.tx) / view.s, iy: (y - view.ty) / view.s });
  const local = (e: React.PointerEvent) => { const r = display.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.PointerEvent) => {
    if (!loaded || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    const { ix, iy } = toImage(x, y);
    if (tool === 'pencil') {
      snapshot();
      const g = work.current!.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.strokeStyle = color; g.fillStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
      g.lineWidth = size / view.s; // constant thickness on screen, whatever the zoom
      g.beginPath(); g.arc(ix, iy, g.lineWidth / 2, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(ix, iy);
      drag.current = { kind: 'pen', x, y, ix, iy };
      setVersion((v) => v + 1);
    } else if (tool === 'crop') {
      drag.current = { kind: 'crop', x, y, ix, iy };
      setCrop({ x: ix, y: iy, w: 0, h: 0 });
    } else {
      drag.current = { kind: 'pan', x, y, ix: view.tx, iy: view.ty };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, w = work.current;
    if (!d || !w) return;
    const { x, y } = local(e);
    if (d.kind === 'pan') setView((v) => ({ ...v, tx: d.ix + x - d.x, ty: d.iy + y - d.y }));
    else if (d.kind === 'pen') {
      const { ix, iy } = toImage(x, y);
      const g = w.getContext('2d')!;
      g.lineTo(ix, iy); g.stroke(); g.beginPath(); g.moveTo(ix, iy);
      setVersion((v) => v + 1);
    } else {
      const p = toImage(x, y);
      const cx = Math.max(0, Math.min(w.width, p.ix)), cy = Math.max(0, Math.min(w.height, p.iy));
      const sx = Math.max(0, Math.min(w.width, d.ix)), sy = Math.max(0, Math.min(w.height, d.iy));
      setCrop({ x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) });
    }
  };
  const onUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => {
    if (!loaded) return;
    const r = display.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    setView((v) => {
      const s = Math.max(0.02, Math.min(32, v.s * Math.exp(-e.deltaY * 0.0015)));
      return { s, tx: mx - ((mx - v.tx) * s) / v.s, ty: my - ((my - v.ty) * s) / v.s };
    });
  };
  const zoomTo1 = () => {
    const st = stage.current, w = work.current;
    if (!st || !w) return;
    setView({ s: 1, tx: (st.clientWidth - w.width) / 2, ty: (st.clientHeight - w.height) / 2 });
  };

  // ---- keys ----
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if ((k.target as HTMLElement).matches('input')) { k.stopImmediatePropagation(); return; }
      const ctrl = k.ctrlKey || k.metaKey;
      const key = k.key.toLowerCase();
      if (ask) { if (k.key === 'Escape') setAsk(null); k.stopImmediatePropagation(); return; }
      if (k.key === 'Escape') { if (tool !== 'none') { setTool('none'); setCrop(null); } else if (full) leaveFull(); else close(); }
      else if (k.key === 'F11' || (key === 'f' && !ctrl)) void toggleFull();
      else if (k.key === 'Enter' && tool === 'crop') applyCrop();
      else if (k.key === 'ArrowRight' && tool === 'none') step(1);
      else if (k.key === 'ArrowLeft' && tool === 'none') step(-1);
      else if (ctrl && key === 'z') undo();
      else if (ctrl && key === 's') { k.preventDefault(); save(); }
      else if (key === 'r' && !ctrl) rotate(k.shiftKey ? -1 : 1);
      else if (key === 'c' && !ctrl) { setTool(tool === 'crop' ? 'none' : 'crop'); setCrop(null); }
      else if (key === 'p' && !ctrl) setTool(tool === 'pencil' ? 'none' : 'pencil');
      else if (key === '0') fit();
      else if (key === '1') zoomTo1();
      else { k.stopImmediatePropagation(); return; } // nothing behind the viewer reacts (Delete must not hit the file list)
      k.preventDefault();
      k.stopImmediatePropagation();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  const w = work.current;
  const toolBtn = (t: Tool, label: string, icon: React.ReactNode, key: string) => (
    <button className="icon-btn" aria-label={`${label} (${key})`} title={`${label} (${key})`} aria-pressed={tool === t} disabled={!loaded}
      onClick={() => { setTool(tool === t ? 'none' : t); setCrop(null); }}>{icon}</button>
  );

  // Opens by growing out of the thumbnail that was clicked, and shrinks back on close.
  const origin = from
    ? { x: from.left + from.width / 2 - innerWidth / 2, y: from.top + from.height / 2 - (innerHeight + 40) / 2, scale: Math.max(0.08, Math.min(0.5, from.width / 600)) }
    : { x: 0, y: 24, scale: 0.92 };

  return (
    <motion.div className={`viewer${full ? ' full' : ''}`} role="dialog" aria-label={`Delta Viewer: ${baseName(cur)}`}
      initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.2 } }} exit={{ opacity: 0, transition: { duration: 0.22, delay: 0.05 } }}>
      <header className="viewer-bar">
        <div className="viewer-title">
          <strong>{baseName(cur)}</strong>
          <span className="muted small">{list.length > 1 && `${idx + 1} / ${list.length}`}{w && loaded && ` · ${w.width} × ${w.height}`}{dirty && ' · edited'}</span>
        </div>
        <div className="viewer-tools">
          <button className="icon-btn" aria-label="Rotate left (Shift+R)" title="Rotate left (Shift+R)" disabled={!loaded} onClick={() => rotate(-1)}><RotateCcw size={17} /></button>
          <button className="icon-btn" aria-label="Rotate right (R)" title="Rotate right (R)" disabled={!loaded} onClick={() => rotate(1)}><RotateCw size={17} /></button>
          {toolBtn('crop', 'Crop', <Crop size={17} />, 'C')}
          {toolBtn('pencil', 'Pencil', <Pencil size={17} />, 'P')}
          {tool === 'pencil' && (
            <div className="pen-opts" role="group" aria-label="Pencil">
              {COLORS.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} />
              ))}
              <input type="range" min={1} max={40} value={size} aria-label="Pencil size" onChange={(e) => setSize(+e.target.value)} />
            </div>
          )}
          <span className="viewer-sep" />
          <button className="icon-btn" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!dirty} onClick={undo}><Undo2 size={17} /></button>
          <button className="icon-btn" aria-label="Fit to window (0)" title="Fit to window (0) · Actual size (1)" disabled={!loaded} onClick={fit}><Scan size={16} /></button>
          <button className="icon-btn" aria-label={full ? 'Exit full screen (F11)' : 'Full screen (F11)'} title={full ? 'Exit full screen (F11 / Esc)' : 'Full screen (F11)'} onClick={() => void toggleFull()}>
            {full ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
          <button className="btn viewer-save" disabled={!dirty} onClick={save}><Save size={15} /> Save</button>
          <button className="icon-btn" aria-label="Close viewer (Esc)" title="Close (Esc)" onClick={close}><X size={18} /></button>
        </div>
      </header>

      <motion.div className="viewer-stage" ref={stage} onWheel={onWheel}
        initial={{ ...origin, opacity: 0 }} animate={{ x: 0, y: 0, scale: 1, opacity: 1, transition: glide }} exit={{ ...origin, opacity: 0, transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } }}>
        <canvas
          ref={display}
          className={`viewer-canvas tool-${tool}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={() => tool === 'none' && (view.s < 0.999 || view.s > 1.001 ? zoomTo1() : fit())}
        />
        {!loaded && !failed && <div className="viewer-msg muted">Loading…</div>}
        {failed && <div className="viewer-msg">{failed}</div>}
        {list.length > 1 && tool === 'none' && (
          <>
            <button className="viewer-nav left" aria-label="Previous photo (←)" onClick={() => step(-1)}><ChevronLeft size={26} /></button>
            <button className="viewer-nav right" aria-label="Next photo (→)" onClick={() => step(1)}><ChevronRight size={26} /></button>
          </>
        )}
        {tool === 'crop' && (
          <div className="viewer-hint">
            <span>Drag to choose the area</span>
            <button className="btn primary" disabled={!crop || crop.w < 2} onClick={applyCrop}>Apply crop</button>
            <button className="btn" onClick={() => { setTool('none'); setCrop(null); }}>Cancel</button>
          </div>
        )}
        {ask && (
          <div className="viewer-hint" role="alertdialog">
            <span>{ask.text}</span>
            {ask.buttons.map((b) => <button key={b.label} className={`btn${b.primary ? ' primary' : ''}`} onClick={b.run}>{b.label}</button>)}
          </div>
        )}
        {note && <div className="viewer-note" role="status">{note}</div>}
      </motion.div>
    </motion.div>
  );
}
