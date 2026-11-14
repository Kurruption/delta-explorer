//! Thin command layer: validates input, moves blocking work off the UI thread, returns pages.
mod batch;
mod details;
mod elevate;
mod jobs;
mod preview;
mod power;
mod remote;
mod thumbs;
mod tools;
mod cleaner;
mod watch;
mod wins;

use de_core::{Entry, Place, SortKey};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
};
use tauri::{Emitter, Manager};

/// Listings that aren't one folder: recursive search ("search:<root>?<query>") and lists the UI provides
/// ("v:<key>", for Tags and Recent). Their entries use absolute paths as names; PageDto.path is "".
const SEARCH: &str = "search:";
const VIRTUAL: &str = "v:";
const SEARCH_LIMIT: usize = 20_000;
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);
/// Latest search per root folder.
static SEARCHES: std::sync::LazyLock<Mutex<HashMap<String, u64>>> = std::sync::LazyLock::new(Default::default);
/// Cached listings kept at most; older ones are dropped (each search keystroke makes a new one).
const MAX_CACHED: usize = 40;

#[derive(Default)]
struct Virtuals(Mutex<HashMap<String, Vec<PathBuf>>>);

fn entry_for(p: &Path) -> Option<Entry> {
    let m = std::fs::metadata(p).ok()?;
    let attrs = std::os::windows::fs::MetadataExt::file_attributes(&m);
    Some(Entry::from_meta(de_core::display(p), &m, attrs))
}

/// Loads the raw entries behind a path: a real folder, a search, or a virtual list.
fn load_entries(path: &str, virtuals: &Virtuals, remotes: &de_remote::Pool) -> Result<Vec<Entry>, String> {
    if de_remote::is_remote(path) { return remote::list(remotes, path); }
    if let Some(rest) = path.strip_prefix(SEARCH) {
        let (root, q) = rest.split_once('?').ok_or("bad search")?;
        // A newer search of the same folder (the next keystroke) stops this one; the other pane's search doesn't.
        let gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let key = root.to_lowercase();
        SEARCHES.lock().unwrap().insert(key.clone(), gen);
        let cancelled = || SEARCHES.lock().unwrap().get(&key) != Some(&gen);
        return Ok(de_core::transfer::search(Path::new(root), q, true, SEARCH_LIMIT, &cancelled));
    }
    if path.starts_with(de_core::archive::PREFIX) { return tools::archive_entries(path); }
    if let Some(key) = path.strip_prefix(VIRTUAL) {
        let paths = virtuals.0.lock().unwrap().get(key).cloned().unwrap_or_default();
        return Ok(paths.iter().filter_map(|p| entry_for(p)).collect());
    }
    let dir = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    de_core::list_dir(&dir).map_err(|e| format!("{path}: {e}"))
}

/// One folder as the UI currently sees it: the raw listing plus the sorted/filtered view it pages through.
#[derive(Clone)]
struct View {
    base: Arc<Vec<Entry>>,
    shown: Arc<Vec<Entry>>,
    key: SortKey,
    desc: bool,
    filter: String,
    show_hidden: bool,
    opts: details::ListOpts,
    groups: Arc<Vec<de_core::details::Group>>,
}

