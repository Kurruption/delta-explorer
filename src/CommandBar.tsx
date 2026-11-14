import { useState, type ReactNode } from 'react';
import { AnimatePresence, Reorder } from 'motion/react';
import {
  ClipboardPaste, Clipboard, Copy, FolderPlus, GripVertical, Info, MoreHorizontal, Pencil, RotateCcw, RotateCw, Scissors, Settings2, Share2, SquareTerminal, Trash2, X,
} from 'lucide-react';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { Command } from './Palette';
import { keyLabel, type ActionId } from './keymap';
import { memory, setSetting, settings } from './store';
import { extrasMenu } from './shellExtras';
import { snap } from './motion';

/** Every palette command, kept current by App, so the bar can show any of them. */
export const paletteCommands = memory<Command[]>([]);
export const openSettingsAt = (page: string) => dispatchEvent(new CustomEvent('open-settings', { detail: page }));

type Need = 'make' | 'any' | 'one' | 'paste' | 'always';
const BUILTINS = {
  newFolder: { label: 'New folder', key: 'newFolder', icon: <FolderPlus size={16} />, need: 'make', text: true },
  cut: { label: 'Cut', key: 'cut', icon: <Scissors size={16} />, need: 'any' },
  copy: { label: 'Copy', key: 'copy', icon: <Copy size={16} />, need: 'any' },
  paste: { label: 'Paste', key: 'paste', icon: <ClipboardPaste size={16} />, need: 'paste' },
  rename: { label: 'Rename', key: 'rename', icon: <Pencil size={16} />, need: 'any' },
  delete: { label: 'Delete', key: 'delete', icon: <Trash2 size={16} />, need: 'any' },
  properties: { label: 'Properties', key: 'properties', icon: <Info size={16} />, need: 'one' },
  selectAll: { label: 'Select all', key: 'selectAll', icon: <span className="cmd-glyph" aria-hidden>⬚</span>, need: 'always', text: true },
  refresh: { label: 'Refresh', key: 'refresh', icon: <RotateCw size={16} />, need: 'always' },
  share: { label: 'Share', key: 'share', icon: <Share2 size={16} />, need: 'any' },
  copyAsPath: { label: 'Copy as path', key: 'copyAsPath', icon: <Clipboard size={16} />, need: 'any' },
  terminal: { label: 'Open in Terminal', key: 'terminal', icon: <SquareTerminal size={16} />, need: 'make' },
} satisfies Record<string, { label: string; key: ActionId; icon: ReactNode; need: Need; text?: boolean }>;
export type BuiltinId = keyof typeof BUILTINS;
export const DEFAULT_BAR = ['newFolder', 'sep:1', 'cut', 'copy', 'paste', 'rename', 'delete', 'sep:2', 'properties', 'selectAll'];

/** Name and icon of a bar entry for Settings; null if it no longer exists (e.g. a removed pin). */
function describe(id: string, cmds: Command[]): { label: string; icon: ReactNode } | null {
  if (id.startsWith('sep:')) return { label: 'Separator', icon: <span className="cmd-sep" /> };
  if (id.startsWith('cmd:')) { const c = cmds.find((x) => x.id === id.slice(4)); return c ? { label: c.label, icon: c.icon } : null; }
  return BUILTINS[id as BuiltinId] ?? null;
}

