// Delta Explorer file and folder icons. Drawn for this app in the brand palette (branding/README.md), not system icons.
import { useEffect, useState, type ReactNode } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

type Tone = { back: string; front: string; glyph?: ReactNode };

// System folders keep the Delta violet family but shift hue enough to tell apart at a glance.
const tones: Record<string, Tone> = {
  folder: { back: '#4338CA', front: '#6D63E8' },
  desktop: { back: '#3B3FB8', front: '#5B6CF0', glyph: <rect x="8.5" y="11.5" width="7" height="5" rx="1" /> },
  documents: { back: '#4B4A80', front: '#7472B8', glyph: <path d="M9 11.5h6M9 14h6M9 16.5h4" /> },
  downloads: { back: '#14806F', front: '#22B39B', glyph: <path d="M12 10.5v6m-2.5-2.5L12 16.5l2.5-2.5" /> },
  pictures: { back: '#2E5CC9', front: '#4C86F0', glyph: <path d="m8.5 16.5 2.5-3 2 2 1-1 1.5 2Z" /> },
  music: { back: '#A3306E', front: '#D94B95', glyph: <path d="M11 16.5v-5l4-1v5m-4 1a1.2 1.2 0 1 1-1.2-1.2M15 15.5a1.2 1.2 0 1 1-1.2-1.2" /> },
  videos: { back: '#6A2DB8', front: '#9150E8', glyph: <path d="m10.5 11.5 4 2.5-4 2.5Z" /> },
  home: { back: '#4338CA', front: '#6D63E8', glyph: <path d="m8.5 14 3.5-3 3.5 3v2.5h-7Z" /> },
};

/** System folders get their own tint wherever they live (OneDrive moves several of them). */
export function toneFor(name: string, path: string, home: string): keyof typeof tones {
  if (home && path.toLowerCase() === home.toLowerCase()) return 'home';
  const k = name.toLowerCase();
  return k !== 'home' && k !== 'folder' && k in tones ? (k as keyof typeof tones) : 'folder';
}

/** `color`: the folder's own colour (Right-click → Folder colour); plain folders otherwise follow the
 *  "Folder colour" setting through CSS (--folder-back / --folder-front). */
export function FolderIcon({ tone = 'folder', size = 18, color, zip }: { tone?: keyof typeof tones; size?: number; color?: string; zip?: boolean }) {
  const t = tones[tone];
  const plain = tone === 'folder' || tone === 'home';
  const back = color ? `color-mix(in srgb, ${color} 72%, black)` : plain ? `var(--folder-back, ${t.back})` : t.back;
  const front = color ?? (plain ? `var(--folder-front, ${t.front})` : t.front);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="ficon">
      <path d="M2 6.2C2 5.5 2.5 5 3.2 5h5.3c.4 0 .7.1.9.4L11 7h9.8c.7 0 1.2.5 1.2 1.2V18.8c0 .7-.5 1.2-1.2 1.2H3.2C2.5 20 2 19.5 2 18.8Z" style={{ fill: back }} />
      <path d="M2 10.2C2 9.5 2.5 9 3.2 9h17.6c.7 0 1.2.5 1.2 1.2v8.6c0 .7-.5 1.2-1.2 1.2H3.2C2.5 20 2 19.5 2 18.8Z" style={{ fill: front }} />
      {/* Delta notch: the brand's facet line, echoed on every folder */}
      <path d="M2 10.2C2 9.5 2.5 9 3.2 9H12l-2 2H2Z" fill="#fff" opacity=".14" />
      {/* Zipped folder (like Explorer's): the same folder with a zipper down the front */}
      {zip && <g fill="#fff">
        <rect x="11" y="9" width="2" height="11" opacity=".22" />
        <path d="M11 10h1v1.2h-1zM12 11.4h1v1.2h-1zM11 12.8h1v1.2h-1zM12 14.2h1v1.2h-1z" opacity=".9" />
        <rect x="10.2" y="15.4" width="3.6" height="3.4" rx=".8" />
        <rect x="11.4" y="16.6" width="1.2" height="1.4" rx=".3" style={{ fill: front }} />
      </g>}
      {t.glyph && (
        <g fill={tone === 'pictures' || tone === 'videos' || tone === 'desktop' || tone === 'home' ? '#fff' : 'none'} stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity=".95">
          {t.glyph}
        </g>
      )}
    </svg>
  );
}

