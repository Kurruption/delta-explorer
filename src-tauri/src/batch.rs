//! Commands for batch rename, conflict answers, creating several folders and pasting clipboard text/pictures as files.
use super::blocking;
use de_core::rename::{self, Item, Recipe};
use serde::Serialize;
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

fn secs(t: std::io::Result<SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    to: String,
    /// Why this rename can't happen (Apply stays disabled while any row has one).
    problem: Option<String>,
}

/// New name and problem for each path, for the dialog's live preview. `tz`: minutes east of UTC, for dates.
#[tauri::command]
pub async fn rename_preview(paths: Vec<PathBuf>, recipe: Recipe, tz: i64) -> Result<Vec<Row>, String> {
    blocking(move || {
        let items: Vec<Item> = paths
            .iter()
            .map(|p| {
                let m = fs::metadata(p).ok();
                Item {
                    name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    is_dir: m.as_ref().is_some_and(|m| m.is_dir()),
                    modified: m.as_ref().map_or(0, |m| secs(m.modified())),
                    created: m.as_ref().map_or(0, |m| secs(m.created())),
                }
            })
            .collect();
        let names = rename::build(&items, &recipe, tz)?;
        let problems = rename::check(&paths, &names, &|p| fs::symlink_metadata(p).is_ok());
        Ok(names.into_iter().zip(problems).map(|(to, problem)| Row { to, problem }).collect())
    })
    .await
}

#[derive(Serialize)]
pub struct Applied {
    done: Vec<(String, String)>,
    failed: Vec<(String, String)>,
}

/// Renames (path, new name) pairs in two phases; refuses the batch if any name is bad or clashes.
#[tauri::command]
pub async fn rename_apply(pairs: Vec<(PathBuf, String)>) -> Result<Applied, String> {
    blocking(move || {
        let o = rename::apply(&pairs)?;
        Ok(Applied {
            done: o.done.iter().map(|(a, b)| (de_core::display(a), de_core::display(b))).collect(),
            failed: o.failed.iter().map(|(a, why)| (de_core::display(a), why.clone())).collect(),
        })
    })
    .await
}

#[tauri::command]
pub fn resolve_conflict(jobs: tauri::State<'_, std::sync::Arc<super::jobs::Jobs>>, id: u64, choice: de_core::transfer::Choice, all: bool) {
    jobs.answer(id, choice, all);
}

/// One folder per line ("a\b" nests). Returns the new topmost folders, for undo.
#[tauri::command]
pub async fn create_dirs(parent: PathBuf, names: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || Ok(de_core::ops::create_dirs(&parent, &names).map_err(|e| e.to_string())?.iter().map(|p| de_core::display(p)).collect())).await
}

#[tauri::command]
pub async fn clip_has_data() -> bool {
    blocking(|| Ok(de_shell::clip::has_text_or_image())).await.unwrap_or(false)
}

/// Clipboard text -> "Pasted text.txt", a picture -> "Pasted image.png" in `dir` (" (2)" etc. if taken).
/// Returns the new file, or None when the clipboard holds neither.
#[tauri::command]
pub async fn paste_clip(dir: PathBuf) -> Result<Option<String>, String> {
    blocking(move || {
        if !dir.is_dir() { return Err(format!("{}: not a folder", dir.display())); }
        let (name, bytes) = match de_shell::clip::read_text_or_image()? {
            None => return Ok(None),
            Some(de_shell::clip::Pasted::Text(t)) => ("Pasted text.txt", t.into_bytes()),
            Some(de_shell::clip::Pasted::Png(b)) => ("Pasted image.png", b),
        };
        let target = de_core::ops::free_name(&dir, name);
        let mut f = fs::File::create_new(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        std::io::Write::write_all(&mut f, &bytes).map_err(|e| { let _ = fs::remove_file(&target); format!("{}: {e}", target.display()) })?;
        Ok(Some(de_core::display(&target)))
    })
    .await
}
