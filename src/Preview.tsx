// Preview pane (beside each pane's file list, Alt+P) and Quick Look (Space).
// One small component per kind of file, picked by extension (previewKinds.ts). Rust does all file reads:
// text and zips through bounded commands, PDF/media/fonts through the raw:// protocol (Range-chunked), images
// through thumb:?k=f. Nothing previewed can run code: text is rendered as React text, the PDF frame can only
// load application/pdf (raw serves no HTML/SVG), and media/fonts are passive.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, Files, Music, Pause, Play, X } from 'lucide-react';
import {
  baseName, dirCount, displayName, fmtDate, fmtSize, imageUrl, joinPath, kindOf, previewText, previewZip, rawUrl, type Entry, type TextPreview as TextData, type ZipListing,
} from './api';
import { FileIcon, FolderIcon } from './icons';
import { extOf, highlight, previewKind, type PreviewKind } from './previewKinds';
import { memory, setSetting, settings } from './store';

/** What the file list reports: the focused item and the selected ones (names are absolute in search/virtual lists). */
export interface PreviewTarget { dir: string; focused: Entry | null; selected: Entry[] }
/** Width while the divider is being dragged (the page beside it follows live); saved to settings on release. */
export const previewDrag = memory<number | null>(null);
const MIN_W = 220, MAX_W = 900;

type Row = [label: string, value: string];
type KindProps = { path: string; entry: Entry; onMeta: (rows: Row[]) => void };