/** File Explorer-style strip of everyday actions; its buttons are chosen in Settings → Command bar. */
export function CommandBar({ can, cmds, run, paths, here, reload, extra }: {
  /** Context buttons (e.g. Extract for archives), shown after the configured ones. */
  extra?: ReactNode;
  can: Record<Exclude<Need, 'always'>, boolean>;
  cmds: Record<BuiltinId, () => unknown>;
  run: (f: () => unknown) => void;
  /** Selected items and the folder "terminal here" uses, for the ⋯ menu. */
  paths: string[];
  here: string;
  reload: () => void;
}) {
  const bar = settings.use().cmdbar;
  const palette = paletteCommands.use();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const customise: MenuItem = { label: 'Customise command bar…', icon: <Settings2 size={15} />, run: () => openSettingsAt('cmdbar') };
  const toggles = (): MenuItem[] => [
    ...(Object.keys(BUILTINS) as BuiltinId[]).map((id) => ({
      label: BUILTINS[id].label, icon: BUILTINS[id].icon, checked: bar.includes(id),
      run: () => setSetting('cmdbar', bar.includes(id) ? bar.filter((x) => x !== id) : [...bar, id]),
    })),
    'sep' as const, customise,
  ];

  const button = (key: string, label: string, title: string, icon: ReactNode, f: () => unknown, on: boolean, text = false) => (
    <button key={key} className={`cmd${text ? ' has-text' : ''}`} disabled={!on} title={title} aria-label={label}
      onMouseDown={(e) => e.preventDefault()} onClick={() => run(f)}>
      {icon}{text && <span>{label}</span>}
    </button>
  );
  return (
    <div className="cmdbar" role="toolbar" aria-label="File actions" onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items: toggles() }); }}>
      {bar.map((id) => {
        if (id.startsWith('sep:')) return <span key={id} className="cmd-sep" />;
        if (id.startsWith('cmd:')) {
          const c = palette.find((x) => x.id === id.slice(4));
          return c && button(id, c.label, c.hint ? `${c.label} (${c.hint})` : c.label, c.icon, c.run, true);
        }
        const b = BUILTINS[id as BuiltinId];
        if (!b) return null;
        const k = keyLabel(b.key);
        return button(id, b.label, k ? `${b.label} (${k})` : b.label, b.icon, cmds[id as BuiltinId], b.need === 'always' || can[b.need], 'text' in b && b.text);
      })}
      {extra && <><span className="cmd-sep" />{extra}</>}
      <span className="cmd-sep" />
      <button className="cmd" title="More actions" aria-label="More actions" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, items: [...extrasMenu(paths, here, reload), 'sep', customise] }); }}>
        <MoreHorizontal size={16} />
      </button>
      <AnimatePresence>{menu && <ContextMenu key="barmenu" {...menu} onClose={() => setMenu(null)} />}</AnimatePresence>
    </div>
  );
}

/** Settings → Command bar: show, hide, reorder; add any palette command. */
export function CommandBarSettings() {
  const bar = settings.use().cmdbar;
  const palette = paletteCommands.use();
  const set = (v: string[]) => setSetting('cmdbar', v);
  const hidden = (Object.keys(BUILTINS) as BuiltinId[]).filter((id) => !bar.includes(id));
  const addable = palette.filter((c) => !bar.includes(`cmd:${c.id}`));
  return <>
    <p className="muted small">Drag to reorder. Right-click the command bar for quick show/hide. Anything from the command palette (Ctrl+K) can be a button.</p>
    <Reorder.Group axis="y" values={bar} onReorder={set} className="reorder">
      {bar.map((id) => {
        const d = describe(id, palette);
        return (
          <Reorder.Item key={id} value={id} className="reorder-item" whileDrag={{ scale: 1.03, boxShadow: '0 10px 28px rgb(0 0 0 / .3)' }} transition={snap}>
            <GripVertical size={16} className="muted grip" />
            <span className="menu-icon">{d?.icon}</span>
            <span className="reorder-name">{d?.label ?? 'Missing command'}</span>
            <button className="icon-btn small" aria-label={`Remove ${d?.label ?? id}`} onClick={() => set(bar.filter((x) => x !== id))}><X size={14} /></button>
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
    <div className="cmdbar-add">
      <select className="text" aria-label="Add a button" value="" onChange={(e) => e.target.value && set([...bar, e.target.value === 'sep' ? `sep:${Date.now()}` : e.target.value])}>
        <option value="">Add a button…</option>
        <option value="sep">Separator</option>
        {hidden.length > 0 && <optgroup label="File actions">{hidden.map((id) => <option key={id} value={id}>{BUILTINS[id].label}</option>)}</optgroup>}
        {[...new Set(addable.map((c) => c.group))].map((g) => (
          <optgroup key={g} label={g}>{addable.filter((c) => c.group === g).map((c) => <option key={c.id} value={`cmd:${c.id}`}>{c.label}</option>)}</optgroup>
        ))}
      </select>
      <button className="btn" onClick={() => set(DEFAULT_BAR)}><RotateCcw size={14} /> Reset command bar</button>
    </div>
  </>;
}
