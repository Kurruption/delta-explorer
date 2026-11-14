import { Clipboard, Link2, Send, Share2, SquareTerminal, Terminal } from 'lucide-react';
import { createShortcut, iconUrl, openTerminal, quotedPaths, recycle, sendTo, sendToTargets, share, type TerminalKind } from './api';
import type { MenuItem } from './ContextMenu';
import { keyLabel } from './keymap';
import { errorToast, toast, undoable } from './store';

/** The file list used last (clicked, focused or selected in): where palette commands like Share act. */
export interface ActiveList { dir: string; selected: () => string[]; /** Folder for "terminal here": a single selected folder, else this one. */ here: () => string; reload: () => void }
export const activeList: { current: ActiveList | null } = { current: null };

export const terminal = (dir: string, kind: TerminalKind = 'wt') => openTerminal(dir, kind).catch(errorToast);
export const copyAsPath = (paths: string[]) => navigator.clipboard.writeText(quotedPaths(paths)).then(() => toast(`Copied ${paths.length > 1 ? `${paths.length} paths` : 'path'}`), errorToast);
export const shareItems = (paths: string[]) => share(paths).catch(errorToast);
export function makeShortcuts(paths: string[], reload?: () => void) {
  createShortcut(paths).then((made) => { reload?.(); undoable({ label: 'Create shortcut', run: () => recycle(made) }, `Created ${made.length > 1 ? `${made.length} shortcuts` : 'a shortcut'}`); }, errorToast);
}

/** Send to ▸ (the user's SendTo folder: Compressed folder, Desktop, Documents, Mail…). */
export const sendToMenu = async (paths: string[]): Promise<MenuItem[]> => {
  const targets = await sendToTargets().catch((e) => { errorToast(e); return []; });
  if (!targets.length) return [{ label: 'Nothing in your Send to folder', disabled: true }];
  return targets.map((t) => ({
    label: t.name,
    icon: <img src={iconUrl(t.path)} alt="" width={16} height={16} />,
    run: () => sendTo(t.path, paths).catch(errorToast),
  }));
};

/** Share, Send to, Create shortcut, Copy as path, terminals. `paths` empty = folder background. */
export function extrasMenu(paths: string[], here: string, reload?: () => void): MenuItem[] {
  const items: MenuItem[] = paths.length
    ? [
        { label: 'Share', icon: <Share2 size={15} />, shortcut: keyLabel('share'), run: () => shareItems(paths) },
        { label: 'Send to', icon: <Send size={15} />, sub: () => sendToMenu(paths) },
        { label: 'Create shortcut', icon: <Link2 size={15} />, run: () => makeShortcuts(paths, reload) },
        { label: 'Copy as path', icon: <Clipboard size={15} />, shortcut: keyLabel('copyAsPath'), run: () => copyAsPath(paths) },
      ]
    : [];
  if (here) {
    items.push(
      { label: 'Open in Terminal', icon: <SquareTerminal size={15} />, shortcut: keyLabel('terminal'), run: () => terminal(here) },
      { label: 'Open PowerShell here', icon: <Terminal size={15} />, run: () => terminal(here, 'powershell') },
      { label: 'Open Command Prompt here', icon: <Terminal size={15} />, run: () => terminal(here, 'cmd') },
    );
  }
  return items;
}

/** Selection-based palette commands, acting on the last-used file list. */
export function withActive(f: (a: ActiveList) => void, needSelection = false) {
  return () => {
    const a = activeList.current;
    if (!a || (needSelection && !a.selected().length)) return toast('Select something in a folder first');
    f(a);
  };
}
