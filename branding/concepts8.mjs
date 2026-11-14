// Round 8: refining "7 crystal folder". Run: node branding/concepts8.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

export const defs = `<defs>
<linearGradient id="back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6D28D9"/><stop offset="1" stop-color="#3B0764"/></linearGradient>
<linearGradient id="front" gradientUnits="userSpaceOnUse" x1="0" y1="104" x2="0" y2="220"><stop offset="0" stop-color="#93C5FD"/><stop offset=".45" stop-color="#818CF8"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9E5FF"/></linearGradient>
<linearGradient id="elit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E0E7FF"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#3B0764" flood-opacity=".35"/></filter>
<filter id="esh" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#3B0764" flood-opacity=".4"/></filter>
</defs>`;
const pts = (a) => a.map((p) => p.map((n) => +n.toFixed(1)).join(' ')).join(' L');
export const F = (a, c, j = 8) => `<path d="M${pts(a)} Z" fill="${c}" stroke="${c}" stroke-width="${j}" stroke-linejoin="round"/>`;

// Split-base crystal Δ in a 256 box (from round 5), coloured for a dark-ish backdrop.
export function splitDelta(lit, shade, base) {
  const A = [128, 30], B = [28, 214], C = [228, 214], t = 44, g = 22, top = 30, b = 214, k = 100 / 184;
  const iTop = top + t / Math.sin(Math.atan(k)), iBase = b - t, ih = (iBase - iTop) * k;
  const i0 = [128, iTop], i1 = [128 - ih, iBase], i2 = [128 + ih, iBase], foot = [i1[0] - (b - iBase) * k, b];
  return F([A, i0, i2, C], shade, 14) + F([[foot[0] + g, b], C, i2, [i1[0] + g, iBase]], base, 14) + F([A, B, foot, i1, i0], lit, 14);
}
const emblem = (inner, size = 0.34, cy = 168) => `<g filter="url(#esh)" transform="translate(128 ${cy}) scale(${size}) translate(-128 -122)">${inner}</g>`;
const EMBLEMS = {
  split: splitDelta('url(#elit)', '#C4B5FD', '#DDD6FE'),
  facet: F([[128, 30], [28, 214], [128, 180]], 'url(#elit)', 14) + F([[128, 30], [128, 180], [228, 214]], '#C4B5FD', 14),
};

/** Full-detail folder for 48px and up. */
export function folder(em = 'split', papers = 2) {
  const back = `<path d="M44 46 H98 Q108 46 114 54 L122 64 H204 Q222 64 222 82 V196 Q222 214 204 214 H52 Q34 214 34 196 V56 Q34 46 44 46 Z" fill="url(#back)"/>`;
  const sheets = (papers > 1 ? `<rect x="60" y="66" width="140" height="96" rx="10" fill="#C4B5FD" transform="rotate(5 128 114)"/>` : '') +
    `<rect x="56" y="60" width="144" height="100" rx="10" fill="url(#paper)" transform="rotate(-3 128 110)"/>`;
  const front = `<path d="M26 108 Q26 98 36 98 H220 Q230 98 230 108 L222 200 Q220 216 204 216 H52 Q36 216 34 200 Z" fill="url(#front)"/>` +
    `<path d="M30 102 H226 L224 128 H32 Z" fill="url(#sheen)"/><path d="M36 99.5 H220" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="3" stroke-linecap="round"/>`;
  return `<g filter="url(#sh)">${back}${sheets}${front}</g>${emblem(EMBLEMS[em])}`;
}
/** Simplified folder for 32px and below: no paper, bigger emblem, no shadows. */
export function folderSmall() {
  return `<path d="M40 40 H96 Q106 40 112 48 L120 58 H206 Q224 58 224 76 V200 Q224 218 206 218 H50 Q32 218 32 200 V50 Q32 40 40 40 Z" fill="#5B21B6"/>` +
    `<path d="M24 100 Q24 88 36 88 H220 Q232 88 232 100 L224 204 Q222 222 204 222 H52 Q34 222 32 204 Z" fill="url(#front)"/>` +
    `<g transform="translate(128 160) scale(.42) translate(-128 -122)">${F([[128, 30], [28, 214], [228, 214]], '#FFFFFF', 20)}</g>`;
}

// Preview sheet only when run directly (build.mjs imports the shapes).
if (process.argv[1]?.endsWith('concepts8.mjs')) {
const variants = {
  'A split emblem': folder('split'),
  'B faceted emblem': folder('facet'),
  'C one sheet, split': folder('split', 1),
};

const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${defs}${inner}</svg>`;
const png = (inner, s) => new Resvg(svg(inner), { fitTo: { mode: 'width', value: s } }).render().asPng();
const img = (inner, s, x, y) => `<image x="${x}" y="${y}" width="${s}" height="${s}" href="data:image/png;base64,${png(inner, s).toString('base64')}"/>`;
const sizes = [64, 48, 32, 24, 16], W = 640, H = 330;
let body = '';
Object.entries(variants).forEach(([name, inner], r) => {
  ['#1A1B23', '#F3F3F5'].forEach((bg, h) => {
    const x0 = h * W, y = r * H;
    body += `<rect x="${x0 + 8}" y="${y + 8}" width="${W - 16}" height="${H - 16}" rx="18" fill="${bg}"/>` + img(inner, 256, x0 + 24, y + 30);
    let x = x0 + 310;
    for (const s of sizes) {
      body += img(s <= 32 ? folderSmall() : inner, s, x, y + 150 - s / 2);
      body += `<text x="${x}" y="${y + 200}" font-family="Segoe UI" font-size="12" fill="#888">${s}px</text>`;
      x += s + 26;
    }
    if (!h) body += `<text x="${x0 + 310}" y="${y + 60}" font-family="Segoe UI" font-size="17" fill="#ccc">${name}</text>`;
  });
});
writeFileSync('branding/concepts/round8.png', new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 3}"><rect width="100%" height="100%" fill="#0C0D14"/>${body}</svg>`, { font: { loadSystemFonts: true } }).render().asPng());
console.log('wrote round8.png');
}
