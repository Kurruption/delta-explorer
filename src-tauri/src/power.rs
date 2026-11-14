//! Commands for the power features: folder tree, git status, folder/file compare and sync, metadata.
use de_core::{compare, diff, git, meta};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}
fn canon(p: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Subfolder names of `path`, sorted (sidebar folder tree). Cheap: no sizes, no cache.
#[tauri::command]
pub async fn list_subdirs(path: PathBuf, show_hidden: bool) -> Result<Vec<String>, String> {
    blocking(move || {
        let mut v: Vec<String> = de_core::list_dir(&canon(&path)?).map_err(|e| e.to_string())?
            .into_iter().filter(|e| e.is_dir && (show_hidden || !e.hidden)).map(|e| e.name).collect();
        v.sort_by_key(|n| n.to_lowercase());
        Ok(v)
    })
    .await
}

// ---- git ----
/// git status per repo root, reused for a few seconds (both panes, every folder of the repo).
static GIT: LazyLock<Mutex<HashMap<PathBuf, (Instant, Arc<git::Status>)>>> = LazyLock::new(Default::default);
static NO_GIT: AtomicBool = AtomicBool::new(false);
const GIT_TTL: Duration = Duration::from_secs(4);

fn repo_status(dir: &Path, refresh: bool) -> Option<(PathBuf, String, Arc<git::Status>)> {
    if NO_GIT.load(Ordering::Relaxed) { return None; }
    let dir = PathBuf::from(de_core::display(&std::fs::canonicalize(dir).ok()?));
    let root = git::find_root(&dir)?;
    let rel = dir.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
    if rel == ".git" || rel.starts_with(".git/") { return None; }
    let hit = GIT.lock().unwrap().get(&root).filter(|(at, _)| !refresh && at.elapsed() < GIT_TTL).map(|(_, s)| s.clone());
    let s = match hit {
        Some(s) => s,
        None => {
            let Some(s) = git::status(&root) else {
                // Not installed: stop trying. (A broken repo just shows nothing.)
                if std::process::Command::new("git").arg("--version").output().is_err() { NO_GIT.store(true, Ordering::Relaxed); }
                return None;
            };
            let s = Arc::new(s);
            let mut c = GIT.lock().unwrap();
            if c.len() > 32 { c.clear(); }
            c.insert(root.clone(), (Instant::now(), s.clone()));
            s
        }
    };
    Some((root, rel, s))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDir {
    root: String,
    branch: String,
    /// Lowercase child name -> state.
    items: HashMap<String, git::State>,
    /// Everything here has this state (inside an untracked or ignored folder).
    all: Option<git::State>,
    /// Changed (not ignored) paths in the whole repo.
    changed: usize,
}

#[tauri::command]
pub async fn git_status(dir: PathBuf, refresh: bool) -> Result<Option<GitDir>, String> {
    blocking(move || {
        Ok(repo_status(&dir, refresh).map(|(root, rel, s)| {
            let (items, all) = git::children(&s, &rel);
            let changed = s.entries.iter().filter(|(_, st)| *st != git::State::Ignored).count();
            GitDir { root: de_core::display(&root), branch: s.branch.clone(), items, all, changed }
        }))
    })
    .await
}

/// Absolute paths of every changed (not ignored) item in the repo around `dir` ("Show only changed").
#[tauri::command]
pub async fn git_changed(dir: PathBuf) -> Result<Vec<String>, String> {
    blocking(move || {
        let Some((root, _, s)) = repo_status(&dir, true) else { return Ok(vec![]) };
        Ok(s.entries.iter().filter(|(_, st)| *st != git::State::Ignored)
            .map(|(p, _)| de_core::display(&root.join(p.trim_end_matches('/').replace('/', "\\")))).collect())
    })
    .await
}

// ---- folder compare & sync ----
fn two_dirs(left: &Path, right: &Path) -> Result<(PathBuf, PathBuf), String> {
    let (l, r) = (canon(left)?, canon(right)?);
    if !l.is_dir() || !r.is_dir() { return Err("pick two folders".into()); }
    let (a, b) = (l.to_string_lossy().to_lowercase() + "\\", r.to_string_lossy().to_lowercase() + "\\");
    if a.starts_with(&b) || b.starts_with(&a) { return Err("one folder is inside the other; pick two separate folders".into()); }
    Ok((l, r))
}

#[tauri::command]
pub async fn compare_dirs(left: PathBuf, right: PathBuf) -> Result<Vec<compare::Item>, String> {
    blocking(move || {
        let (l, r) = two_dirs(&left, &right)?;
        compare::compare_dirs(&l, &r).map_err(|e| e.to_string())
    })
    .await
}

/// Byte-compares these files on both sides: true = identical contents.
#[tauri::command]
pub async fn compare_contents(left: PathBuf, right: PathBuf, rels: Vec<String>) -> Result<Vec<bool>, String> {
    blocking(move || {
        let (l, r) = two_dirs(&left, &right)?;
        rels.iter().map(|rel| {
            let p = compare::safe_rel(rel).map_err(|e| e.to_string())?;
            compare::same_contents(&l.join(p), &r.join(p)).map_err(|e| format!("{rel}: {e}"))
        }).collect()
    })
    .await
}

#[tauri::command]
pub fn plan_sync(items: Vec<compare::Item>, mode: compare::Mode) -> Vec<compare::Action> {
    compare::plan(&items, mode)
}

/// Runs a sync plan the user has previewed and confirmed, as a background job.
#[tauri::command]
pub fn start_sync(app: tauri::AppHandle, window: tauri::Window, jobs: tauri::State<'_, Arc<crate::jobs::Jobs>>, left: PathBuf, right: PathBuf, actions: Vec<compare::Action>) -> Result<u64, String> {
    let (l, r) = two_dirs(&left, &right)?;
    for a in &actions { compare::safe_rel(&a.rel).map_err(|e| e.to_string())?; }
    if actions.is_empty() { return Err("nothing to sync".into()); }
    jobs.inner().start_sync(app, window.label().to_string(), l, r, actions)
}

#[tauri::command]
pub async fn diff_files(a: PathBuf, b: PathBuf) -> Result<diff::FileDiff, String> {
    blocking(move || {
        if !a.is_file() || !b.is_file() { return Err("pick two files".into()); }
        diff::diff_files(&a, &b).map_err(|e| e.to_string())
    })
    .await
}

// ---- metadata ----
#[tauri::command]
pub async fn read_meta(path: PathBuf) -> Result<meta::Meta, String> {
    blocking(move || meta::read(&path).map_err(|e| format!("{}: {e}", path.display()))).await
}
#[tauri::command]
pub async fn write_audio_tags(path: PathBuf, tags: meta::AudioTags) -> Result<(), String> {
    blocking(move || {
        if !path.is_file() { return Err("file not found".into()); }
        meta::write_audio_tags(&path, &tags).map_err(|e| format!("couldn't save the tags, the file wasn't changed: {e}"))
    })
    .await
}
