// Squarified treemap layout (Bruls, Huizing & van Wijk): rows of rectangles kept as close to square as possible.
export interface Rect { x: number; y: number; w: number; h: number }
export type Tile<T> = Rect & { item: T };

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

/** Worst aspect ratio in a row of `areas` laid along a side of length `side`. */
function worst(areas: number[], side: number) {
  const s = sum(areas);
  const max = Math.max(...areas), min = Math.min(...areas);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/** Places one finished row along the shorter side of `r`; returns the space left. */
function place<T>(row: { item: T; area: number }[], r: Rect, out: Tile<T>[]): Rect {
  const area = sum(row.map((x) => x.area));
  if (r.w >= r.h) {
    const w = area / r.h;
    let y = r.y;
    for (const x of row) { const h = x.area / w; out.push({ x: r.x, y, w, h, item: x.item }); y += h; }
    return { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
  }
  const h = area / r.w;
  let x0 = r.x;
  for (const x of row) { const w = x.area / h; out.push({ x: x0, y: r.y, w, h, item: x.item }); x0 += w; }
  return { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
}

/** Tiles for items with size > 0 (biggest first); each tile's area is proportional to its size. */
export function squarify<T extends { size: number }>(items: T[], box: Rect): Tile<T>[] {
  const list = items.filter((i) => i.size > 0).sort((a, b) => b.size - a.size);
  const total = sum(list.map((i) => i.size));
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const out: Tile<T>[] = [];
  let rect = { ...box };
  let row: { item: T; area: number }[] = [];
  for (let i = 0; i < list.length;) {
    const next = { item: list[i], area: list[i].size * scale };
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row.map((x) => x.area), next.area], side) <= worst(row.map((x) => x.area), side)) { row.push(next); i++; }
    else { rect = place(row, rect, out); row = []; }
  }
  if (row.length) place(row, rect, out);
  return out;
}
