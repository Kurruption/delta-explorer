//! Archives (browse, extract, create), checksums, duplicate finder and storage analyser.
//! Long scans report "tool-progress" events ({id, done, current}) and stop when `tool_cancel(id)` is called;
//! the UI picks the id so it can cancel before the result arrives.
use crate::jobs::{self, Emit, Jobs};
use de_core::{
    archive::{self, Format},
    dupes, hash, storage,
    transfer::{self, Sink},
    Entry,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter};

/// Where items taken out of archives (open, drag out, copy out) are unpacked.
pub fn temp_root() -> PathBuf { std::env::temp_dir().join("Delta Explorer").join("archives") }

// ---------- jobs ----------
pub(crate) fn compress(e: &mut Emit, items: &[PathBuf], format: Format, level: u32, password: Option<&str>) -> io::Result<()> {
    archive::only_folders(items)?;
    e.upd.total = transfer::measure(items).0;
    let dir = items[0].parent().ok_or_else(|| io::Error::other("bad path"))?;
    // Folder names can contain dots ("v1.2"): use the whole name, not the stem.
    let stem = if items.len() == 1 { items[0].file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default() } else { "Archive".into() };
    let target = de_core::ops::free_name(dir, &format!("{stem}.{}", format.ext()));
    let z = archive::create(items, &target, format, level, password, e)?;
    e.upd.created = vec![jobs::s(&z)];
    Ok(())
}

/// mode: "folder" = into a new "Name" folder next to the archive, "here" = next to it, "to" = a new
/// "Name" folder inside `dest`. Items inside a browsed archive ("archive:" paths) extract just those.
pub(crate) fn extract(e: &mut Emit, items: &[PathBuf], mode: &str, dest: Option<&Path>) -> io::Result<()> {
    let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let mut whole = Vec::new();
    for p in items {
        match archive::parse_virtual(&p.to_string_lossy()) {
            Some((f, inner)) if inner.is_empty() => whole.push(f),
            Some((f, inner)) => match groups.iter_mut().find(|g| g.0 == f) { Some(g) => g.1.push(inner), None => groups.push((f, vec![inner])) },
            None => whole.push(p.clone()),
        }
    }
    for z in &whole { e.upd.total += archive::progress_total(z)?; }
    for (z, _) in &groups { e.upd.total += archive::progress_total(z)?; }
    for z in &whole {
        match (mode, dest) {
            ("here", _) => { let made = archive::extract_here(z, e)?; e.upd.created.extend(made.iter().map(|p| jobs::s(p))); }
            ("to", Some(d)) => { let x = archive::extract_to(z, d, e)?; e.upd.created.push(jobs::s(&x)); }
            _ => { let x = archive::extract(z, e)?; e.upd.created.push(jobs::s(&x)); }
        }
    }
    for (z, sel) in &groups {
        let to = match dest { Some(d) => d.to_path_buf(), None => z.parent().ok_or_else(|| io::Error::other("bad path"))?.to_path_buf() };
        let x = archive::extract_selected(z, sel, &to, e)?;
        e.upd.created.push(jobs::s(&x));
    }
    Ok(())
}

/// Compress folders into zip / 7z / tar.gz. level 0–9; password only for zip and 7z.
#[tauri::command]
pub fn start_archive_job(app: AppHandle, window: tauri::Window, jobs: tauri::State<'_, Arc<Jobs>>, items: Vec<PathBuf>, format: Format, level: u32, password: Option<String>) -> Result<u64, String> {
    archive::only_folders(&items).map_err(|e| e.to_string())?;
    let label = format!("Compressing {} to {}", jobs::things(&items), format.ext());
    Ok(jobs.inner().run(app, window.label().to_string(), "zip".into(), label, move |e| compress(e, &items, format, level, password.as_deref())))
}

/// Extract archives (or items inside a browsed archive); see `extract` for `mode`.
#[tauri::command]
pub fn start_extract_job(app: AppHandle, window: tauri::Window, jobs: tauri::State<'_, Arc<Jobs>>, items: Vec<PathBuf>, mode: String, dest: Option<PathBuf>) -> Result<u64, String> {
    if items.is_empty() { return Err("nothing selected".into()); }
    if mode == "to" && !dest.as_ref().is_some_and(|d| d.is_dir()) { return Err("Pick a folder that exists".into()); }
    let label = format!("Extracting {}", jobs::things(&items.iter().map(|p| archive::parse_virtual(&p.to_string_lossy()).map_or(p.clone(), |(f, i)| if i.is_empty() { f } else { PathBuf::from(i) })).collect::<Vec<_>>()));
    Ok(jobs.inner().run(app, window.label().to_string(), "extract".into(), label, move |e| extract(e, &items, &mode, dest.as_deref())))
}

// ---------- browsing ----------
type Listing = (PathBuf, SystemTime, u64, Arc<Vec<archive::Item>>);
/// The last archive listed, so moving between its folders doesn't re-read it.
static LAST: std::sync::LazyLock<Mutex<Option<Listing>>> = std::sync::LazyLock::new(Default::default);

