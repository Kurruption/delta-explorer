//! Details view commands: list options (secondary sort, grouping), media columns, folder sizes, free space.
use de_core::{details::{DirSize, GroupBy}, SortKey};
use de_shell::props::Media;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager};

/// Extra `list_dir` options from the Details view. Part of the cached view's identity.
#[derive(Debug, Deserialize, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ListOpts {
    /// Secondary sort (Shift+click a header).
    pub then: Option<SortKey>,
    pub then_desc: bool,
    pub group: GroupBy,
    /// Local starts of today, yesterday, this week, last week, this month (epoch secs), for date groups.
    pub bounds: [u64; 5],
    /// Group keys whose items are left out of the listing.
    pub collapsed: Vec<String>,
}

const CACHE_MAX: usize = 20_000;

#[derive(Default)]
pub struct Details {
    /// path -> (mtime, info): a changed file is read again.
    media: Mutex<HashMap<PathBuf, (u64, Media)>>,
    sizes: Mutex<HashMap<PathBuf, (u64, DirSize)>>,
    /// One cancel flag per pane; navigating away cancels its walks.
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn mtime(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64)
}

/// Dimensions / duration for a batch of files (the visible rows), from the cache or the Windows property handlers.
#[tauri::command]
pub async fn media_info(app: tauri::AppHandle, paths: Vec<PathBuf>) -> Result<Vec<Media>, String> {
    if paths.len() > 500 { return Err("too many files at once".into()); }
    super::blocking(move || {
        let d = app.state::<Details>();
        Ok(paths.iter().map(|p| {
            let t = mtime(p);
            if let Some((m, info)) = d.media.lock().unwrap().get(p) { if *m == t { return *info; } }
            let info = de_shell::props::media(p);
            let mut c = d.media.lock().unwrap();
            if c.len() >= CACHE_MAX { c.clear(); } // shortcut: wholesale reset instead of LRU; entries are cheap to re-read
            c.insert(p.clone(), (t, info));
            info
        }).collect())
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SizeEvent {
    path: String,
    #[serde(flatten)]
    size: DirSize,
}

/// Starts computing folder sizes in the background; each result arrives as a "folder-size" event.
/// Cached by path + folder mtime. shortcut: a change deep inside doesn't bump the folder's own mtime; "Calculate size" refreshes it.
#[tauri::command]
pub fn folder_sizes(app: tauri::AppHandle, state: tauri::State<'_, Details>, key: String, paths: Vec<PathBuf>, fresh: Option<bool>) -> Result<(), String> {
    if paths.len() > 1000 { return Err("too many folders at once".into()); }
    let token = state.tokens.lock().unwrap().entry(key).or_default().clone();
    let fresh = fresh.unwrap_or(false);
    std::thread::spawn(move || {
        let d = app.state::<Details>();
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
        for p in paths {
            if token.load(Ordering::Relaxed) { return; }
            if !p.is_dir() { continue; }
            let t = mtime(&p);
            let hit = (!fresh).then(|| d.sizes.lock().unwrap().get(&p).filter(|(m, _)| *m == t).map(|(_, s)| *s)).flatten();
            let Some(size) = hit.or_else(|| de_core::details::dir_size(&p, threads, &token)) else { return };
            {
                let mut c = d.sizes.lock().unwrap();
                if c.len() >= CACHE_MAX { c.clear(); }
                c.insert(p.clone(), (t, size));
            }
            let _ = app.emit("folder-size", SizeEvent { path: p.to_string_lossy().into_owned(), size });
        }
    });
    Ok(())
}

/// Stops the folder-size walks a pane started (it navigated away).
#[tauri::command]
pub fn cancel_folder_sizes(state: tauri::State<'_, Details>, key: String) {
    if let Some(t) = state.tokens.lock().unwrap().remove(&key) { t.store(true, Ordering::Relaxed); }
}

#[tauri::command]
pub async fn free_space(path: PathBuf) -> Result<Option<u64>, String> {
    super::blocking(move || Ok(de_shell::props::free_space(&path))).await
}

/// Items directly inside a folder (hover cards).
#[tauri::command]
pub async fn count_items(path: PathBuf) -> Result<usize, String> {
    super::blocking(move || Ok(std::fs::read_dir(&path).map_err(|e| e.to_string())?.count())).await
}
