//! Details view helpers: grouping a sorted listing, and folder sizes (parallel, cancellable walk).
use crate::Entry;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Condvar, Mutex,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupBy {
    #[default]
    None,
    Type,
    Modified,
    Size,
    Letter,
}

/// One run of items in a grouped listing. `key` is stable (the UI turns it into a label and remembers collapsed keys);
/// `start`/`shown` index the visible listing (a collapsed group has `shown` 0 but keeps its `count`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub key: String,
    pub start: usize,
    pub count: usize,
    pub shown: usize,
}

const KB: u64 = 1024;
const MB: u64 = KB * 1024;
const GB: u64 = MB * 1024;

/// Group order and key for one entry. `bounds` = local starts of [today, yesterday, this week, last week, this month] (epoch secs).
fn key_of(e: &Entry, by: GroupBy, bounds: &[u64; 5]) -> (u8, String) {
    let base = e.name.rsplit('\\').next().unwrap_or(&e.name); // search results use full paths
    match by {
        GroupBy::None => (0, String::new()),
        GroupBy::Type if e.is_dir => (0, "folder".into()),
        GroupBy::Type => match base.rsplit_once('.') {
            Some((stem, x)) if !stem.is_empty() => (1, x.to_lowercase()),
            _ => (1, String::new()),
        },
        GroupBy::Modified => {
            let n = bounds.iter().position(|&b| e.modified >= b).unwrap_or(5) as u8;
            (n, n.to_string())
        }
        GroupBy::Size if e.is_dir => (0, "folder".into()),
        GroupBy::Size => {
            let n = [0, 16 * KB, MB, 128 * MB, GB, 4 * GB].iter().position(|&lim| e.size <= lim).unwrap_or(6) as u8;
            (n + 1, ["empty", "tiny", "small", "medium", "large", "huge", "gigantic"][n as usize].into())
        }
        GroupBy::Letter => match base.chars().next() {
            Some(c) if c.is_alphabetic() => (2, c.to_uppercase().collect()),
            Some(c) if c.is_ascii_digit() => (1, "0-9".into()),
            _ => (0, "#".into()),
        },
    }
}

