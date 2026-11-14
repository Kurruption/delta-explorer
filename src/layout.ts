// Pure geometry for the virtualised list/grid with group headers (tested in tests/layout.test.ts).

/** A run of items in a grouped listing (from Rust). Collapsed groups have shown = 0. */
export interface Group { key: string; start: number; count: number; shown: number }
export interface Seg extends Group { top: number; body: number; end: number }
export type GroupBy = 'none' | 'type' | 'modified' | 'size' | 'letter';

/** Stacks groups top to bottom: header (headH) then ceil(shown / cols) rows. No groups = one headerless segment. */
export function buildLayout(groups: Group[], total: number, cols: number, rowH: number, headH: number) {
  const gs = groups.length ? groups : [{ key: '', start: 0, count: total, shown: total }];
  const h = groups.length ? headH : 0;
  let y = 0;
  const segs: Seg[] = gs.map((g) => {
    const top = y, body = top + h;
    y = body + Math.ceil(g.shown / cols) * rowH;
    return { ...g, top, body, end: y };
  });
  return { segs, height: y, cols, rowH, headH: h };
}
export type Layout = ReturnType<typeof buildLayout>;

/** The segment holding visible item i (indices are contiguous: collapsed groups hold none). */
export function segOf(L: Layout, i: number): Seg {
  let lo = 0, hi = L.segs.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (L.segs[m].start <= i) lo = m; else hi = m - 1;
  }
  return L.segs[lo];
}

/** Column and top edge of item i. */
export function posOf(L: Layout, i: number) {
  const s = segOf(L, i);
  const k = i - s.start;
  return { col: k % L.cols, y: s.body + Math.floor(k / L.cols) * L.rowH };
}

/** [first, last) of the items whose rows touch the band top..bottom. */
export function rangeOf(L: Layout, top: number, bottom: number): [number, number] {
  let first = -1, last = 0;
  for (const s of L.segs) {
    if (!s.shown || s.end <= top || s.body >= bottom) continue;
    const r0 = Math.max(0, Math.floor((top - s.body) / L.rowH));
    const r1 = Math.ceil((bottom - s.body) / L.rowH);
    const a = s.start + r0 * L.cols, b = Math.min(s.start + s.shown, s.start + r1 * L.cols);
    if (a < b) { if (first < 0) first = a; last = b; }
  }
  return first < 0 ? [0, 0] : [first, last];
}

/** Group headers to draw for a viewport; the one whose group spans the top edge sticks there. */
export function headsIn(L: Layout, top: number, bottom: number) {
  if (!L.headH) return [];
  return L.segs.filter((s) => s.top < bottom && s.end > top).map((s) => ({ seg: s, y: s.top <= top ? Math.min(top, s.end - L.headH) : s.top, stuck: s.top < top }));
}

/** Local starts of today, yesterday, this week, last week and this month (epoch seconds), for date groups. */
export function dateBounds(now = new Date(), firstDay = weekStartDay()) {
  const d = (y: number, m: number, day: number) => new Date(y, m, day).getTime() / 1000;
  const [y, m, day] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const back = (now.getDay() - (firstDay % 7) + 7) % 7;
  return [d(y, m, day), d(y, m, day - 1), d(y, m, day - back), d(y, m, day - back - 7), d(y, m, 1)];
}
/** 0 = Sunday ... 6 = Saturday, from the user's locale (Monday if the browser can't say). */
function weekStartDay() {
  try {
    const l = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1;
  } catch { return 1; }
}

const DATES = ['Today', 'Yesterday', 'Earlier this week', 'Last week', 'Earlier this month', 'Older'];
const SIZES: Record<string, string> = {
  folder: 'Folders', empty: 'Empty (0 KB)', tiny: 'Tiny (0 – 16 KB)', small: 'Small (16 KB – 1 MB)', medium: 'Medium (1 – 128 MB)',
  large: 'Large (128 MB – 1 GB)', huge: 'Huge (1 – 4 GB)', gigantic: 'Gigantic (over 4 GB)',
};
/** Human label for a group key from Rust (crates/de-core/src/details.rs `key_of`). `kind` names a file extension. */
export function groupLabel(by: GroupBy, key: string, kind: (ext: string) => string) {
  if (by === 'modified') return DATES[+key] ?? key;
  if (by === 'size') return SIZES[key] ?? key;
  if (by === 'type') return key === 'folder' ? 'Folders' : key ? kind(key) : 'File';
  return key === '0-9' ? '0 – 9' : key;
}
