//! Storage cleaner: picks old files in a target folder (by age and an optional name pattern).
//! Never follows links/junctions, never leaves the folder, refuses dangerous targets.
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub size: u64,
}

fn norm(p: &Path) -> String { crate::display(p).trim_end_matches('\\').to_lowercase() }
fn inside(p: &str, root: &str) -> bool { p == root || p.starts_with(&format!("{root}\\")) }

/// Why a user-chosen folder can't be a target: a drive root, Windows, Program Files (or inside them),
/// or the user profile / an ancestor of it. `protected` = (path, also refuse everything inside it).
pub fn forbidden(dir: &Path, protected: &[(PathBuf, bool)]) -> Option<String> {
    let d = norm(dir);
    let parts = d.split('\\').filter(|s| !s.is_empty()).count();
    if parts <= 1 || d.starts_with(r"\\") && parts <= 3 { return Some("a whole drive can't be cleaned".into()); }
    for (p, deep) in protected {
        let p = norm(p);
        if inside(&p, &d) || (*deep && inside(&d, &p)) { return Some(format!("{} is a protected system location", crate::display(dir))); }
    }
    match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() => Some("links and junctions can't be cleaned".into()),
        Ok(m) if m.is_dir() => None,
        _ => Some("folder not found".into()),
    }
}

/// The standard protected list for this PC.
pub fn system_protected() -> Vec<(PathBuf, bool)> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut v = Vec::new();
    for k in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] { if let Some(p) = env(k) { v.push((p, true)); } }
    if let Some(p) = env("USERPROFILE") { v.push((p, false)); }
    v
}

/// `*` and `?` wildcards, case-insensitive; "" matches everything. Several patterns: "*.log;*.tmp".
pub fn matches(pattern: &str, name: &str) -> bool {
    fn m(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => m(&p[1..], n) || (!n.is_empty() && m(p, &n[1..])),
            (Some('?'), Some(_)) => m(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a == b && m(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let n: Vec<char> = name.to_lowercase().chars().collect();
    pattern.trim().is_empty() || pattern.split(';').map(str::trim).filter(|s| !s.is_empty()).any(|p| m(&p.to_lowercase().chars().collect::<Vec<_>>(), &n))
}

/// Files under `dir` last modified more than `days` ago whose name matches `pattern`.
/// Links and junctions are skipped (neither followed nor deleted).
pub fn candidates(dir: &Path, days: u32, pattern: &str, now: SystemTime) -> io::Result<Vec<Candidate>> {
    let cutoff = now - Duration::from_secs(days as u64 * 86_400);
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() { continue; }
            if ft.is_dir() { stack.push(e.path()); continue; }
            let Ok(m) = e.metadata() else { continue };
            let old = m.modified().is_ok_and(|t| t < cutoff);
            if old && matches(pattern, &e.file_name().to_string_lossy()) {
                out.push(Candidate { path: crate::display(&e.path()), size: m.len() });
            }
        }
    }
    Ok(out)
}

/// True if another program has the file open (opening it with no sharing fails).
pub fn in_use(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    matches!(fs::OpenOptions::new().read(true).share_mode(0).open(p), Err(e) if e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_rules() {
        let d = std::env::temp_dir().join("DeltaAgent-storage").join(format!("clean-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("t/sub")).unwrap();
        fs::create_dir_all(d.join("outside")).unwrap();
        fs::write(d.join("t/a.log"), b"12").unwrap();
        fs::write(d.join("t/sub/b.txt"), b"1").unwrap();
        fs::write(d.join("outside/keep.log"), b"1").unwrap();
        // A junction inside the target pointing outside it: never followed.
        let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(d.join("t/link")).arg(d.join("outside")).output().is_ok_and(|o| o.status.success());
        let later = SystemTime::now() + Duration::from_secs(3 * 86_400);
        let all = candidates(&d.join("t"), 1, "", later).unwrap();
        assert_eq!(all.len(), 2, "{all:?}");
        assert!(all.iter().all(|c| !c.path.contains("outside") && !c.path.contains("link")), "junction ok={ok}");
        assert!(candidates(&d.join("t"), 1, "", SystemTime::now()).unwrap().is_empty(), "too new");
        let logs = candidates(&d.join("t"), 1, "*.LOG; *.tmp", later).unwrap();
        assert_eq!(logs.len(), 1);
        assert!(matches("file?.txt", "File1.txt") && !matches("*.log", "a.log.txt"));
        let prot = vec![(PathBuf::from(r"C:\Windows"), true), (PathBuf::from(r"C:\Users\me"), false)];
        assert!(forbidden(Path::new(r"C:\"), &prot).is_some());
        assert!(forbidden(Path::new(r"C:\Windows\System32"), &prot).is_some());
        assert!(forbidden(Path::new(r"C:\Users"), &prot).is_some(), "ancestor of the profile");
        assert!(forbidden(Path::new(r"c:\users\ME"), &prot).is_some());
        assert!(forbidden(&d.join("t"), &prot).is_none());
        if ok { assert!(forbidden(&d.join("t/link"), &prot).is_some()); }
        fs::remove_dir_all(&d).unwrap();
    }
}
