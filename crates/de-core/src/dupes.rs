//! Duplicate finder: same size, then same first 64 KiB, then same full SHA-256.
use crate::transfer::{cancelled, Sink};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::Path,
    time::UNIX_EPOCH,
};

const PARTIAL: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DupFile {
    pub path: String,
    pub modified: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub size: u64,
    pub files: Vec<DupFile>,
}

/// Every non-empty file under `root` (links and junctions are not followed), by size.
fn by_size(root: &Path, sink: &mut dyn Sink) -> io::Result<HashMap<u64, Vec<DupFile>>> {
    let mut m: HashMap<u64, Vec<DupFile>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if sink.cancelled() { return Err(cancelled()); }
        sink.item(&dir);
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() { continue; }
            if ft.is_dir() { stack.push(e.path()); continue; }
            let Ok(md) = e.metadata() else { continue };
            if md.len() == 0 { continue; }
            let modified = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            m.entry(md.len()).or_default().push(DupFile { path: crate::display(&e.path()), modified });
        }
    }
    Ok(m)
}

fn hash(p: &Path, limit: u64, sink: &mut dyn Sink) -> io::Result<[u8; 32]> {
    let mut f = fs::File::open(p)?.take(limit);
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if sink.cancelled() { return Err(cancelled()); }
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
        sink.bytes(n as u64);
    }
    Ok(h.finalize().into())
}

/// Splits a group by hash; files that can't be read drop out; singletons are not duplicates.
fn split(files: Vec<DupFile>, limit: u64, sink: &mut dyn Sink) -> io::Result<Vec<Vec<DupFile>>> {
    let mut m: HashMap<[u8; 32], Vec<DupFile>> = HashMap::new();
    for f in files {
        match hash(Path::new(&f.path), limit, sink) {
            Ok(k) => m.entry(k).or_default().push(f),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(e),
            Err(_) => {}
        }
    }
    Ok(m.into_values().filter(|g| g.len() > 1).collect())
}

/// Same-size candidates -> confirmed duplicate groups, most wasted space first.
pub fn group(by_size: HashMap<u64, Vec<DupFile>>, sink: &mut dyn Sink) -> io::Result<Vec<DupGroup>> {
    let mut out = Vec::new();
    for (size, files) in by_size.into_iter().filter(|(_, v)| v.len() > 1) {
        for g in split(files, PARTIAL, sink)? {
            // Small files were read whole already.
            let full = if size <= PARTIAL { vec![g] } else { split(g, u64::MAX, sink)? };
            out.extend(full.into_iter().map(|mut files| { files.sort_by(|a, b| a.path.cmp(&b.path)); DupGroup { size, files } }));
        }
    }
    out.sort_by_key(|g| std::cmp::Reverse(g.size * (g.files.len() as u64 - 1)));
    Ok(out)
}

pub fn find(root: &Path, sink: &mut dyn Sink) -> io::Result<Vec<DupGroup>> {
    let m = by_size(root, sink)?;
    group(m, sink)
}

/// Paths to recycle so that one file per group stays: the newest (`keep_newest`) or the oldest.
pub fn extras(groups: &[DupGroup], keep_newest: bool) -> Vec<String> {
    groups.iter().flat_map(|g| {
        let keep = if keep_newest { g.files.iter().max_by_key(|f| f.modified) } else { g.files.iter().min_by_key(|f| f.modified) };
        g.files.iter().filter(move |f| Some(*f) != keep).map(|f| f.path.clone())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct T;
    impl Sink for T {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { false }
    }

    #[test]
    fn groups_only_true_duplicates() {
        let d = std::env::temp_dir().join("DeltaAgent-storage").join(format!("dupes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("sub")).unwrap();
        let big = vec![7u8; 200_000];
        let mut big2 = big.clone();
        *big2.last_mut().unwrap() = 8; // same size, same first 64 KiB, different end
        fs::write(d.join("a.bin"), &big).unwrap();
        fs::write(d.join("sub/a copy.bin"), &big).unwrap();
        fs::write(d.join("near.bin"), &big2).unwrap();
        fs::write(d.join("x.txt"), b"same").unwrap();
        fs::write(d.join("sub/y.txt"), b"same").unwrap();
        fs::write(d.join("z.txt"), b"diff").unwrap();
        fs::write(d.join("empty1"), b"").unwrap();
        fs::write(d.join("empty2"), b"").unwrap();
        let g = find(&d, &mut T).unwrap();
        assert_eq!(g.len(), 2, "{g:?}");
        assert_eq!(g[0].size, 200_000, "most wasted space first");
        assert_eq!(g[0].files.len(), 2);
        assert!(g[0].files.iter().all(|f| !f.path.ends_with("near.bin")));
        assert_eq!(g[1].files.len(), 2);

        let mut fake = vec![DupGroup { size: 1, files: vec![DupFile { path: "old".into(), modified: 1 }, DupFile { path: "new".into(), modified: 9 }, DupFile { path: "mid".into(), modified: 5 }] }];
        assert_eq!(extras(&fake, true), ["old", "mid"]);
        assert_eq!(extras(&fake, false), ["new", "mid"]);
        fake.clear();
        fs::remove_dir_all(&d).unwrap();
    }
}