/// Reorders an already-sorted listing into groups (stable: each group keeps the sort order), drops the items of
/// `collapsed` groups, and returns the groups. `None` grouping returns no groups and leaves the listing alone.
pub fn group(entries: Vec<Entry>, by: GroupBy, bounds: &[u64; 5], collapsed: &[String]) -> (Vec<Entry>, Vec<Group>) {
    if by == GroupBy::None {
        return (entries, Vec::new());
    }
    let mut keyed: Vec<((u8, String), Entry)> = entries.into_iter().map(|e| (key_of(&e, by, bounds), e)).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::with_capacity(keyed.len());
    let mut groups: Vec<Group> = Vec::new();
    for ((_, key), e) in keyed {
        if groups.last().is_none_or(|g| g.key != key) {
            groups.push(Group { shown: 0, count: 0, start: out.len(), key });
        }
        let g = groups.last_mut().unwrap();
        g.count += 1;
        if !collapsed.contains(&g.key) {
            g.shown += 1;
            out.push(e);
        }
    }
    (out, groups)
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirSize {
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
}

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Total size of everything under `root`, walked by `threads` workers sharing one queue of folders.
/// Junctions and symlinks are counted as items but never followed (no loops, no double counting).
/// Returns None if `cancelled` was set before it finished.
pub fn dir_size(root: &Path, threads: usize, cancelled: &AtomicBool) -> Option<DirSize> {
    let queue = Mutex::new(vec![root.to_path_buf()]);
    let wake = Condvar::new();
    let busy = AtomicUsize::new(0); // workers currently reading a folder (they may add more work)
    let (bytes, files, dirs) = (AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0));
    let work = || loop {
        let dir: PathBuf = {
            let mut q = queue.lock().unwrap();
            loop {
                if cancelled.load(Ordering::Relaxed) { wake.notify_all(); return; }
                if let Some(d) = q.pop() { busy.fetch_add(1, Ordering::SeqCst); break d; }
                if busy.load(Ordering::SeqCst) == 0 { wake.notify_all(); return; }
                q = wake.wait(q).unwrap();
            }
        };
        let (mut b, mut f, mut found) = (0, 0, Vec::new());
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Ok(m) = e.metadata() else { continue };
            let attrs = std::os::windows::fs::MetadataExt::file_attributes(&m);
            if m.is_dir() && !m.file_type().is_symlink() && attrs & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
                found.push(e.path());
            } else {
                f += 1;
                if !m.is_dir() { b += m.len(); }
            }
        }
        bytes.fetch_add(b, Ordering::Relaxed);
        files.fetch_add(f, Ordering::Relaxed);
        dirs.fetch_add(found.len() as u64, Ordering::Relaxed);
        let mut q = queue.lock().unwrap();
        q.extend(found);
        busy.fetch_sub(1, Ordering::SeqCst);
        wake.notify_all();
    };
    std::thread::scope(|s| {
        for _ in 0..threads.max(1) { s.spawn(work); }
    });
    (!cancelled.load(Ordering::Relaxed)).then(|| DirSize { bytes: bytes.into_inner(), files: files.into_inner(), dirs: dirs.into_inner() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(name: &str, is_dir: bool, size: u64, modified: u64) -> Entry {
        Entry { name: name.into(), is_dir, size, modified, hidden: false, created: 0, accessed: 0, attrs: 0 }
    }

    #[test]
    fn groups_keep_sort_order_and_collapse() {
        let l = vec![e("b.txt", false, 5, 0), e("Zed", true, 0, 0), e("a.png", false, 2 * MB, 0), e("c.TXT", false, 0, 0), e("noext", false, 1, 0)];
        let b = [0; 5];
        let (out, g) = group(l.clone(), GroupBy::Type, &b, &[]);
        let names: Vec<_> = out.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Zed", "noext", "a.png", "b.txt", "c.TXT"]);
        assert_eq!(g.iter().map(|g| (g.key.as_str(), g.start, g.count)).collect::<Vec<_>>(), [("folder", 0, 1), ("", 1, 1), ("png", 2, 1), ("txt", 3, 2)]);

        let (out, g) = group(l.clone(), GroupBy::Type, &b, &["txt".into()]);
        assert_eq!(out.len(), 3);
        assert_eq!(g[3], Group { key: "txt".into(), start: 3, count: 2, shown: 0 });

        let (_, g) = group(l.clone(), GroupBy::Size, &b, &[]);
        assert_eq!(g.iter().map(|g| g.key.as_str()).collect::<Vec<_>>(), ["folder", "empty", "tiny", "medium"]);
        let (_, g) = group(l.clone(), GroupBy::Letter, &b, &[]);
        assert_eq!(g.iter().map(|g| g.key.as_str()).collect::<Vec<_>>(), ["A", "B", "C", "N", "Z"]);
        let (out, g) = group(l, GroupBy::None, &b, &[]);
        assert!(g.is_empty() && out.len() == 5);
    }

    #[test]
    fn date_buckets() {
        let bounds = [1000, 900, 800, 700, 600]; // today, yesterday, this week, last week, this month
        let l = vec![e("old", false, 0, 1), e("now", false, 0, 2000), e("yday", false, 0, 950), e("lastwk", false, 0, 750)];
        let (out, g) = group(l, GroupBy::Modified, &bounds, &[]);
        assert_eq!(out.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["now", "yday", "lastwk", "old"]);
        assert_eq!(g.iter().map(|g| g.key.as_str()).collect::<Vec<_>>(), ["0", "1", "3", "5"]);
    }

    #[test]
    fn sizes_folders_in_parallel() {
        let d = std::env::temp_dir().join(format!("de-core-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        for i in 0..20 {
            let sub = d.join(format!("s{i}")).join("deep");
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("f.bin"), vec![0u8; 100]).unwrap();
        }
        fs::write(d.join("top.bin"), b"12345").unwrap();
        let no = AtomicBool::new(false);
        assert_eq!(dir_size(&d, 4, &no), Some(DirSize { bytes: 2005, files: 21, dirs: 40 }));
        assert_eq!(dir_size(&d, 1, &no).unwrap().bytes, 2005);
        assert_eq!(dir_size(&d, 4, &AtomicBool::new(true)), None);
        fs::remove_dir_all(&d).unwrap();
    }
}