/// Listings stay in Rust; the UI requests pages of them.
/// Capped at MAX_CACHED entries (see list_dir).
#[derive(Default)]
struct Listings(Mutex<HashMap<PathBuf, View>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageDto {
    path: String,
    total: usize,
    offset: usize,
    entries: Vec<Entry>,
    /// Empty unless the listing is grouped.
    groups: Arc<Vec<de_core::details::Group>>,
}

/// Runs filesystem work on the blocking pool so the UI thread never waits on disk.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri maps each argument to a named IPC field
async fn list_dir(
    state: tauri::State<'_, Listings>,
    virtuals: tauri::State<'_, Arc<Virtuals>>,
    remotes: tauri::State<'_, remote::Remotes>,
    path: String,
    offset: usize,
    limit: usize,
    refresh: bool,
    sort: Option<SortKey>,
    desc: Option<bool>,
    filter: Option<String>,
    show_hidden: Option<bool>,
    opts: Option<details::ListOpts>,
) -> Result<PageDto, String> {
    let opts = opts.unwrap_or_default();
    let (key, desc, filter) = (sort.unwrap_or_default(), desc.unwrap_or(false), filter.unwrap_or_default());
    let show_hidden = show_hidden.unwrap_or(false);
    let limit = limit.min(1000); // the UI never needs more than a screenful or two
    // Real folders are cached under their canonical path; pseudo paths under themselves.
    let pseudo = path.starts_with(SEARCH) || path.starts_with(VIRTUAL) || path.starts_with(de_core::archive::PREFIX);
    // Remote folders ("remote:<id>/<path>") are cached under their cleaned form and page like local ones.
    let remote = de_remote::parse(&path).map(|(id, p)| de_remote::make(id, &p));
    let key_path = if pseudo { PathBuf::from(&path) } else if let Some(r) = &remote { PathBuf::from(r) } else { std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))? };
    let shown_path = if pseudo { String::new() } else if let Some(r) = remote { r } else { de_core::display(&key_path) };
    let cached = (!refresh).then(|| state.0.lock().unwrap().get(&key_path).cloned()).flatten();
    let (entries, groups) = match cached {
        Some(v) if v.key == key && v.desc == desc && v.filter == filter && v.show_hidden == show_hidden && v.opts == opts => (v.shown, v.groups),
        other => {
            let base = other.map(|v| v.base);
            let f = filter.clone();
            let virtuals = virtuals.inner().clone();
            let o = opts.clone();
            let remotes = remotes.inner().clone();
            let view = blocking(move || {
                // Only order/filter changed: reuse the listing, don't hit the disk.
                let mut base = match base {
                    Some(b) => (*b).clone(),
                    None => load_entries(&path, &virtuals, &remotes)?,
                };
                let mut keys = vec![(key, desc)];
                keys.extend(o.then.filter(|&t| t != key).map(|t| (t, o.then_desc)));
                de_core::sort_by(&mut base, &keys);
                let (shown, groups) = de_core::details::group(de_core::filter(&base, &f, show_hidden), o.group, &o.bounds, &o.collapsed);
                Ok(View { base: Arc::new(base), shown: Arc::new(shown), key, desc, filter: f, show_hidden, opts: o, groups: Arc::new(groups) })
            })
            .await?;
            let shown = (view.shown.clone(), view.groups.clone());
            let mut cache = state.0.lock().unwrap();
            // shortcut: drops everything when full instead of true LRU; open views just re-read their folder.
            if cache.len() >= MAX_CACHED && !cache.contains_key(&key_path) { cache.clear(); }
            cache.insert(key_path.clone(), view);
            shown
        }
    };
    let p = de_core::page(&entries, offset, limit);
    Ok(PageDto { path: shown_path, total: p.total, offset: p.offset, entries: p.entries.to_vec(), groups })
}

/// Sets the paths behind "v:<key>" (Tags, Recent).
#[tauri::command]
fn set_virtual(virtuals: tauri::State<'_, Arc<Virtuals>>, key: String, paths: Vec<PathBuf>) {
    virtuals.0.lock().unwrap().insert(key, paths);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Places {
    home: String,
    quick: Vec<Place>,
    drives: Vec<de_shell::Drive>,
    cloud: Vec<Place>,
}

/// Cloud folders that exist on this PC (OneDrive, Dropbox, Google Drive, iCloud).
fn cloud_places(home: &Path) -> Vec<Place> {
    let mut out: Vec<Place> = Vec::new();
    let mut add = |name: &str, p: PathBuf| {
        if p.is_dir() && !out.iter().any(|x| Path::new(&x.path) == p) {
            out.push(Place { name: name.into(), path: de_core::display(&p) });
        }
    };
    for (var, name) in [("OneDriveConsumer", "OneDrive"), ("OneDriveCommercial", "OneDrive (work)"), ("OneDrive", "OneDrive")] {
        if let Ok(v) = std::env::var(var) { add(name, PathBuf::from(v)); }
    }
    add("Dropbox", home.join("Dropbox"));
    add("Google Drive", home.join("Google Drive"));
    add("iCloud Drive", home.join("iCloudDrive"));
    for d in de_shell::drives() {
        if d.label.to_lowercase().contains("google drive") { add("Google Drive", PathBuf::from(&d.path)); }
    }
    out
}

#[tauri::command]
async fn places() -> Result<Places, String> {
    blocking(|| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
        let quick = de_shell::known_folders().into_iter().map(|(name, p)| Place { name: name.into(), path: de_core::display(&p) }).collect();
        Ok(Places { quick, drives: de_shell::drives(), cloud: cloud_places(home.as_ref()), home })
    })
    .await
}