// Everyday file types: a colour and a glyph drawn on the page (24-unit box, lower half of the page).
// Office-style types get a bold letter on a coloured badge, like the apps' own icons.
const S = { fill: 'none', stroke: '#fff', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const letter = (t: string) => <text x="12" y="17.6" textAnchor="middle" fontSize={t.length > 1 ? 4.6 : 6.4} fontWeight="800" fill="#fff" fontFamily="Segoe UI, sans-serif">{t}</text>;
const kinds: [RegExp, string, ReactNode][] = [
  [/^(txt|text|log|nfo|md|markdown|rtf)$/, '#7A7D90', <path {...S} d="M9 12.5h6M9 15h6M9 17.5h4" />],
  [/^(dll|sys|drv|ocx|so|dylib|lib|pdb)$/, '#5B6478', <g {...S}><circle cx="12" cy="15" r="1.6" /><path d="M12 11.4v1.2M12 17.4v1.2M8.4 15h1.2M14.4 15h1.2M9.5 12.5l.8.8M13.7 16.7l.8.8M9.5 17.5l.8-.8M13.7 13.3l.8-.8" /></g>],
  [/^(cfg|ini|conf|config|inf|reg|properties|env|toml|ya?ml)$/, '#8A6BD8', <g {...S}><path d="M8.5 12.5h7M8.5 15.2h7M8.5 17.9h7" /><circle cx="10.5" cy="12.5" r=".9" fill="#fff" /><circle cx="13.8" cy="15.2" r=".9" fill="#fff" /><circle cx="11.2" cy="17.9" r=".9" fill="#fff" /></g>],
  [/^(bat|cmd|ps1|psm1|sh|bash|vbs)$/, '#2F3440', <path {...S} d="m8.8 12.6 2.4 2.2-2.4 2.2M12.6 17.4h3" />],
  [/^(exe|msi|msix|appx|com|scr)$/, '#22B39B', <g {...S}><rect x="8.3" y="11.5" width="7.4" height="7" rx="1" /><path d="M8.3 13.4h7.4" /></g>],
  [/^(png|jpe?g|jfif|gif|webp|bmp|svg|ico|heic|heif|avif|tiff?|psd|raw|dng)$/, '#4C86F0', <g><path d="m8.4 18.2 2.6-3.2 1.9 2 1.1-1.2 1.6 2.4Z" fill="#fff" /><circle cx="14.3" cy="12.6" r="1.1" fill="#fff" /></g>],
  [/^(mp4|mkv|mov|avi|webm|wmv|m4v|flv)$/, '#9150E8', <path d="m10.5 12 4.6 3-4.6 3Z" fill="#fff" />],
  [/^(mp3|wav|flac|ogg|oga|opus|m4a|aac|wma)$/, '#D94B95', <path {...S} d="M11 17.6v-5.2l4-1v5.2m-4 1a1.2 1.2 0 1 1-1.2-1.2M15 16.6a1.2 1.2 0 1 1-1.2-1.2" />],
  [/^pdf$/, '#E0534A', letter('PDF')],
  [/^(docx?|odt|dotx?)$/, '#2B6BE0', letter('W')],
  [/^(xlsx?|xlsm|ods|csv|tsv)$/, '#1E8E4F', letter('X')],
  [/^(pptx?|odp)$/, '#D9612B', letter('P')],
  [/^(json|jsonc|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rs|c|cpp|cc|h|hpp|cs|java|kt|go|rb|php|lua|swift|dart|sql|vue|svelte)$/, '#6D63E8', <path {...S} d="m10.2 12.6-2 2.4 2 2.4M13.8 12.6l2 2.4-2 2.4" />],
  [/^(ttf|otf|woff2?|fon)$/, '#B5547A', letter('Aa')],
  [/^(iso|img|vhdx?|dmg)$/, '#5C7C99', <g {...S}><circle cx="12" cy="15" r="3.4" /><circle cx="12" cy="15" r=".8" fill="#fff" /></g>],
  [/^(db|sqlite3?|mdb|accdb)$/, '#B07A2E', <g {...S}><ellipse cx="12" cy="12.6" rx="3.2" ry="1.1" /><path d="M8.8 12.6v4.8c0 .6 1.4 1.1 3.2 1.1s3.2-.5 3.2-1.1v-4.8M8.8 15c0 .6 1.4 1.1 3.2 1.1s3.2-.5 3.2-1.1" /></g>],
  [/^(url|lnk|website|webloc)$/, '#3E8FD8', <path {...S} d="M10.8 15.6 13.6 12.8M12.3 11.6l.7-.7a1.9 1.9 0 0 1 2.7 2.7l-.7.7M11.7 16.4l-.7.7a1.9 1.9 0 0 1-2.7-2.7l.7-.7" />],
  [/^(torrent)$/, '#4FA35C', <path {...S} d="M12 11.6v5.4m-2.4-2.4L12 17l2.4-2.4" />],
];

/** Archives that Delta opens as folders: drawn as a zipped folder (see FolderIcon `zip`). */
const ARCHIVE_EXT = /^(zip|7z|rar|tar|gz|tgz|xz|txz|bz2|tbz2?|zst|cab)$/;

export function FileIcon({ name, size = 18 }: { name: string; size?: number }) {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (ARCHIVE_EXT.test(ext)) return <FolderIcon size={size} zip />;
  const k = kinds.find(([re]) => re.test(ext));
  const color = k?.[1];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="ficon">
      {/* Same build as FolderIcon: lighter body, darker fold, the faint Delta facet, white glyph */}
      <path d="M6 2.5h8.5L19 7v13.3c0 .7-.5 1.2-1.2 1.2H6.2c-.7 0-1.2-.5-1.2-1.2V3.7c0-.7.5-1.2 1.2-1.2Z" style={{ fill: color ?? 'var(--file-page)' }} />
      <path d="M14.5 2.5V6c0 .6.4 1 1 1H19Z" style={{ fill: color ? `color-mix(in srgb, ${color} 62%, black)` : 'var(--file-fold)' }} />
      <path d="M6 2.5h5l-2 2H5v-.8c0-.7.5-1.2 1.2-1.2Z" fill="#fff" opacity=".14" />
      {k ? k[2] : <path d="M8.5 13h7M8.5 15.5h7M8.5 18h4.5" fill="none" stroke="var(--file-fold)" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

// ---- real previews from the Windows shell (served by the thumb:// protocol in src-tauri/src/thumbs.rs) ----
const PREVIEW = /^(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|jfif|raw|cr2|nef|arw|dng|mp4|mkv|mov|avi|webm|wmv|m4v|pdf|psd)$/;
const REAL_ICON = /^(exe|lnk|ico|cur|msi|url|appref-ms|scr|cpl)$/;

const thumbUrl = (path: string, px: number, kind: 't' | 'i', mtime: number) =>
  `${convertFileSrc(path, 'thumb')}?s=${Math.min(512, Math.round(px * (window.devicePixelRatio || 1)))}&k=${kind}&m=${mtime}&v=2`;

/**
 * File visual: a real thumbnail (grid view, photos/videos/PDFs), the app's own icon (exe/lnk/ico),
 * otherwise the Delta file icon. Any failure falls back to the Delta icon.
 */
export function FileVisual({ name, path, mtime, size, grid }: { name: string; path: string; mtime: number; size: number; grid: boolean }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const kind = path.startsWith('remote:') ? null : grid && PREVIEW.test(ext) ? 't' : REAL_ICON.test(ext) ? 'i' : null; // no shell previews of server files
  useEffect(() => { setFailed(false); setAttempt(0); }, [path, mtime]);
  if (!kind || failed) return <FileIcon name={name} size={size} />;
  return (
    <img
      className={kind === 't' ? 'thumb' : 'ficon'}
      src={thumbUrl(path, size, kind, mtime) + (attempt ? `&r=${attempt}` : '')}
      width={size}
      height={size}
      alt=""
      decoding="async"
      draggable={false}
      // App icons can fail transiently while many load at once: retry once before falling back.
      onError={() => (kind === 'i' && attempt === 0 ? setTimeout(() => setAttempt(1), 600) : setFailed(true))}
    />
  );
}
