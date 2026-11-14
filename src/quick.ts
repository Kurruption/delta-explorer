// Pure helpers for batch rename, select-by-pattern, several folders and back/forward memory (tested in tests/quick.test.ts).
import type { RenameRecipe } from './api';

/** "*.png; report-??.pdf" -> one case-insensitive regex for whole names. null when nothing was typed. */
export function wildcard(pattern: string): RegExp | null {
  const parts = pattern.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const one = (p: string) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^(?:${parts.map(one).join('|')})$`, 'i');
}

/** One folder per non-empty line of the "Create several folders" box. */
export const folderLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export const DEFAULT_RECIPE: RenameRecipe = {
  find: '', replace: '', regex: false, matchCase: false,
  strip: '', stripSpaces: false, stripWith: '_',
  case: 'keep', prefix: '', suffix: '',
  number: false, start: 1, step: 1, pad: 2, numberAt: 'end',
  date: 'none', dateFormat: 'YYYY-MM-DD', dateAt: 'start',
  sep: ' ', extMode: 'keep', ext: '',
};

/** Undo pairs for a batch rename: each new path back to its old name. */
export const undoPairs = (done: [string, string][]): [string, string][] => done.map(([from, to]) => [to, from.replace(/\\+$/, '').split('\\').pop() ?? from]);

/** Scroll position and selection of each folder a tab left, restored on Back/Forward. */
export interface ViewMemo { top: number; sel: string[]; focus: number }
const memo = new Map<string, ViewMemo>();
export const remember = (key: string, m: ViewMemo) => {
  memo.delete(key);
  memo.set(key, m);
  if (memo.size > 300) memo.delete(memo.keys().next().value!); // oldest first
};
export const recall = (key: string) => memo.get(key);
/** "Open containing folder": the item to select once that folder shows (keyed by lowercase folder path). */
export const pendingReveal = new Map<string, string>();

/** Names that came out the same get numbered like Explorer: "Holiday (1).jpg", "Holiday (2).jpg". */
export function numberClashes(names: string[], noExt: boolean): string[] {
  const key = (n: string) => n.toLowerCase();
  const count = new Map<string, number>();
  for (const n of names) count.set(key(n), (count.get(key(n)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((n) => {
    if ((count.get(key(n)) ?? 0) < 2) return n;
    const i = (seen.get(key(n)) ?? 0) + 1;
    seen.set(key(n), i);
    const dot = noExt ? -1 : n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
  });
}

