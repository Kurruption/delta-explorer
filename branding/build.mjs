// Generates every Delta Explorer brand asset from the geometry below. Run: pnpm brand
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { sheet } from './concepts.mjs';

// Crystal folder: glossy folder with the split-base Δ emblem.
import { defs, folder, folderSmall, splitDelta } from './concepts8.mjs';
const BRAND = { ink: '#1B1D22' };
const O = 'branding/dist';
mkdirSync(O, { recursive: true });

const svg = (inner, w = 256, h = 256) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${inner}</svg>
`;

const icon = folder('split');
// 32px and below: no paper or shadows, bigger solid Δ; the full folder turns to mush that small.
const iconSmall = folderSmall();
const variants = {
  icon,
  'icon-small': iconSmall,
  // Bare Δ (no folder) for UI chrome. Light = for light backgrounds, dark = for dark backgrounds.
  'icon-light': splitDelta('#6366F1', '#5B21B6', '#7C3AED'),
  'icon-dark': splitDelta('#FFFFFF', '#C4B5FD', '#DDD6FE'),
  'icon-mono': splitDelta('#000', '#000', '#000'),
};

const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true } }).render().asPng();

for (const [k, v] of Object.entries(variants)) {
  writeFileSync(`${O}/${k}.svg`, svg(v));
  writeFileSync(`${O}/${k}.png`, png(svg(v), 1024));
}

// Primary logo: mark + wordmark. shortcut: wordmark is live text in Segoe UI Variable (ships with Windows 11); outline it if the logo is used off-Windows.
const word = (fill) =>
  `<text x="300" y="166" font-family="Segoe UI Variable Display, Segoe UI, sans-serif" font-weight="600" font-size="112" letter-spacing="-2" fill="${fill}">Delta <tspan font-weight="400" fill-opacity=".7">Explorer</tspan></text>`;
writeFileSync(`${O}/logo-primary.svg`, svg(icon + word(BRAND.ink), 1060, 256));
writeFileSync(`${O}/logo-primary.png`, png(svg(icon + word(BRAND.ink), 1060, 256), 2120));
writeFileSync(`${O}/logo-primary-dark.svg`, svg(icon + word('#F4F5F7'), 1060, 256));
writeFileSync(`${O}/logo-primary-dark.png`, png(svg(icon + word('#F4F5F7'), 1060, 256), 2120));

// Windows .ico: PNG-compressed frames (supported since Vista). Small frames use the simplified mark.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map((s) => png(svg(s <= 32 ? iconSmall : icon), s));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  head.writeUInt8(s % 256, e); // 256 is stored as 0
  head.writeUInt8(s % 256, e + 1);
  head.writeUInt16LE(1, e + 4); // planes
  head.writeUInt16LE(32, e + 6); // bpp
  head.writeUInt32LE(frames[i].length, e + 8);
  head.writeUInt32LE(off, e + 12);
  off += frames[i].length;
});
writeFileSync(`${O}/delta-explorer.ico`, Buffer.concat([head, ...frames]));

// Preview sheet: real pixel sizes on light/dark.
sheet([['icon (>=48px)', icon], ['icon-small (16-32px)', iconSmall], ['icon-dark (bare)', variants['icon-dark']], ['icon-light (bare)', variants['icon-light']], ['icon-mono', variants['icon-mono']]].map(([n, v]) => [n, defs + v]), `${O}/preview.png`);

// The app uses the same SVG on its About page.
mkdirSync('src/assets', { recursive: true });
copyFileSync(`${O}/icon.svg`, 'src/assets/icon.svg');
copyFileSync(`${O}/icon-small.svg`, 'src/assets/icon-small.svg');
// Our hand-built .ico (simplified 16/24px frames) replaces the one `tauri icon` downsamples.
// After changing the mark: pnpm tauri icon branding/dist/icon.png -o src-tauri/icons && pnpm brand
mkdirSync('src-tauri/icons', { recursive: true });
copyFileSync(`${O}/delta-explorer.ico`, 'src-tauri/icons/icon.ico');
console.log('brand assets written to', O);