/// Entries of "archive:<file>?<inner>"; names are full archive: paths (like search results).
pub fn archive_entries(path: &str) -> Result<Vec<Entry>, String> {
    let (file, inner) = archive::parse_virtual(path).ok_or("bad archive path")?;
    let m = std::fs::metadata(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let stamp = (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len());
    let cached = LAST.lock().unwrap().as_ref().filter(|c| c.0 == file && (c.1, c.2) == stamp).map(|c| c.3.clone());
    let items = match cached {
        Some(i) => i,
        None => {
            let i = Arc::new(archive::list(&file).map_err(|e| e.to_string())?);
            *LAST.lock().unwrap() = Some((file.clone(), stamp.0, stamp.1, i.clone()));
            i
        }
    };
    let f = file.to_string_lossy();
    Ok(archive::children(&items, &inner).into_iter().map(|i| Entry {
        name: archive::virtual_path(&f, &i.path),
        is_dir: i.is_dir,
        size: i.size,
        modified: i.modified,
        hidden: false,
        ..Default::default()
    }).collect())
}

/// Silent sink for unpacking to temp (open / drag out).
struct Quiet;
impl Sink for Quiet {
    fn bytes(&mut self, _: u64) {}
    fn item(&mut self, _: &Path) {}
    fn cancelled(&self) -> bool { false }
}
/// Archive paths become real (temp) files; real paths pass through.
pub fn real_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    if !paths.iter().any(|p| p.to_string_lossy().starts_with(archive::PREFIX)) { return Ok(paths); }
    archive::materialize(&paths, &temp_root(), &mut Quiet).map_err(|e| e.to_string())
}

/// Opens a file inside an archive: unpacks it to temp, then opens it with its default app.
#[tauri::command]
pub async fn archive_open(path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = real_paths(vec![path])?.pop().ok_or("nothing to open")?;
        de_shell::open(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- scans with progress ----------
#[derive(Default)]
pub struct Tools {
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    scans: Mutex<Vec<(u64, Arc<storage::Scan>)>>,
}

#[derive(Serialize, Clone)]
struct Progress { id: u64, done: u64, current: String }
struct ToolSink { app: AppHandle, id: u64, done: u64, current: String, last: Instant, cancel: Arc<AtomicBool> }
impl ToolSink {
    fn send(&mut self) {
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            let _ = self.app.emit("tool-progress", Progress { id: self.id, done: self.done, current: self.current.clone() });
        }
    }
}
impl Sink for ToolSink {
    fn bytes(&mut self, n: u64) { self.done += n; self.send(); }
    fn item(&mut self, p: &Path) { self.current = de_core::display(p); self.send(); }
    fn cancelled(&self) -> bool { self.cancel.load(Ordering::Relaxed) }
}

async fn with_sink<T: Send + 'static>(app: AppHandle, tools: &Arc<Tools>, id: u64, f: impl FnOnce(&mut ToolSink) -> io::Result<T> + Send + 'static) -> Result<T, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    tools.cancels.lock().unwrap().insert(id, cancel.clone());
    let mut sink = ToolSink { app, id, done: 0, current: String::new(), last: Instant::now(), cancel };
    let r = tauri::async_runtime::spawn_blocking(move || f(&mut sink)).await.map_err(|e| e.to_string());
    tools.cancels.lock().unwrap().remove(&id);
    r?.map_err(|e| if e.kind() == io::ErrorKind::Interrupted { "cancelled".into() } else { e.to_string() })
}

#[tauri::command]
pub fn tool_cancel(tools: tauri::State<'_, Arc<Tools>>, id: u64) {
    if let Some(c) = tools.cancels.lock().unwrap().get(&id) { c.store(true, Ordering::Relaxed); }
}

#[tauri::command]
pub async fn checksums(app: AppHandle, tools: tauri::State<'_, Arc<Tools>>, id: u64, path: PathBuf) -> Result<hash::Sums, String> {
    if !path.is_file() { return Err("Checksums work on a file".into()); }
    with_sink(app, tools.inner(), id, move |s| hash::checksums(&path, s)).await
}

#[tauri::command]
pub async fn find_dupes(app: AppHandle, tools: tauri::State<'_, Arc<Tools>>, id: u64, root: PathBuf) -> Result<Vec<dupes::DupGroup>, String> {
    if !root.is_dir() { return Err("Pick a folder to search for duplicates".into()); }
    with_sink(app, tools.inner(), id, move |s| dupes::find(&root, s)).await
}

#[tauri::command]
pub async fn storage_scan(app: AppHandle, tools: tauri::State<'_, Arc<Tools>>, id: u64, root: PathBuf) -> Result<storage::Summary, String> {
    let t = tools.inner().clone();
    let scan = with_sink(app, &t, id, move |s| storage::Scan::run(&root, s)).await?;
    let summary = scan.summary.clone();
    let mut all = t.scans.lock().unwrap();
    all.retain(|(k, _)| *k != id);
    if all.len() >= 2 { all.remove(0); } // a drive scan can be big: keep only the latest few
    all.push((id, Arc::new(scan)));
    Ok(summary)
}

/// One folder of a finished scan (for the treemap).
#[tauri::command]
pub fn storage_view(tools: tauri::State<'_, Arc<Tools>>, id: u64, dir: PathBuf) -> Result<Vec<storage::Node>, String> {
    let all = tools.scans.lock().unwrap();
    let scan = all.iter().find(|(k, _)| *k == id).ok_or("That scan is no longer available; scan again")?;
    scan.1.view(&dir).ok_or_else(|| "Folder not in this scan".into())
}