fn s(r: std::io::Result<impl Sized>) -> Result<(), String> {
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_path(path: PathBuf) -> Result<(), String> {
    blocking(move || de_shell::open(&path)).await
}
#[tauri::command]
async fn properties(path: PathBuf) -> Result<(), String> {
    blocking(move || de_shell::properties(&path)).await
}
#[tauri::command]
/// Creates `name`, or "name (2)" etc. if taken; returns the name actually used so the UI can start renaming it.
async fn create_dir(remotes: tauri::State<'_, remote::Remotes>, parent: PathBuf, name: String) -> Result<String, String> {
    if let Some((id, dir)) = remote::parse(&parent) { return remote::create_dir(remotes.inner().clone(), id, dir, name).await; }
    blocking(move || {
        let free = de_core::ops::free_name(&parent, &name);
        let used = free.file_name().unwrap().to_string_lossy().into_owned();
        de_core::ops::create_dir(&parent, &used).map_err(|e| e.to_string())?;
        Ok(used)
    })
    .await
}
#[tauri::command]
async fn rename(remotes: tauri::State<'_, remote::Remotes>, path: PathBuf, name: String) -> Result<String, String> {
    if let Some((id, p)) = remote::parse(&path) { return remote::rename(remotes.inner().clone(), id, p, name.clone()).await.map(|()| name); }
    // Returns the name actually used ("Name (1).txt" when the typed one was taken).
    blocking(move || de_core::ops::rename(&path, &name).map(|to| to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name)).map_err(|e| e.to_string())).await
}
/// Starts copy | move | zip | extract in the background; progress arrives as "job" events.
#[tauri::command]
fn start_job(app: tauri::AppHandle, window: tauri::Window, jobs: tauri::State<'_, Arc<jobs::Jobs>>, remotes: tauri::State<'_, remote::Remotes>, kind: String, items: Vec<PathBuf>, dest: Option<PathBuf>) -> Result<u64, String> {
    jobs.inner().start(app, window.label().to_string(), kind, items, dest, remotes.inner().clone())
}
#[tauri::command]
fn cancel_job(jobs: tauri::State<'_, Arc<jobs::Jobs>>, id: u64) {
    jobs.cancel(id);
}
/// Undo of a delete: puts items back from the Recycle Bin.
#[tauri::command]
async fn restore(paths: Vec<PathBuf>) -> Result<usize, String> {
    blocking(move || de_shell::native::restore(&paths)).await
}
#[tauri::command]
async fn recycle(paths: Vec<PathBuf>) -> Result<(), String> {
    blocking(move || de_shell::recycle(&paths)).await
}

#[tauri::command]
async fn apps_for(path: PathBuf) -> Result<Vec<de_shell::open_with::App>, String> {
    blocking(move || de_shell::open_with::apps_for(&path)).await
}
#[tauri::command]
async fn open_with(path: PathBuf, app: String) -> Result<(), String> {
    blocking(move || de_shell::open_with::open_with(&path, &app)).await
}
#[tauri::command]
async fn choose_app(path: PathBuf) -> Result<(), String> {
    blocking(move || de_shell::open_with::choose_app(&path)).await
}

