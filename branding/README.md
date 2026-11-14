# Delta Explorer brand

**Name:** Delta Explorer (always two words, capital D and E). Package/repo: `delta-explorer`. Bundle id: `com.deltaexplorer.desktop`.

**Mark:** a glossy blue-to-violet folder carrying a split-base crystal Δ. At 32 px and below a simplified folder with a solid white Δ is used. The bare Δ (`icon-light/dark/mono`) is for UI chrome. Shapes live in `concepts8.mjs`.

| Token | Hex | Use |
|---|---|---|
| Tile (indigo-violet) | `#4338CA` | icon tile, light-theme accent |
| Facet (lavender) | `#B4ACFF` | shaded facet |
| Tile light | `#6D63E8` | shaded facet of the bare mark on light backgrounds |
| Ink | `#1B1D22` | wordmark on light |
| Dark-theme accent | `#8B83FF` | UI accent on dark backgrounds |

## Files (`dist/`)

| File | Use |
|---|---|
| `icon.svg` / `icon.png` (1024, transparent) | primary app icon (≥32px) |
| `icon-small.svg/.png` | 16/24px: bigger single-tone arrow, facets would blur |
| `delta-explorer.ico` | Windows icon: 16, 24, 32, 48, 64, 128, 256 |
| `icon-light` / `icon-dark` | bare mark (no tile) for light / dark UI |
| `icon-mono` | single colour (stamps, tray, print) |
| `logo-primary(-dark)` | mark + wordmark. The wordmark is live Segoe UI Variable text; outline it before using off-Windows |
| `preview.png` | real-pixel check at 256/48/32/16 on light and dark |



## Regenerate

```bash
pnpm brand
```

It also copies `icon.svg` to `src/assets/` (About page, favicon) and the `.ico` to `src-tauri/icons/icon.ico` (exe, title bar, taskbar, installer, shortcuts). If the mark's shape changes, run `pnpm tauri icon branding/dist/icon.png -o src-tauri/icons` first, then `pnpm brand`.
