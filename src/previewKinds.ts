// Which preview a file gets (by extension), and a tiny syntax highlighter for the text preview.
// Pure (no React, no Tauri) so `node --test tests/` can check it.

export type PreviewKind = 'image' | 'svg' | 'text' | 'pdf' | 'video' | 'audio' | 'font' | 'zip' | 'other';

const KINDS: [RegExp, PreviewKind][] = [
  [/^(png|jpe?g|jfif|webp|gif|bmp|avif|ico)$/, 'image'], // what thumb:?k=f serves (api.ts VIEWABLE)
  [/^svgz?$/, 'svg'], // drawn as a picture, with its code one click away
  [/^pdf$/, 'pdf'],
  [/^(mp4|m4v|mov|webm|ogv)$/, 'video'],
  [/^(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/, 'audio'],
  [/^(ttf|otf|woff2?)$/, 'font'],
  [/^zip$/, 'zip'],
];
const CODE = 'js mjs cjs jsx ts mts cts tsx json jsonc json5 css scss less html htm xml svg xaml csproj vcxproj props targets resx rs c h cc cpp hpp cxx cs java kt kts go swift dart php vue svelte py pyw rb pl lua r sh bash zsh ps1 psm1 psd1 bat cmd sql yml yaml toml ini cfg conf env properties gradle cmake mk reg tex'.split(' ');
const PLAIN = 'txt text log md markdown csv tsv nfo srt vtt diff patch lock gitignore gitattributes editorconfig npmrc'.split(' ');
const TEXT = new Set([...CODE, ...PLAIN]);
/** Extension-less files that are usually text. */
const TEXT_NAMES = /^(readme|license|licence|changelog|authors|notice|makefile|dockerfile|procfile|gemfile|rakefile|vagrantfile|cname|todo)$/i;

export const extOf = (name: string) => {
  const b = name.split('\\').pop() ?? name;
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : b.startsWith('.') ? b.slice(1).toLowerCase() : '';
};

export function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  const k = KINDS.find(([re]) => re.test(ext));
  if (k) return k[1];
  if (TEXT.has(ext)) return 'text';
  const base = name.split('\\').pop() ?? name;
  return !base.includes('.') && TEXT_NAMES.test(base) ? 'text' : 'other';
}

// ---- highlighter ----
// One regex per language family: [comment, string, number, word]. Good enough to colour, not a parser.
const STR = String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
const BACKTICK = String.raw`|\x60(?:\\.|[^\x60\\])*\x60?`;
const NUM = String.raw`\b\d[\w.]*`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;
const EOF = String.raw`(?![\s\S])`; // end of the whole text ('$' is end of line with the m flag)
const C = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|${EOF})`;
const HASH = String.raw`#[^\n]*`;
const FAMILY: Record<string, [string, string]> = {
  c: [C, STR + BACKTICK],
  rust: [C, String.raw`"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\\n])'`], // single quotes are chars, not lifetimes
  hash: [HASH, STR],
  markup: [String.raw`<!--[\s\S]*?(?:-->|${EOF})`, String.raw`"[^"\n]*"?|'[^'\n]*'?`],
  sql: [String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|${EOF})`, STR],
  ini: [String.raw`^\s*[;#][^\n]*`, String.raw`"[^"\n]*"?`],
  json: ['(?!)', String.raw`"(?:\\.|[^"\\\n])*"?`],
  md: [String.raw`^#{1,6}\s[^\n]*`, String.raw`\x60[^\x60\n]*\x60`],
};
const FAMILY_OF: Record<string, keyof typeof FAMILY> = {
  rs: 'rust', py: 'hash', pyw: 'hash', rb: 'hash', pl: 'hash', r: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', ps1: 'hash', psm1: 'hash', psd1: 'hash',
  yml: 'hash', yaml: 'hash', toml: 'hash', conf: 'hash', env: 'hash', properties: 'hash', cmake: 'hash', mk: 'hash', gitignore: 'hash', gitattributes: 'hash', editorconfig: 'ini', npmrc: 'ini',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xaml: 'markup', csproj: 'markup', vcxproj: 'markup', props: 'markup', targets: 'markup', resx: 'markup', vue: 'markup', svelte: 'markup',
  sql: 'sql', lua: 'sql', ini: 'ini', cfg: 'ini', reg: 'ini', json: 'json', md: 'md', markdown: 'md',
};
const KEYWORDS = new Set(
  ('abstract and as async await break case catch class const continue crate def default defer del delete do elif else enum except export extends ' +
    'extern false final finally fn for foreach from func function go if impl implements import in instanceof interface is lambda let loop match mod ' +
    'module mut namespace new nil none None not null or package pass private protected pub public raise ref return self Self static struct super switch ' +
    'then this throw throws trait true True False try type typeof undefined union unsafe use using var void where while with yield').split(' '),
);
const cache = new Map<string, RegExp | null>();
function regexFor(ext: string): RegExp | null {
  if (cache.has(ext)) return cache.get(ext)!;
  const fam = FAMILY_OF[ext] ?? (CODE.includes(ext) ? 'c' : ext === 'md' || ext === 'markdown' ? 'md' : null);
  const re = fam ? new RegExp(`(${FAMILY[fam][0]})|(${FAMILY[fam][1]})|(${NUM})|${WORD}`, 'gm') : null;
  cache.set(ext, re);
  return re;
}

/** Token classes: c comment, s string, n number, k keyword, '' plain. */
export type Token = [cls: string, text: string];
/** Lines of tokens. Plain-text types come back as one plain token per line. */
export function highlight(text: string, ext: string): Token[][] {
  text = text.replace(/\r\n?/g, '\n');
  const lines: Token[][] = [[]];
  const push = (cls: string, s: string) => {
    s.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last[0] === cls) last[1] += part; else line.push([cls, part]);
    });
  };
  const re = regexFor(ext);
  let at = 0;
  if (re) {
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      if (m.index > at) push('', text.slice(at, m.index));
      const cls = m[1] !== undefined ? (ext === 'md' || ext === 'markdown' ? 'k' : 'c') : m[2] !== undefined ? 's' : m[3] !== undefined ? 'n' : KEYWORDS.has(m[0]) ? 'k' : '';
      push(cls, m[0]);
      at = m.index + m[0].length;
    }
  }
  push('', text.slice(at));
  return lines;
}