/// Saves an edited image from the viewer. Body = encoded image bytes (raw IPC, no JSON);
/// headers: `path` (url-encoded target) and `mode` = "overwrite" | "copy". Returns the path written.
/// Writes a temp file next to the target first, then swaps it in, so a failed save never leaves a half-written photo.
#[tauri::command]
async fn save_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    // Raw when Tauri's ipc: channel is used; a JSON byte array if it fell back to postMessage.
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(v) => serde_json::from_value(v.clone()).map_err(|_| "expected image bytes")?,
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned());
    let path = PathBuf::from(header("path").ok_or("missing path")?);
    let copy = header("mode").as_deref() == Some("copy");
    let replaced = !copy && path.exists();
    if !matches!(thumbs::image_mime(&path), Some("image/png" | "image/jpeg" | "image/webp")) {
        return Err("only PNG, JPEG and WebP can be saved".into());
    }
    blocking(move || {
        let dir = path.parent().ok_or("bad path")?;
        let target = if copy {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let ext = path.extension().unwrap_or_default().to_string_lossy();
            de_core::ops::free_name(dir, &format!("{stem} (edited).{ext}"))
        } else {
            path.clone()
        };
        let tmp = dir.join(format!(".{}.delta-tmp", target.file_name().unwrap_or_default().to_string_lossy()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        // Replacing: the original goes to the Recycle Bin first (recoverable), never silently overwritten.
        if replaced {
            if let Err(e) = de_shell::recycle(std::slice::from_ref(&target)) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("couldn't keep a copy of the original, nothing was changed: {e}"));
            }
        }
        std::fs::rename(&tmp, &target).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("{}: {e}", target.display()) })?;
        Ok(de_core::display(&target))
    })
    .await
}

/// Windows' own right-click menu (7-Zip, VS Code, Git, Send to...). x/y are page coordinates.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri maps each argument to a named IPC field
async fn shell_menu(app: tauri::AppHandle, window: tauri::WebviewWindow, folder: PathBuf, items: Vec<PathBuf>, x: f64, y: f64, extended: bool) -> Result<(), String> {
    let pos = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (sx, sy) = (pos.x + (x * scale) as i32, pos.y + (y * scale) as i32);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(de_shell::native::show_menu(hwnd, &folder, &items, sx, sy, extended));
    })
    .map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())?).await
}

/// Windows' right-click menu entries for Delta to draw in its own "Show more options" menu.
#[tauri::command]
async fn shell_menu_items(app: tauri::AppHandle, window: tauri::WebviewWindow, folder: PathBuf, items: Vec<PathBuf>, extended: bool) -> Result<Vec<de_shell::native::NativeItem>, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(de_shell::native::menu_items(hwnd, &folder, &items, extended)); }).map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())?).await
}

/// Runs one entry from `shell_menu_items`. x/y are page coordinates (some extensions place their own windows there).
#[tauri::command]
async fn shell_menu_invoke(app: tauri::AppHandle, window: tauri::WebviewWindow, id: u32, x: f64, y: f64) -> Result<(), String> {
    let pos = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (sx, sy) = (pos.x + (x * scale) as i32, pos.y + (y * scale) as i32);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(de_shell::native::menu_invoke(hwnd, id, sx, sy)); }).map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())?).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Integration {
    win_e: bool,
    autostart: bool,
}

#[tauri::command]
fn integration(app: tauri::AppHandle) -> Integration {
    use tauri_plugin_autostart::ManagerExt;
    Integration { win_e: de_shell::native::win_e_is_set(), autostart: app.autolaunch().is_enabled().unwrap_or(false) }
}
/// Win+E opens Delta (per-user, reversible; the uninstaller removes it too).
#[tauri::command]
fn set_win_e(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    de_shell::native::set_win_e(on.then_some(exe.as_path()))
}
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
}
/// Registers the global shortcut that brings Delta to the front ("" turns it off).
#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, keys: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if !keys.is_empty() {
        gs.register(keys.as_str()).map_err(|e| format!("{keys}: {e}"))?;
    }
    Ok(())
}
/// Folder Delta was launched with (e.g. from a shortcut), if any.
#[tauri::command]
fn launch_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).exists())
}

fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(w) = wins::target(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// See-through window (Settings → Window opacity): Windows' acrylic blur or mica behind the UI.
#[tauri::command]
fn set_window_effect(window: tauri::WebviewWindow, effect: String) -> Result<(), String> {
    use tauri::window::{Effect, EffectsBuilder};
    let fx = match effect.as_str() {
        "acrylic" => Some(EffectsBuilder::new().effect(Effect::Acrylic).build()),
        "mica" => Some(EffectsBuilder::new().effect(Effect::Mica).build()),
        _ => None,
    };
    window.set_effects(fx).map_err(|e| e.to_string())
}

/// Undo of "Replace original" in the viewer: the edited file becomes "name (edited).ext" and the
/// original comes back from the Recycle Bin. Returns where the edited version now lives.
#[tauri::command]
async fn revert_replace(path: PathBuf) -> Result<String, String> {
    blocking(move || {
        let dir = path.parent().ok_or("bad path")?;
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = path.extension().unwrap_or_default().to_string_lossy();
        let edited = de_core::ops::free_name(dir, &format!("{stem} (edited).{ext}"));
        std::fs::rename(&path, &edited).map_err(|e| format!("{}: {e}", path.display()))?;
        if let Err(e) = de_shell::native::restore(std::slice::from_ref(&path)).and_then(|n| if n == 0 { Err("the original isn't in the Recycle Bin any more".into()) } else { Ok(()) }) {
            let _ = std::fs::rename(&edited, &path); // put things back as they were
            return Err(e);
        }
        Ok(de_core::display(&edited))
    })
    .await
}

/// Shift+Delete: removes items for good (the UI confirms first). A link/junction is removed, never what it points to.
#[tauri::command]
async fn delete_forever(remotes: tauri::State<'_, remote::Remotes>, paths: Vec<PathBuf>) -> Result<(), String> {
    if paths.iter().any(|p| remote::parse(p).is_some()) {
        let items = paths.iter().map(|p| remote::parse(p).ok_or("can't mix local and remote items")).collect::<Result<Vec<_>, _>>()?;
        return remote::delete(remotes.inner().clone(), items).await;
    }
    blocking(move || de_core::ops::remove_forever(&paths)).await
}

/// Files on the Windows clipboard (copied in Explorer or another app), and whether they were cut.
#[tauri::command]
async fn clip_read() -> Result<Option<(Vec<String>, bool)>, String> {
    blocking(|| Ok(de_shell::clip::read_files()?.map(|(f, cut)| (f.iter().map(|p| de_core::display(p)).collect(), cut)))).await
}
/// Puts files on the Windows clipboard so Explorer and other apps can paste them.
#[tauri::command]
async fn clip_write(paths: Vec<PathBuf>, cut: bool) -> Result<(), String> {
    blocking(move || de_shell::clip::write_files(&paths, cut)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    path: String,
    is_dir: bool,
}
/// Turns what someone typed or pasted into the address bar into a real location: strips quotes
/// ("Copy as path"), expands %VARS%, accepts forward slashes, and follows shortcuts.
#[tauri::command]
async fn resolve_path(input: String) -> Result<Resolved, String> {
    blocking(move || {
        let t = input.trim().trim_matches('"').trim();
        let t = de_shell::clip::expand_env(t).replace('/', "\\");
        let mut p = PathBuf::from(&t);
        if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
            if let Some(target) = de_shell::clip::resolve_link(&p) { p = target; }
        }
        let c = std::fs::canonicalize(&p).map_err(|_| format!("Couldn't find “{t}”"))?;
        Ok(Resolved { path: de_core::display(&c), is_dir: c.is_dir() })
    })
    .await
}
/// Where a shortcut points (so folder shortcuts open inside Delta).
#[tauri::command]
async fn link_target(path: PathBuf) -> Result<Option<Resolved>, String> {
    blocking(move || Ok(de_shell::clip::resolve_link(&path).filter(|t| t.exists()).map(|t| Resolved { is_dir: t.is_dir(), path: de_core::display(&t) }))).await
}

/// Which of these paths still exist (Recent drops files that were deleted or moved).
#[tauri::command]
async fn existing(paths: Vec<PathBuf>) -> Result<Vec<bool>, String> {
    blocking(move || Ok(paths.iter().map(|p| p.exists()).collect())).await
}

#[tauri::command]
async fn bin_list() -> Result<Vec<de_shell::native::BinItem>, String> {
    blocking(de_shell::native::bin_list).await
}
#[tauri::command]
async fn bin_restore(ids: Vec<String>) -> Result<(), String> {
    blocking(move || de_shell::native::bin_restore(&ids)).await
}
#[tauri::command]
async fn bin_purge(ids: Vec<String>) -> Result<(), String> {
    blocking(move || de_shell::native::bin_purge(&ids)).await
}

#[tauri::command]
fn watch_dirs(window: tauri::Window, state: tauri::State<'_, watch::Watch>, paths: Vec<PathBuf>) {
    state.set_for(window.label(), paths);
}

/// Drags files out of the window into other apps (Explorer, Discord, editors...) via OLE DoDragDrop.
/// Runs on the UI thread as OLE requires; blocks it for the drag, exactly like a native drag does.
#[tauri::command]
async fn start_drag(app: tauri::AppHandle, window: tauri::WebviewWindow, paths: Vec<PathBuf>) -> Result<bool, String> {
    // Items inside a browsed archive are unpacked to temp first, so other apps get real files.
    let paths = blocking(move || tools::real_paths(paths)).await?;
    let first = paths.first().cloned().ok_or("nothing to drag")?;
    let icon = blocking(move || de_shell::thumb::image(&first, 64, de_shell::thumb::Kind::Icon)).await.unwrap_or_default();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let done = tx.clone();
        let r = drag::start_drag(
            &window,
            drag::DragItem::Files(paths),
            drag::Image::Raw(icon),
            move |res, _| { let _ = done.send(Ok(matches!(res, drag::DragResult::Dropped))); },
            drag::Options::default(), // copy: dragging out never removes the originals
        );
        if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
    })
    .map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())?).await
}

