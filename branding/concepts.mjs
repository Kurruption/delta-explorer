// Renders the 5 exploration concepts to branding/concepts/sheet.png at 256/48/32/16 on light and dark.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';

const C = '#3D5AFE', C2 = '#00C2A8';
export const concepts = {
  stacked: `<path d="M128 28 236 220H20Z" fill="${C}" opacity=".35"/><path d="M128 84 204 220H52Z" fill="${C}" opacity=".65"/><path d="M128 140 172 220H84Z" fill="${C}"/>`,
  river: `<g fill="none" stroke="${C}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"><path d="M128 232V140"/><path d="M128 140 52 40"/><path d="M128 140V30"/><path d="M128 140 204 40"/></g>`,
  compass: `<path d="M128 24c8 0 15 4 19 11l92 165c8 14-2 32-19 32H36c-17 0-27-18-19-32l92-165c4-7 11-11 19-11z" fill="${C}"/><path d="M128 92 166 196 128 176 90 196Z" fill="#fff"/>`,
  tile: `<rect x="16" y="16" width="224" height="224" rx="56" fill="${C}"/><path d="M128 60 196 188H60Z" fill="#fff"/><path d="M162 124 196 188H128Z" fill="${C2}"/>`,
  nodes: `<path d="M128 52 212 196H44Z" fill="none" stroke="${C}" stroke-width="18" stroke-linejoin="round"/><circle cx="128" cy="52" r="26" fill="${C}"/><circle cx="44" cy="196" r="26" fill="${C2}"/><circle cx="212" cy="196" r="26" fill="${C}"/>`,
};

export const svg = (inner, s = 256) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 256 256">${inner}</svg>`;
export const png = (svgText, size) => new Resvg(svgText, { fitTo: { mode: 'width', value: size } }).render().asPng();
const b64 = (buf) => 'data:image/png;base64,' + buf.toString('base64');

// Sheet: each row = one concept; light half then dark half. Small sizes upscaled 4x with nearest-neighbour to show real pixels.
export function sheet(items, out) {
  const sizes = [256, 48, 32, 16], cell = 280, rowH = 300;
  let body = '';
  items.forEach(([name, inner], r) => {
    ['#F4F5F7', '#1B1D22'].forEach((bg, half) => {
      const x0 = half * cell * sizes.length, y = r * rowH;
      body += `<rect x="${x0}" y="${y}" width="${cell * sizes.length}" height="${rowH}" fill="${bg}"/>`;
      sizes.forEach((s, i) => {
        const shown = s === 256 ? 256 : s * 4;
        const img = b64(png(svg(inner), s));
        body += `<image x="${x0 + i * cell + 12}" y="${y + 22}" width="${shown}" height="${shown}" href="${img}" style="image-rendering:pixelated"/>`;
      });
      body += `<text x="${x0 + 12}" y="${y + 16}" font-family="Segoe UI, Arial" font-size="14" fill="${half ? '#ccc' : '#333'}">${name}</text>`;
    });
  });
  const W = cell * sizes.length * 2, H = rowH * items.length;
  const s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">${body}</svg>`;
  writeFileSync(out, new Resvg(s, { font: { loadSystemFonts: true } }).render().asPng());
}

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  mkdirSync('branding/concepts', { recursive: true });
  for (const [k, v] of Object.entries(concepts)) writeFileSync(`branding/concepts/${k}.svg`, svg(v));
  sheet(Object.entries(concepts), 'branding/concepts/sheet.png');
  console.log('wrote branding/concepts/sheet.png');
}