const fmtDur = (s: number) => {
  if (!Number.isFinite(s)) return '';
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// ---- one component per kind ----
function ImagePreview({ path, entry, onMeta }: KindProps) {
  const src = useMemo(() => imageUrl(path, entry.modified), [path, entry.modified]);
  const [bad, setBad] = useState(false);
  if (bad) return <OtherPreview path={path} entry={entry} onMeta={onMeta} />;
  return <img className="pv-media" src={src} alt="" draggable={false} onError={() => setBad(true)}
    onLoad={(e) => onMeta([['Dimensions', `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`]])} />;
}

/** SVG as a picture. Loaded into an <img> from a data: URL, where scripts inside the SVG never run. */
function SvgPreview(p: KindProps) {
  const [code, setCode] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    let alive = true;
    previewText(p.path).then((d) => { if (!alive) return; if (d.binary || d.truncated) setBad(true); else setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.text)}`); }, () => alive && setBad(true));
    return () => { alive = false; };
  }, [p.path]);
  if (code || bad) return <TextPreview {...p} />;
  return (
    <div className="pv-svg">
      {url ? <img className="pv-media" src={url} alt="" draggable={false} onError={() => setBad(true)}
        onLoad={(e) => p.onMeta([['Dimensions', `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`]])} /> : <span className="spinner" aria-label="Loading" />}
      <button className="btn small pv-svg-code" onClick={() => setCode(true)}>Show code</button>
    </div>
  );
}

function TextPreview({ path, entry, onMeta }: KindProps) {
  const [data, setData] = useState<TextData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    previewText(path).then((d) => alive && setData(d), (e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [path]);
  const lines = useMemo(() => (data && !data.binary ? highlight(data.text, extOf(path)) : []), [data, path]);
  useEffect(() => { if (data && !data.binary) onMeta([['Lines', `${lines.length.toLocaleString()}${data.truncated ? '+' : ''}`]]); }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="pv-note">{error}</p>;
  if (!data) return <span className="spinner" aria-label="Loading" />;
  if (data.binary) return <OtherPreview path={path} entry={entry} onMeta={onMeta} />;
  return (
    <div className="pv-text">
      <pre className="pv-code" tabIndex={0} aria-label={`Contents of ${baseName(path)}`}>
        {lines.map((l, i) => <div key={i} className="ln">{l.map(([c, t], j) => (c ? <span key={j} className={`t-${c}`}>{t}</span> : t))}</div>)}
      </pre>
      {data.truncated && <p className="pv-note">Showing the first 256 KB</p>}
    </div>
  );
}

function PdfPreview({ path, entry }: KindProps) {
  // No `sandbox`: Chromium refuses to run its PDF viewer in a sandboxed frame. raw:// serves this URL only as
  // application/pdf (nosniff) and CSP frame-src allows nothing but raw://, so no page or script can load here.
  return <iframe className="pv-frame" src={rawUrl(path, entry.modified)} title={`PDF: ${baseName(path)}`} />;
}

function VideoPreview({ path, entry, onMeta }: KindProps) {
  const [bad, setBad] = useState(false);
  if (bad) return <OtherPreview path={path} entry={entry} onMeta={onMeta} note="This video format can’t be played here" />;
  return (
    <video className="pv-media" src={rawUrl(path, entry.modified)} controls preload="metadata" onError={() => setBad(true)}
      onLoadedMetadata={(e) => { const v = e.currentTarget; onMeta([['Dimensions', `${v.videoWidth} × ${v.videoHeight}`], ['Duration', fmtDur(v.duration)]]); }} />
  );
}

/** Delta's own player (no browser controls): cover art from Windows when the file has it, play/pause, seek. */
function AudioPreview({ path, entry, onMeta }: KindProps) {
  const el = useRef<HTMLAudioElement>(null);
  const [bad, setBad] = useState(false);
  const [art, setArt] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const toggle = () => { const a = el.current; if (a) void (a.paused ? a.play() : a.pause()); };
  const pct = dur ? (t / dur) * 100 : 0;
  return (
    <div className="pv-player">
      <div className="pv-cover">
        {art
          ? <img src={`${convertFileSrc(path, 'thumb')}?s=256&k=t&m=${entry.modified}`} alt="" draggable={false} onError={() => setArt(false)} />
          : <Music size={56} strokeWidth={1.4} aria-hidden />}
      </div>
      <div className="pv-track" title={entry.name}>{entry.name.replace(/\.[^.]+$/, '')}</div>
      {bad ? <p className="pv-note">This audio format can’t be played here</p> : <>
        <audio ref={el} src={rawUrl(path, entry.modified)} preload="metadata" onError={() => setBad(true)}
          onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); onMeta([['Duration', fmtDur(e.currentTarget.duration)]]); }}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
        <input type="range" className="slider pv-seek" min={0} max={dur || 1} step={0.1} value={t} aria-label="Position"
          style={{ ['--fill' as string]: `${pct}%` }} onChange={(e) => { const a = el.current; if (a) a.currentTime = +e.target.value; setT(+e.target.value); }} />
        <div className="pv-times muted"><span>{fmtDur(t)}</span><span>{dur ? fmtDur(dur) : '–:––'}</span></div>
        <button className="pv-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
      </>}
    </div>
  );
}

let fontSeq = 0;
function FontPreview({ path, entry, onMeta }: KindProps) {
  const [family, setFamily] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const f = new FontFace(`delta-preview-${++fontSeq}`, `url("${rawUrl(path, entry.modified)}")`);
    let alive = true;
    f.load().then(() => { if (!alive) return; document.fonts.add(f); setFamily(f.family); }, () => alive && setBad(true));
    return () => { alive = false; document.fonts.delete(f); };
  }, [path, entry.modified]);
  if (bad) return <OtherPreview path={path} entry={entry} onMeta={onMeta} note="This font couldn’t be read" />;
  if (!family) return <span className="spinner" aria-label="Loading" />;
  return (
    <div className="pv-font" style={{ fontFamily: `"${family}"` }}>
      <div className="pv-font-big">Aa Gg</div>
      <div>ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>
      <div>abcdefghijklmnopqrstuvwxyz</div>
      <div>0123456789 &amp;!?.,;:()</div>
      {[14, 20, 32].map((px) => <div key={px} style={{ fontSize: px }}>The quick brown fox jumps over the lazy dog</div>)}
    </div>
  );
}

const ZIP_SHOWN = 1000;
function ZipPreview({ path, onMeta }: KindProps) {
  const [z, setZ] = useState<ZipListing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    previewZip(path).then((r) => {
      if (!alive) return;
      setZ(r);
      onMeta([['Contains', `${r.total.toLocaleString()} items`], ['Unpacked', fmtSize(r.entries.reduce((n, e) => n + e.size, 0)) + (r.total > r.entries.length ? '+' : '')]]);
    }, (e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="pv-note">Couldn’t read this archive: {error}</p>;
  if (!z) return <span className="spinner" aria-label="Loading" />;
  return (
    <div className="pv-zip" role="list" aria-label="Archive contents" tabIndex={0}>
      {z.entries.slice(0, ZIP_SHOWN).map((e, i) => (
        <div key={i} className="pv-zip-row" role="listitem">
          {e.isDir ? <FolderIcon size={16} /> : <FileIcon name={e.name} size={16} />}
          <span className="pv-zip-name" title={e.name}>{e.name}</span>
          <span className="muted num">{e.isDir ? '' : fmtSize(e.size)}</span>
        </div>
      ))}
      {z.total > ZIP_SHOWN && <p className="pv-note">and {(z.total - ZIP_SHOWN).toLocaleString()} more</p>}
    </div>
  );
}

/** Anything else: the Windows shell thumbnail if it has one (PSD, HEIC, MKV, Office...), else the Delta file icon. */
function OtherPreview({ path, entry, note }: KindProps & { note?: string }) {
  const [bad, setBad] = useState(false);
  return (
    <div className="pv-other">
      {entry.isDir ? <FolderIcon size={128} /> : bad
        ? <FileIcon name={entry.name} size={128} />
        : <img className="pv-thumb" src={`${convertFileSrc(path, 'thumb')}?s=256&k=t&m=${entry.modified}`} alt="" draggable={false} onError={() => setBad(true)} />}
      {note && <p className="pv-note">{note}</p>}
    </div>
  );
}

const HANDLERS: Record<PreviewKind, (p: KindProps) => ReactNode> = {
  image: ImagePreview, svg: SvgPreview, text: TextPreview, pdf: PdfPreview, video: VideoPreview, audio: AudioPreview, font: FontPreview, zip: ZipPreview, other: OtherPreview,
};

/** The visual for one item plus its key facts. */
export function PreviewBody({ path, entry }: { path: string; entry: Entry }) {
  const [meta, setMeta] = useState<Row[]>([]);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!entry.isDir) return;
    let alive = true;
    dirCount(path).then((n) => alive && setCount(n), () => {});
    return () => { alive = false; };
  }, [path, entry.isDir]);
  const st = settings.use();
  const name = baseName(entry.name);
  const H = entry.isDir ? OtherPreview : HANDLERS[previewKind(name)];
  const rows: Row[] = [
    ['Type', kindOf({ ...entry, name })],
    ...(entry.isDir ? (count === null ? [] : [['Items', count.toLocaleString()] as Row]) : [['Size', `${fmtSize(entry.size)}${entry.size >= 1024 ? ` (${entry.size.toLocaleString()} bytes)` : ''}`] as Row]),
    ['Modified', fmtDate(entry.modified)],
    ...meta,
  ];
  return (
    <>
      <div className="pv-visual"><H key={path} path={path} entry={entry} onMeta={setMeta} /></div>
      <div className="pv-info">
        <h3 className="pv-name" title={name}>{displayName(name, entry.isDir, st.showExtensions)}</h3>
        <dl>{rows.map(([k, v]) => v && <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </>
  );
}


export function PreviewPane({ target, folderTotal }: { target: PreviewTarget; folderTotal: number }) {
  const st = settings.use();
  const drag = previewDrag.use();
  // Arrowing through a folder fires many changes; only preview where the selection settles.
  const [shown, setShown] = useState(target);
  useEffect(() => { const t = setTimeout(() => setShown(target), 120); return () => clearTimeout(t); }, [target]);
  const width = drag ?? st.previewWidth;
  const clamp = (w: number) => Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));

  const startDrag = (m: React.MouseEvent) => {
    if (m.button !== 0) return;
    m.preventDefault();
    const x0 = m.clientX, w0 = width;
    let w = w0;
    const move = (e: MouseEvent) => { w = clamp(w0 + x0 - e.clientX); previewDrag.set(w); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); setSetting('previewWidth', w); previewDrag.set(null); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
  const onHandleKey = (k: React.KeyboardEvent) => {
    const d = { ArrowLeft: 24, ArrowRight: -24 }[k.key];
    if (d) { k.preventDefault(); setSetting('previewWidth', clamp(width + d)); }
  };

  const sel = shown.selected;
  const one = sel.length === 1 ? sel[0] : sel.length === 0 ? shown.focused : null;
  let body: ReactNode;
  if (one) body = <PreviewBody key={joinPath(shown.dir, one.name)} path={joinPath(shown.dir, one.name)} entry={one} />;
  else if (sel.length > 1) {
    const files = sel.filter((e) => !e.isDir);
    body = (
      <>
        <div className="pv-visual"><div className="pv-other"><Files size={96} strokeWidth={1.1} aria-hidden /></div></div>
        <div className="pv-info">
          <h3 className="pv-name">{sel.length.toLocaleString()} items selected</h3>
          <dl>
            <div><dt>Total size</dt><dd>{fmtSize(files.reduce((n, e) => n + e.size, 0))}</dd></div>
            {files.length < sel.length && <div><dt>Folders</dt><dd>{(sel.length - files.length).toLocaleString()} (size not counted)</dd></div>}
          </dl>
        </div>
      </>
    );
  } else body = <div className="pv-empty muted">{shown.dir ? `${folderTotal.toLocaleString()} items. Select a file to preview it.` : 'Select a file to preview it.'}</div>;

  return (
    <aside className={`preview-pane${drag !== null ? ' dragging' : ''}`} aria-label="Preview">
      <div className="pv-resize" role="separator" aria-orientation="vertical" aria-label="Resize preview" tabIndex={0}
        aria-valuenow={width} aria-valuemin={MIN_W} aria-valuemax={MAX_W} onMouseDown={startDrag} onKeyDown={onHandleKey} />
      <header className="pv-head">
        <span>Preview</span>
        <button className="icon-btn small" aria-label="Close preview (Alt+P)" title="Close preview (Alt+P)" onClick={() => setSetting('previewPane', false)}><X size={14} /></button>
      </header>
      <div className="pv-scroll">{body}</div>
    </aside>
  );
}

/** Space: a big preview over everything. Space/Esc close it, arrow keys step through the list. */
export function QuickLook({ path, entry, index, total, onStep, onClose }: {
  path: string; entry: Entry | undefined; index: number; total: number; onStep: (d: number) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const onKey = (k: React.KeyboardEvent) => {
    k.stopPropagation(); // the list and app shortcuts stay quiet while this is open
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[k.key];
    if (k.key === ' ' || k.key === 'Escape') { k.preventDefault(); onClose(); }
    else if (d) { k.preventDefault(); onStep(d); box.current?.focus(); }
  };
  const name = entry ? baseName(entry.name) : '';
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div ref={box} className="modal quicklook" role="dialog" aria-modal aria-label={`Quick Look: ${name}`} tabIndex={-1} onKeyDown={onKey}
        initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}>
        <header className="ql-head">
          <button className="icon-btn" aria-label="Previous (←)" title="Previous (←)" disabled={index <= 0} onClick={() => onStep(-1)}><ChevronLeft size={17} /></button>
          <span className="ql-pos muted">{total ? `${index + 1} of ${total.toLocaleString()}` : ''}</span>
          <button className="icon-btn" aria-label="Next (→)" title="Next (→)" disabled={index >= total - 1} onClick={() => onStep(1)}><ChevronRight size={17} /></button>
          <span className="ql-title" title={name}>{name}</span>
          <button className="icon-btn" aria-label="Close (Space or Esc)" title="Close (Space or Esc)" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="ql-body">{entry ? <PreviewBody key={path} path={path} entry={entry} /> : <span className="spinner" aria-label="Loading" />}</div>
      </motion.div>
    </motion.div>
  );
}