/// The elevated helper (`--elevated-op <request.json>`, see elevate.rs): one operation, then exit.
pub fn elevated_main(file: Option<&std::ffi::OsStr>) -> i32 {
    elevate::helper_main(file)
}

// ---------------- shell extras (Share, terminals, shortcuts, Send to) ----------------

/// Runs `f(hwnd)` on the UI thread (COM/WinRT UI pieces need it) and waits for its result.
async fn on_ui<T: Send + 'static>(app: &tauri::AppHandle, window: &tauri::WebviewWindow, f: impl FnOnce(isize) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(f(hwnd)); }).map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())?).await
}
/// Windows' Share sheet for these items.
#[tauri::command]
async fn share(app: tauri::AppHandle, window: tauri::WebviewWindow, paths: Vec<PathBuf>) -> Result<(), String> {
    on_ui(&app, &window, move |h| de_shell::extras::share(h, &paths)).await
}
/// kind: "wt" (Windows Terminal, else PowerShell) | "powershell" | "cmd".
#[tauri::command]
async fn open_terminal(dir: PathBuf, kind: String) -> Result<(), String> {
    blocking(move || de_shell::extras::open_terminal(&dir, &kind)).await
}
/// "X - Shortcut.lnk" next to each item; returns the shortcuts made.
#[tauri::command]
async fn create_shortcut(paths: Vec<PathBuf>) -> Result<Vec<String>, String> {
    blocking(move || paths.iter().map(|p| de_shell::extras::create_shortcut(p).map(|l| de_core::display(&l))).collect()).await
}
#[tauri::command]
async fn send_to_targets() -> Result<Vec<de_shell::extras::SendTarget>, String> {
    blocking(|| Ok(de_shell::extras::send_to_targets())).await
}
/// Drops items on a Send To entry. Only entries of the user's SendTo folder are accepted.
#[tauri::command]
async fn send_to(app: tauri::AppHandle, window: tauri::WebviewWindow, target: PathBuf, paths: Vec<PathBuf>) -> Result<(), String> {
    if !de_shell::extras::send_to_targets().iter().any(|t| Path::new(&t.path) == target) { return Err("not a Send to entry".into()); }
    on_ui(&app, &window, move |h| de_shell::extras::send_to(h, &target, &paths)).await
}
/// Writes an exported settings file into Downloads (never over an existing file); returns its path.
#[tauri::command]
async fn write_export(name: String, text: String) -> Result<String, String> {
    blocking(move || {
        de_core::ops::validate_name(&name).map_err(|e| e.to_string())?;
        if !name.to_lowercase().ends_with(".json") { return Err("exports are .json files".into()); }
        let dir = de_shell::known_folders().into_iter().find(|(n, _)| *n == "Downloads").map(|(_, p)| p).ok_or("no Downloads folder")?;
        let to = de_core::ops::free_name(&dir, &name);
        std::fs::write(&to, text).map_err(|e| format!("{}: {e}", to.display()))?;
        Ok(de_core::display(&to))
    })
    .await
}

