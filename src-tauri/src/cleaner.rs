//! Storage cleaner commands. The UI sends target rules; Rust resolves folders, checks them, and always
//! recomputes what qualifies before deleting (the UI never sends file paths to delete).
//! Temp and Delta's own cache are deleted outright; everything else goes to the Recycle Bin.
use de_core::cleaner;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::SystemTime};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// "temp" | "bin" | "downloads" | "delta" | "custom:<n>"
    pub key: String,
    pub dir: Option<PathBuf>,
    pub days: u32,
    pub pattern: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item { path: String, size: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group { key: String, permanent: bool, items: Vec<Item>, total: u64, error: Option<String> }

fn delta_temp() -> PathBuf { std::env::temp_dir().join("Delta Explorer") }

/// Folders of a target and whether removal is permanent.
fn dirs(t: &Target) -> Result<(Vec<PathBuf>, bool), String> {
    Ok(match t.key.as_str() {
        "temp" => {
            let mut v = vec![std::env::temp_dir()];
            if let Some(w) = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("Temp")) {
                if std::fs::read_dir(&w).is_ok() { v.push(w); } // only when readable without admin
            }
            (v, true)
        }
        "delta" => (vec![delta_temp()], true),
        "downloads" => (de_shell::known_folders().into_iter().filter(|(n, _)| *n == "Downloads").map(|(_, p)| p).collect(), false),
        k if k.starts_with("custom:") => {
            let d = t.dir.clone().ok_or("no folder")?;
            if let Some(why) = cleaner::forbidden(&d, &cleaner::system_protected()) { return Err(why); }
            (vec![d], false)
        }
        _ => return Err(format!("unknown target {}", t.key)),
    })
}

/// What a target would remove now. Bin items use their bin id as path.
fn collect(t: &Target) -> Result<(Vec<Item>, Vec<String>, bool), String> {
    if t.key == "bin" {
        let cutoff = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64) - t.days as i64 * 86_400;
        let old: Vec<_> = de_shell::native::bin_list()?.into_iter().filter(|b| b.deleted < cutoff).collect();
        return Ok((old.iter().map(|b| Item { path: b.original.clone(), size: b.size.unwrap_or(0) }).collect(), old.into_iter().map(|b| b.id).collect(), true));
    }
    let (ds, permanent) = dirs(t)?;
    let days = if t.key == "temp" { t.days.max(1) } else { t.days };
    let mut items = Vec::new();
    for d in ds.iter().filter(|d| d.is_dir()) {
        for c in cleaner::candidates(d, days, t.pattern.as_deref().unwrap_or(""), SystemTime::now()).map_err(|e| e.to_string())? {
            items.push(Item { path: c.path, size: c.size });
        }
    }
    let paths = items.iter().map(|i| i.path.clone()).collect();
    Ok((items, paths, permanent))
}

#[tauri::command]
pub async fn cleaner_preview(targets: Vec<Target>) -> Result<Vec<Group>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        targets.iter().map(|t| match collect(t) {
            Ok((items, _, permanent)) => Group { key: t.key.clone(), permanent, total: items.iter().map(|i| i.size).sum(), items, error: None },
            Err(e) => Group { key: t.key.clone(), permanent: false, items: vec![], total: 0, error: Some(e) },
        }).collect()
    }).await.map_err(|e| e.to_string())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome { freed: u64, removed: usize, skipped: usize, recycled: Vec<String> }

#[tauri::command]
pub async fn cleaner_run(targets: Vec<Target>) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut o = Outcome::default();
        for t in &targets {
            let (items, ids, permanent) = collect(t)?;
            if t.key == "bin" {
                if !ids.is_empty() { de_shell::native::bin_purge(&ids)?; }
                o.freed += items.iter().map(|i| i.size).sum::<u64>();
                o.removed += ids.len();
                continue;
            }
            let mut batch = Vec::new();
            for i in items {
                let p = PathBuf::from(&i.path);
                if cleaner::in_use(&p) { o.skipped += 1; continue; } // never touch files another program has open
                if permanent {
                    if std::fs::remove_file(&p).is_ok() { o.freed += i.size; o.removed += 1; } else { o.skipped += 1; }
                } else {
                    o.freed += i.size;
                    batch.push(p);
                }
            }
            if !batch.is_empty() {
                de_shell::recycle(&batch)?;
                o.removed += batch.len();
                o.recycled.extend(batch.iter().map(|p| de_core::display(p)));
            }
        }
        Ok(o)
    }).await.map_err(|e| e.to_string())?
}

/// Checks a folder before it's added as a custom target.
#[tauri::command]
pub fn cleaner_check(dir: PathBuf) -> Result<(), String> {
    match cleaner::forbidden(&dir, &cleaner::system_protected()) { Some(w) => Err(w), None => Ok(()) }
}
