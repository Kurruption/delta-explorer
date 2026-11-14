// Smooth mouse-wheel scrolling for every scrollable area in Delta. Windows/WebView2 jumps in fixed
// steps per wheel notch; this eases toward the target instead. Touchpads (pixel deltas) and Ctrl+wheel
// (zoom) keep their native behaviour, and the "Motion: off" setting turns it off.

const EASE = 0.2; // share of the remaining distance moved per frame
type Anim = { x: number; y: number; raf: number };
const anims = new WeakMap<Element, Anim>();

const canScroll = (el: Element, dx: number, dy: number) => {
  const s = getComputedStyle(el);
  if (dy && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) {
    const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
    if (room > 0.5 || anims.has(el)) return true;
  }
  if (dx && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1) {
    const room = dx > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
    if (room > 0.5 || anims.has(el)) return true;
  }
  return false;
};

function step(el: Element) {
  const a = anims.get(el)!;
  const dy = a.y - el.scrollTop, dx = a.x - el.scrollLeft;
  if (Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) { el.scrollTop = a.y; el.scrollLeft = a.x; anims.delete(el); return; }
  el.scrollTop += dy * EASE;
  el.scrollLeft += dx * EASE;
  a.raf = requestAnimationFrame(() => step(el));
}

export function installSmoothScroll() {
  addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.defaultPrevented || document.documentElement.dataset.motion === 'off') return;
    // Precise touchpads already scroll smoothly (small pixel deltas); only smooth wheel notches.
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && Math.abs(e.deltaX) < 50) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    let el = e.target instanceof Element ? e.target : null;
    while (el && !canScroll(el, dx, dy)) el = el.parentElement;
    if (!el || el.closest('input, textarea, select, [data-native-scroll]')) return;
    e.preventDefault();
    const a = anims.get(el) ?? { x: el.scrollLeft, y: el.scrollTop, raf: 0 };
    a.y = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, a.y + dy));
    a.x = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, a.x + dx));
    if (!anims.has(el)) { anims.set(el, a); a.raf = requestAnimationFrame(() => step(el!)); }
  }, { passive: false, capture: true });
}
