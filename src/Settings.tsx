import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion, Reorder } from 'motion/react';
import { PanelTop, UserRound, FileCog, GripVertical, Info, Keyboard, LayoutDashboard, PanelLeft, Palette, Plug, RotateCcw, Tag, X, Sparkles } from 'lucide-react';
import { CleanerSettings } from './Cleaner';
import { integration, setAutostart, setHotkey, setWinE } from './api';
import {
  ACCENTS, applyAppearance, bgEditor, errorToast, SECTION_NAMES, setSetting, settings, tags, THEMES, toast, type SectionId, type Settings as S,
} from './store';
import { glide, snap } from './motion';
import { ShortcutEditor } from './ShortcutEditor';
import { CommandBarSettings } from './CommandBar';
import { ProfilesPanel } from './ProfilesPanel';
import icon from './assets/icon.svg';

const SECTIONS = [
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'layout', name: 'Layout', icon: LayoutDashboard },
  { id: 'files', name: 'Files & folders', icon: FileCog },
  { id: 'sidebar', name: 'Sidebar', icon: PanelLeft },
  { id: 'integration', name: 'Windows', icon: Plug },
  { id: 'cleaner', name: 'Storage cleaner', icon: Sparkles },
  { id: 'tags', name: 'Tags', icon: Tag },
  { id: 'keys', name: 'Shortcuts', icon: Keyboard },
  { id: 'cmdbar', name: 'Command bar', icon: PanelTop },
  { id: 'profiles', name: 'Profiles & backup', icon: UserRound },
  { id: 'about', name: 'About', icon: Info },
] as const;
type Sec = (typeof SECTIONS)[number]['id'];

