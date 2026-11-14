// Git awareness: branch + per-item status for the folder on screen (src-tauri/src/power.rs runs the git CLI).
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { gitChanged, gitStatus, isFolder, normPath, setVirtual, type GitDir, type GitState } from './api';

// Both panes and the list ask for the same folder: share one request for a moment.
const recent = new Map<string, { at: number; p: Promise<GitDir | null> }>();
function fetchGit(dir: string, refresh: boolean) {
  const k = normPath(dir);
  const hit = recent.get(k);
  if (hit && Date.now() - hit.at < 800) return hit.p;
  const p = gitStatus(dir, refresh).catch(() => null);
  recent.set(k, { at: Date.now(), p });
  if (recent.size > 50) recent.delete(recent.keys().next().value!);
  return p;
}

/** Git info for a real folder (null outside a repo, without git, or for '' / virtual lists). Refreshes with the file watcher. */
export function useGit(dir: string): GitDir | null {
  const [g, setG] = useState<GitDir | null>(null);
  const [tick, setTick] = useState(0);
  const ok = !!dir && isFolder(dir);
  useEffect(() => {
    if (!ok) { setG(null); return; }
    let live = true;
    fetchGit(dir, tick > 0).then((v) => live && setG(v));
    return () => { live = false; };
  }, [dir, tick, ok]);
  useEffect(() => {
    if (!ok) return;
    const un = listen<string[]>('fs-changed', ({ payload }) => payload.includes(normPath(dir)) && setTick((t) => t + 1));
    return () => { un.then((f) => f()); };
  }, [dir, ok]);
  return g;
}

export const gitOf = (g: GitDir | null, name: string): GitState | null => (g ? g.items[name.toLowerCase()] ?? g.all : null);

const BADGE: Record<GitState, [string, string]> = {
  modified: ['M', 'Modified'], added: ['A', 'Added'], deleted: ['D', 'Deleted'], renamed: ['R', 'Renamed'],
  untracked: ['U', 'Untracked'], conflicted: ['!', 'Conflicted'], ignored: ['', 'Ignored by git'], dirty: ['', 'Changes inside'],
};
/** M/A/D/R/U/! letter, or a dot for folders with changes inside. Ignored items are greyed by the row instead. */
export function GitBadge({ s }: { s: GitState | null }) {
  if (!s || s === 'ignored') return null;
  const [letter, title] = BADGE[s];
  return <span className={`git-badge git-${s}`} title={title} aria-label={`Git: ${title}`}>{letter}</span>;
}

/** "Show only changed": every changed file of the repo as a virtual list. */
export async function showChanged(dir: string, navigate: (p: string) => void) {
  await setVirtual('git', await gitChanged(dir));
  dispatchEvent(new Event('virtual-changed'));
  navigate('v:git');
}
