//! Watches the folders open in tabs and tells the UI which ones changed (debounced), so views refresh on their own.
use notify::{RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

/// Bursts (a copy of 500 files) collapse into one refresh per folder.
const DEBOUNCE: Duration = Duration::from_millis(250);
/// ...but a folder that never goes quiet (a download in progress) still refreshes at least this often.
const MAX_WAIT: Duration = Duration::from_millis(1500);

pub struct Watch {
    watcher: Mutex<notify::RecommendedWatcher>,
    watched: Mutex<HashSet<PathBuf>>,
    /// Folders each window has open; the watched set is all of them together.
    per_window: Mutex<HashMap<String, Vec<PathBuf>>>,
}

/// Lowercased, no trailing backslash: how the UI and this module compare folder paths.
pub fn norm(p: &Path) -> String {
    let s = de_core::display(p).to_lowercase();
    if s.len() > 3 { s.trim_end_matches('\\').to_string() } else { s.to_string() }
}

impl Watch {
    pub fn start(app: AppHandle) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let watcher = notify::recommended_watcher(tx)?;
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut dirs = HashSet::new();
                let mut add = |ev: notify::Result<notify::Event>| {
                    for p in ev.map(|e| e.paths).unwrap_or_default() {
                        // A change to C:\a\b.txt refreshes C:\a; a change to a watched folder itself refreshes it too.
                        if let Some(parent) = p.parent() { dirs.insert(norm(parent)); }
                        dirs.insert(norm(&p));
                    }
                };
                add(first);
                let start = std::time::Instant::now();
                while start.elapsed() < MAX_WAIT {
                    match rx.recv_timeout(DEBOUNCE) { Ok(ev) => add(ev), Err(_) => break }
                }
                let _ = app.emit("fs-changed", dirs.into_iter().collect::<Vec<_>>());
            }
        });
        Ok(Watch { watcher: Mutex::new(watcher), watched: Mutex::default(), per_window: Mutex::default() })
    }

    /// One window's open folders changed (`paths` empty: it closed).
    pub fn set_for(&self, window: &str, paths: Vec<PathBuf>) {
        let all = {
            let mut m = self.per_window.lock().unwrap();
            if paths.is_empty() { m.remove(window); } else { m.insert(window.to_string(), paths); }
            m.values().flatten().cloned().collect()
        };
        self.set(all);
    }

    /// Makes the watched set exactly `paths` (non-recursive: only what's on screen).
    pub fn set(&self, paths: Vec<PathBuf>) {
        // Parents too: Windows tells a folder's parent, not the folder, when the folder itself is deleted or renamed.
        let want: HashSet<PathBuf> = paths
            .into_iter()
            .filter(|p| p.is_dir())
            .flat_map(|p| [p.parent().map(Path::to_path_buf), Some(p)])
            .flatten()
            .collect();
        let mut have = self.watched.lock().unwrap();
        let mut w = self.watcher.lock().unwrap();
        for p in have.difference(&want) { let _ = w.unwatch(p); }
        for p in want.difference(&have) { let _ = w.watch(p, RecursiveMode::NonRecursive); }
        *have = want;
    }
}

#[cfg(test)]
mod tests {
    use super::norm;
    use std::path::Path;

    #[test]
    fn normalizes_for_comparison() {
        assert_eq!(norm(Path::new(r"C:\Users\Me\")), r"c:\users\me");
        assert_eq!(norm(Path::new(r"\\?\C:\Users")), r"c:\users");
        assert_eq!(norm(Path::new(r"C:\")), r"c:\");
    }
}