/** Theme changes reveal in a circle from the click (View Transitions), when animations are on. */
function reveal(e: React.MouseEvent, change: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || settings.get().motion !== 'full') return change();
  const { clientX: x, clientY: y } = e;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const t = doc.startViewTransition(() => flushSync(() => { change(); applyAppearance(settings.get()); }));
  t.ready.then(() =>
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' },
    ),
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <motion.span className="knob" layout transition={snap} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, id }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)}>
          {value === o.v && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={snap} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const Row = ({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) => (
  <div className="set-row">
    <div className="set-text"><strong>{title}</strong>{desc && <span className="muted small">{desc}</span>}</div>
    <div className="set-ctl">{children}</div>
  </div>
);

/** Records a key combo like "Ctrl+Alt+E" for the global shortcut. */
function HotkeyRecorder({ value, onSave }: { value: string; onSave: (k: string) => void }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') return setRec(false);
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
      if (!mods.length) return; // a global shortcut needs a modifier
      const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code;
      setRec(false);
      onSave([...mods, key].join('+'));
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [rec, onSave]);
  return (
    <div className="hotkey">
      <button className={`btn${rec ? ' primary' : ''}`} onClick={() => setRec(!rec)}>{rec ? 'Press keys… (Esc to cancel)' : value || 'Set shortcut'}</button>
      {value && !rec && <button className="icon-btn small" aria-label="Remove shortcut" onClick={() => onSave('')}><X size={14} /></button>}
    </div>
  );
}

export function Settings({ onClose, section }: { onClose: () => void; section?: string }) {
  const st = settings.use();
  const tagList = tags.use();
  const [sec, setSec] = useState<Sec>((SECTIONS.some((s) => s.id === section) ? section : 'appearance') as Sec);
  const [integ, setInteg] = useState<{ winE: boolean; autostart: boolean } | null>(null);
  const set = <K extends keyof S>(k: K, v: S[K]) => setSetting(k, v);

  useEffect(() => { integration().then(setInteg, errorToast); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const body: Record<Sec, ReactNode> = {
    appearance: <>
      <h3>Theme</h3>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <motion.button key={t.id} className={`theme-card${st.theme === t.id ? ' sel' : ''}`} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }} transition={snap}
            onClick={(e) => reveal(e, () => set('theme', t.id))} aria-pressed={st.theme === t.id}>
            <span className="theme-preview" style={{ background: t.id === 'system' ? `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` : t.swatch[0] }}>
              <span className="tp-side" style={{ background: t.swatch[1] }} />
              <span className="tp-row" style={{ background: t.swatch[2] }} />
              <span className="tp-row dim" style={{ background: t.swatch[2] }} />
            </span>
            <strong>{t.name}</strong>
            <span className="muted small">{t.desc}</span>
            {st.theme === t.id && <motion.span layoutId="theme-sel" className="theme-ring" transition={snap} />}
          </motion.button>
        ))}
      </div>
      <h3>Accent colour</h3>
      <div className="accents">
        {ACCENTS.map((a) => (
          <motion.button key={a.id} className="accent-swatch" aria-label={a.name} title={a.name} aria-pressed={st.accent === a.id}
            style={{ background: `linear-gradient(135deg, ${a.light}, ${a.dark})` }} whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.92 }} transition={snap}
            onClick={(e) => reveal(e, () => set('accent', a.id))}>
            {st.accent === a.id && <motion.span layoutId="accent-ring" className="accent-ring" transition={snap} />}
          </motion.button>
        ))}
        {/* Any colour: the colour wheel. */}
        <label className="color-input accent-swatch" title="Pick any colour" style={st.accent.startsWith('#') ? { background: st.accent, borderStyle: 'solid' } : undefined}>
          <input type="color" aria-label="Custom accent colour" value={st.accent.startsWith('#') ? st.accent : '#8b83ff'} onChange={(e) => set('accent', e.target.value)} />
          {st.accent.startsWith('#') && <motion.span layoutId="accent-ring" className="accent-ring" transition={snap} />}
        </label>
      </div>
      <h3>Folders and icons</h3>
      <Row title="Folder colour" desc="Plain folders in Delta indigo, or in your accent colour. Right-click any folder → Folder colour to give it its own.">
        <Segmented id="ftint" value={st.folderTint} onChange={(v) => set('folderTint', v)} options={[{ v: 'delta', label: 'Delta' }, { v: 'accent', label: 'Accent' }]} />
      </Row>
      <Row title="Icon size" desc="How big items are in grid view">
        <Segmented id="isize" value={st.iconSize} onChange={(v) => set('iconSize', v)} options={[{ v: 'small', label: 'Small' }, { v: 'medium', label: 'Medium' }, { v: 'large', label: 'Large' }, { v: 'huge', label: 'Huge' }]} />
      </Row>
      <h3>Background picture</h3>
      {st.bgImage ? (
        <Row title="Picture" desc="Crop, position, strength and blur">
          <span className="bg-preview" style={{ backgroundImage: `url("${convertFileSrc(st.bgImage, 'thumb')}?k=t&s=256&m=0")` }} />
          <button className="btn small" onClick={() => { onClose(); bgEditor.set(st.bgImage); }}>Adjust…</button>
          <button className="btn small" onClick={() => set('bgImage', '')}>Remove</button>
        </Row>
      ) : <p className="muted small">Right-click any photo in Delta → <strong>Use as Delta background</strong>.</p>}
      <h3>Window</h3>
      <Row title="Window opacity" desc="See your desktop through Delta (Atlas-style). 100% is solid.">
        <input type="range" className="slider" min={35} max={100} step={1} value={Math.round(st.windowOpacity * 100)} aria-label="Window opacity"
          style={{ ['--fill' as string]: `${((st.windowOpacity * 100 - 35) / 65) * 100}%` }}
          onChange={(e) => set('windowOpacity', +e.target.value / 100)} />
        <span className="slider-val">{Math.round(st.windowOpacity * 100)}%</span>
      </Row>
      <Row title="Background effect" desc={st.windowOpacity < 1 ? 'Blur frosts what’s behind; Mica tints it with your wallpaper' : 'Lower the opacity to use an effect'}>
        <Segmented id="fx" value={st.windowEffect} onChange={(v) => set('windowEffect', v)} options={[{ v: 'acrylic', label: 'Blur' }, { v: 'mica', label: 'Mica' }]} />
      </Row>
      <h3>Layout</h3>
      <Row title="Density" desc="How tightly lists are packed">
        <Segmented id="density" value={st.density} onChange={(v) => set('density', v)} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} />
      </Row>
      <Row title="Animations" desc="Reduced keeps fades but drops movement. Off makes everything instant.">
        <Segmented id="motion" value={st.motion} onChange={(v) => set('motion', v)} options={[{ v: 'full', label: 'Full' }, { v: 'reduced', label: 'Reduced' }, { v: 'off', label: 'Off' }]} />
      </Row>
    </>,
    layout: <>
      <Row title="Tab position" desc="Top: browser-style, above the toolbar · Bottom: Dorion-style">
        <Segmented id="tabs" value={st.tabsPosition} onChange={(v) => set('tabsPosition', v)} options={[{ v: 'top', label: 'Top' }, { v: 'bottom', label: 'Bottom' }]} />
      </Row>
      <Row title="Sidebar style" desc="Rail: just icons, opens when you hover · Floating: hidden until you touch the window edge (like Zen’s compact mode)">
        <Segmented id="sidestyle" value={st.sidebarStyle} onChange={(v) => set('sidebarStyle', v)} options={[{ v: 'full', label: 'Full' }, { v: 'rail', label: 'Rail' }, { v: 'floating', label: 'Floating' }]} />
      </Row>
      <Row title="Sidebar side">
        <Segmented id="side" value={st.sidebarSide} onChange={(v) => set('sidebarSide', v)} options={[{ v: 'left', label: 'Left' }, { v: 'right', label: 'Right' }]} />
      </Row>
      <Row title="Interface size" desc="Makes everything bigger or smaller">
        <input type="range" className="slider" min={80} max={130} step={5} value={Math.round(st.uiScale * 100)} aria-label="Interface size"
          style={{ ['--fill' as string]: `${((st.uiScale * 100 - 80) / 50) * 100}%` }} onChange={(e) => set('uiScale', +e.target.value / 100)} />
        <span className="slider-val">{Math.round(st.uiScale * 100)}%</span>
      </Row>
      <Row title="Corners">
        <Segmented id="corners" value={st.corners} onChange={(v) => set('corners', v)} options={[{ v: 'sharp', label: 'Sharp' }, { v: 'soft', label: 'Soft' }, { v: 'round', label: 'Round' }]} />
      </Row>
      <Row title="Density" desc="How tightly lists are packed">
        <Segmented id="density2" value={st.density} onChange={(v) => set('density', v)} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} />
      </Row>
      <button className="btn" style={{ marginTop: 14 }} onClick={() => { set('tabsPosition', 'bottom'); set('sidebarStyle', 'full'); set('sidebarSide', 'left'); set('uiScale', 1); set('corners', 'soft'); set('density', 'comfortable'); }}>
        <RotateCcw size={14} /> Reset layout
      </button>
    </>,
    files: <>
      <Row title="Show hidden files" desc="Includes hidden and system items, shown dimmed"><Toggle label="Show hidden files" on={st.showHidden} onChange={(v) => set('showHidden', v)} /></Row>
      <Row title="Show file extensions" desc="Off: “report.pdf” shows as “report”. Shortcuts and apps never show one."><Toggle label="Show file extensions" on={st.showExtensions} onChange={(v) => set('showExtensions', v)} /></Row>
      <Row title="Open photos in Delta Viewer" desc="Off: photos open in your default Windows app"><Toggle label="Open photos in Delta Viewer" on={st.photosInViewer} onChange={(v) => set('photosInViewer', v)} /></Row>
      <Row title="Remember layout per folder" desc="Each folder keeps list or grid, like File Explorer. Off: one layout everywhere.">
        <Toggle label="Remember layout per folder" on={st.layoutPerFolder} onChange={(v) => set('layoutPerFolder', v)} />
      </Row>
      <Row title={st.layoutPerFolder ? 'Layout for folders you haven’t set' : 'Layout for every folder'}>
        <Segmented id="view" value={st.defaultView} onChange={(v) => set('defaultView', v)} options={[{ v: 'list', label: 'List' }, { v: 'grid', label: 'Grid' }, { v: 'columns', label: 'Columns' }]} />
      </Row>
      <Row title="Show folder sizes" desc="Fills the Size column for folders, worked out in the background. Right-click a folder → Calculate size works either way.">
        <Toggle label="Show folder sizes" on={st.folderSizes} onChange={(v) => set('folderSizes', v)} />
      </Row>
      <Row title="Hover info cards" desc="Resting the pointer on an item shows its type, size, dates, dimensions or length">
        <Toggle label="Hover info cards" on={st.hoverCards} onChange={(v) => set('hoverCards', v)} />
      </Row>
      <Row title="Compression" desc="Fast is several times quicker than File Explorer; Smallest squeezes harder. Photos, videos and other already-compressed files are always just stored.">
        <Segmented id="compression" value={st.compression} onChange={(v) => set('compression', v)} options={[{ v: 'fast', label: 'Fast' }, { v: 'balanced', label: 'Balanced' }, { v: 'smallest', label: 'Smallest' }]} />
      </Row>
    </>,
    integration: <>
      <Row title="Open Delta with Win+E" desc="Win+E opens Delta instead of File Explorer. Turn off any time; uninstalling also restores it.">
        <Toggle label="Open Delta with Win+E" on={!!integ?.winE} onChange={(v) => setWinE(v).then(() => integration().then(setInteg)).then(() => toast(v ? 'Win+E now opens Delta' : 'Win+E opens File Explorer again'), errorToast)} />
      </Row>
      <Row title="Start with Windows" desc="Delta opens when you sign in">
        <Toggle label="Start with Windows" on={!!integ?.autostart} onChange={(v) => setAutostart(v).then(() => integration().then(setInteg), errorToast)} />
      </Row>
      <Row title="Global shortcut" desc="Brings Delta to the front from anywhere (press again to minimize)">
        <HotkeyRecorder value={st.hotkey} onSave={(k) => setHotkey(k).then(() => { set('hotkey', k); if (k) toast(`${k} now opens Delta`); }, errorToast)} />
      </Row>
    </>,
    sidebar: <>
      <p className="muted small">Drag to reorder. Switch a section off to hide it; right-click a section title in the sidebar for quick moves.</p>
      <Reorder.Group axis="y" values={st.sectionOrder} onReorder={(v: SectionId[]) => set('sectionOrder', v)} className="reorder">
        {st.sectionOrder.map((id) => (
          <Reorder.Item key={id} value={id} className="reorder-item" whileDrag={{ scale: 1.03, boxShadow: '0 10px 28px rgb(0 0 0 / .3)' }} transition={snap}>
            <GripVertical size={16} className="muted grip" />
            <span className="reorder-name">{SECTION_NAMES[id]}</span>
            <Toggle label={`Show ${SECTION_NAMES[id]}`} on={!st.hiddenSections.includes(id)}
              onChange={(v) => set('hiddenSections', v ? st.hiddenSections.filter((x) => x !== id) : [...st.hiddenSections, id])} />
          </Reorder.Item>
        ))}
      </Reorder.Group>
      <button className="btn" onClick={() => { set('sectionOrder', ['pinned', 'places', 'cloud', 'drives', 'recent', 'tags', 'workspaces']); set('hiddenSections', []); }}>
        <RotateCcw size={14} /> Reset sidebar
      </button>
    </>,
    tags: <>
      <p className="muted small">Right-click any file or folder → Tags. Rename and recolour them here.</p>
      {tagList.map((t, i) => (
        <div key={t.id} className="tag-edit">
          <input type="color" value={t.color} aria-label={`Colour of ${t.name}`} onChange={(e) => tags.set((all) => all.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
          <input className="text" value={t.name} aria-label="Tag name" onChange={(e) => tags.set((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
        </div>
      ))}
    </>,
    keys: <ShortcutEditor />,
    cmdbar: <CommandBarSettings />,
    profiles: <ProfilesPanel />,
    about: (
      <div className="about-sec">
        <motion.img src={icon} alt="Delta Explorer logo" width={96} height={96} initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }} transition={glide} />
        <h2>Delta Explorer</h2>
        <p className="muted">Version 0.1.0 · Rust + Tauri 2 + React</p>
      </div>
    ),
    cleaner: <CleanerSettings Row={Row} Toggle={Toggle} />,
  };

  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal settings" role="dialog" aria-modal aria-label="Settings"
        initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0, transition: glide }} exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.14 } }}>
        <aside className="set-nav">
          <h2>Settings</h2>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`set-nav-item${sec === s.id ? ' active' : ''}`} onClick={() => setSec(s.id)} aria-current={sec === s.id ? 'page' : undefined}>
              {sec === s.id && <motion.span layoutId="set-pill" className="side-pill" transition={snap} />}
              <s.icon size={16} /><span>{s.name}</span>
            </button>
          ))}
        </aside>
        <div className="set-body">
          <button className="icon-btn set-close" aria-label="Close settings" onClick={onClose}><X size={18} /></button>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={sec} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: glide }} exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}>
              <h2 className="set-title">{SECTIONS.find((s) => s.id === sec)!.name}</h2>
              {body[sec]}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
