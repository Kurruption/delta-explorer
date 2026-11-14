# Delta Explorer — Architecture

## Decision

**Rust core + Tauri 2 shell + React/TypeScript UI.** Rust owns every filesystem and Windows operation; the WebView only renders. The choice is driven by the measurements below, not by "Rust is fast".

## Options compared

| | Rust + Tauri 2 | Rust + native UI (windows-rs / WinUI via COM, Slint, egui) | C# + WPF |
|---|---|---|---|
| Directory enumeration | Native Rust (measured below) | Native Rust (same core) | .NET `EnumerateFiles` — comparable, GC churn on huge dirs |
| Idle memory | WebView2 process tree (measured below) | Lowest (~10–30 MB) | ~60–120 MB typical |
| UI responsiveness | Good if IPC is paged and lists are virtualized | Excellent, but you write the list virtualization yourself | Good; virtualization built in, slows with complex templates |
| Theming / animation / custom chrome | Best — CSS, mature component ecosystem | Weak: Slint/egui themeable but limited; raw WinUI from Rust is poorly supported | Good (XAML styles), dated look without a lot of work |
| Windows shell integration | Not built in — via `windows` crate (same as native) | Via `windows` crate | Best ergonomics (COM interop, many samples) |
| Maintainability | Two languages, clear typed boundary | One language, UI code verbose | One language, mature tooling |
| Feasibility for this team/tooling | High (Rust + Node installed; MSVC present) | Medium-low: UI toolkit gaps (accessibility, IME, text rendering in egui) | Not measurable here: no .NET SDK installed |

**Why not native Rust UI:** the app's differentiators (custom themes, restrained animation, multiple layouts, tabs) are UI-heavy; none of the Rust native toolkits are at the level of the web stack for that, and accessibility/IME in egui is weak. **Why not WPF:** strongest shell interop, but a dated rendering stack, heavier idle memory than a native Rust app, and no advantage on the hot paths. The shell-integration gap of Tauri is closed by calling the same Win32/COM APIs WPF would use, from Rust.

## Measurements (2026-11-12, this machine, release build, `bench/`)

Single directory listing, name + size + mtime + is_dir, best of 5:

| Directory | `std::fs::read_dir` | `FindFirstFileExW` (basic, large fetch) | jwalk (depth 1) |
|---|---|---|---|
| 100 000 files (synthetic) | 64 ms | 77 ms | 75 ms |
| `C:\Windows\System32` (4 877) | 2.7 ms | 2.5 ms | 3.0 ms |

IPC payload (serde_json): all 100k entries = **7.3 MB / 10.5 ms to serialize**; a 200-row page = **15 KB / 0.01 ms**.

Conclusions:
1. `std::fs` on Windows already uses FindFirstFile data — **no custom Win32 enumeration needed**. Use std; jwalk only for recursive search.
2. The bottleneck for big folders is the boundary, not the disk: 7 MB of JSON plus parsing and React reconciliation. → **Rust keeps the listing; the UI requests sorted/filtered windows (pages) and renders a virtualized list.**
3. Tauri idle memory: about 160 MB private across the process tree; the Rust host itself is 5 MB, the rest is WebView2 (see below).

WPF: not measured — no .NET SDK on this machine. Install it only if the decision is revisited.

## Layout

```
crates/de-core    listing, sort/filter, paging, file ops (copy/move), search — no Tauri dependency
crates/de-shell   Windows integration behind traits (Recycle Bin, context menu, properties, icons)
src-tauri/        thin command layer; typed commands; blocking work on tokio's blocking pool
src/              React + TS; design tokens (CSS custom properties), themes, components
branding/         logo/icon sources and generator
```

Each crate can be replaced independently: the UI only knows the command contract; `de-core` doesn't know Tauri exists.

## Windows integration (implemented)

| Feature | How |
|---|---|
| Recycle Bin + undo | `trash` crate (IFileOperation); undo restores via `trash::os_limited::restore_all` |
| Copy / move with progress & cancel | `CopyFileExW` progress routine (keeps attributes/timestamps); jobs on threads, "job" events every 80 ms |
| Zip / extract | `zip` crate (pure Rust deflate); zip-slip guarded with `enclosed_name` |
| Native context menu | `IShellFolder::GetUIObjectOf` → `IContextMenu`, `TrackPopupMenuEx`; `IContextMenu3::HandleMenuMsg2` via window subclass so "Send to"/"New" draw |
| Open with | `SHAssocEnumHandlers` (recommended) filtered by `AssocGetPerceivedType`; `IAssocHandler::Invoke`; `SHOpenWithDialog` |
| Properties | `SHObjectProperties` |
| Icons / thumbnails | `IShellItemImageFactory`, PNG over a `thumb://` protocol, LRU in Rust |
| Drag out / drop in | OLE `DoDragDrop` (`drag` crate) / Tauri drop events |
| Live refresh | `notify` (ReadDirectoryChangesW), debounced |
| Known folders | `SHGetKnownFolderPath` (follows OneDrive redirection) |
| Global hotkey | `tauri-plugin-global-shortcut` |
| Start with Windows | `tauri-plugin-autostart` |
| Second launch → new tab | `tauri-plugin-single-instance` |
| Win+E | per-user `HKCU\Software\Classes\CLSID\{52205fd8-…}\shell\opennewwindow\command`; removed by the uninstaller hook |
| See-through window | `transparent` window + `set_effects` (acrylic / mica) |

None of these are assumed from Tauri.

## Tauri idle RSS

Release build, home folder (64 items) open, 6 s after launch:

| | Private memory | Working set |
|---|---|---|
| `delta-explorer.exe` (Rust host) | 5.3 MB | — |
| Whole tree (host + 6 WebView2 processes) | 161.6 MB | 386 MB (includes shared pages) |

Exe 7.8 MB, NSIS installer 1.8 MB. WebView2 is the main memory cost, as expected. It is acceptable for a file manager (File Explorer itself is typically 100–200 MB), and the core stays independent if a native UI is ever needed.