pub fn run() {
    use tauri_plugin_global_shortcut::ShortcutState;
    let thumbs = thumbs::Thumbs::start();
    tauri::Builder::default()
        // A second launch (Win+E, a shortcut) reuses this window and opens a tab instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let path = argv.iter().skip(1).find(|a| !a.starts_with('-') && Path::new(a).exists()).cloned().unwrap_or_default();
            if let Some(w) = wins::target(app) { let _ = app.emit_to(w.label(), "open-path", path); }
            bring_to_front(app);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, ev| {
                    if ev.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Toggle: focused -> minimize, otherwise bring to front.
                    match wins::target(app) {
                        Some(w) if w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) => {
                            let _ = w.minimize();
                        }
                        _ => bring_to_front(app),
                    }
                })
                .build(),
        )
        .manage(Listings::default())
        .manage(Arc::new(Virtuals::default()))
        .manage(Arc::new(jobs::Jobs::default()))
        .manage(details::Details::default())
        .manage(remote::Remotes::default())
        .manage(wins::Wins::default())
        .on_window_event(|w, ev| match ev {
            tauri::WindowEvent::Focused(true) => *w.state::<wins::Wins>().last.lock().unwrap() = w.label().to_string(),
            tauri::WindowEvent::Destroyed => { if let Some(st) = w.try_state::<watch::Watch>() { st.set_for(w.label(), vec![]); } }
            _ => {}
        })
        .manage(Arc::new(tools::Tools::default()))
        .register_asynchronous_uri_scheme_protocol("thumb", move |_ctx, req, responder| {
            thumbs.handle(req, Box::new(move |res| responder.respond(res)));
        })
        .register_asynchronous_uri_scheme_protocol("raw", |_ctx, req, responder| {
            preview::handle(req, move |res| responder.respond(res));
        })
        .setup(|app| {
            app.manage(watch::Watch::start(app.handle().clone())?);
            // Safety net: if the UI never gets to show the (initially hidden) window, show it anyway.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = h.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) { let _ = w.show(); }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir, set_virtual, places, open_path, properties, create_dir, rename, recycle, restore, start_job, cancel_job, watch_dirs,
            start_drag, apps_for, open_with, choose_app, save_image, shell_menu, shell_menu_items, shell_menu_invoke, integration, set_win_e, set_autostart, set_hotkey, launch_path, set_window_effect, revert_replace, bin_list, bin_restore, bin_purge,
            clip_read, clip_write, resolve_path, link_target, delete_forever, existing,
            preview::preview_text, preview::preview_zip, preview::dir_count,
            batch::rename_preview, batch::rename_apply, batch::resolve_conflict, batch::create_dirs, batch::clip_has_data, batch::paste_clip,
            power::list_subdirs, power::git_status, power::git_changed, power::compare_dirs, power::compare_contents, power::plan_sync, power::start_sync, power::diff_files, power::read_meta, power::write_audio_tags,
            details::media_info, details::folder_sizes, details::cancel_folder_sizes, details::free_space, details::count_items,
            remote::remote_configure, remote::remote_set_secret, remote::remote_forget, remote::remote_test, remote::remote_open,
            elevate::run_elevated, wins::new_window, wins::window_init, wins::window_at_cursor,
            share, open_terminal, create_shortcut, send_to_targets, send_to, write_export,
            tools::start_archive_job, tools::start_extract_job, tools::archive_open, tools::tool_cancel, tools::checksums, tools::find_dupes, tools::storage_scan, tools::storage_view,
            cleaner::cleaner_preview, cleaner::cleaner_run, cleaner::cleaner_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running Delta Explorer");
}
