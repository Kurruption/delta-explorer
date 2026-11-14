//! Storage analyser: one recursive size scan of a folder or drive, kept compact (folders only, plus each
//! folder's largest files) so even a whole drive fits in memory; the UI asks for one folder at a time.
use crate::transfer::{cancelled, Sink};
use serde::Serialize;
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
    fs, io,
    path::{Path, PathBuf},
};

/// Files kept per folder for the treemap; the rest are summed as "smaller files".
const FILES_PER_DIR: usize = 40;
const TOP: usize = 100;
const MAX_EMPTY: usize = 1000;

struct Dir {
    name: String,
    parent: usize,
    size: u64,
    subdirs: Vec<usize>,
    files: Vec<(String, u64)>,
    other_size: u64,
    other_count: u64,
}

pub struct Scan {
    root: PathBuf,
    dirs: Vec<Dir>,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub name: String,
    /// "" for the "smaller files" bucket.
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    /// Files summed into this node (the bucket), else 0.
    pub count: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeStat {
    pub ext: String,
    pub size: u64,
    pub count: u64,
}
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub root: String,
    pub total: u64,
    pub files: u64,
    pub folders: u64,
    /// Folders that couldn't be read (access denied).
    pub skipped: u64,
    pub largest_folders: Vec<Node>,
    pub largest_files: Vec<Node>,
    pub types: Vec<TypeStat>,
    pub empty: Vec<String>,
}

fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') { Some((s, e)) if !s.is_empty() && e.len() <= 12 => e.to_lowercase(), _ => String::new() }
}

impl Scan {
    fn path_of(&self, mut i: usize) -> PathBuf {
        let mut parts = Vec::new();
        while i != 0 { parts.push(self.dirs[i].name.as_str()); i = self.dirs[i].parent; }
        let mut p = self.root.clone();
        for s in parts.iter().rev() { p.push(s); }
        p
    }

    /// Scans `root`. Links and junctions are counted as nothing and never followed (no loops, no
    /// double counting); unreadable folders are skipped and counted. Sizes are logical file sizes.
    pub fn run(root: &Path, sink: &mut dyn Sink) -> io::Result<Scan> {
        if !fs::metadata(root)?.is_dir() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "pick a folder or drive")); }
        let mut dirs = vec![Dir { name: String::new(), parent: 0, size: 0, subdirs: vec![], files: vec![], other_size: 0, other_count: 0 }];
        let mut s = Summary { root: crate::display(root), ..Default::default() };
        let mut biggest: BinaryHeap<Reverse<(u64, String)>> = BinaryHeap::new();
        let mut types: HashMap<String, (u64, u64)> = HashMap::new();
        let mut empty_ids = Vec::new();
        let mut stack = vec![(0usize, root.to_path_buf())];
        while let Some((id, path)) = stack.pop() {
            if sink.cancelled() { return Err(cancelled()); }
            sink.item(&path);
            let Ok(rd) = fs::read_dir(&path) else { s.skipped += 1; continue };
            let mut files = Vec::new();
            let mut any = false;
            for e in rd.flatten() {
                any = true;
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_symlink() { continue; }
                let name = e.file_name().to_string_lossy().into_owned();
                if ft.is_dir() {
                    let child = dirs.len();
                    dirs.push(Dir { name, parent: id, size: 0, subdirs: vec![], files: vec![], other_size: 0, other_count: 0 });
                    dirs[id].subdirs.push(child);
                    stack.push((child, e.path()));
                    continue;
                }
                let Ok(m) = e.metadata() else { continue };
                let n = m.len();
                s.files += 1;
                sink.bytes(n);
                let t = types.entry(ext_of(&name)).or_default();
                t.0 += n;
                t.1 += 1;
                if biggest.len() < TOP || biggest.peek().is_some_and(|Reverse((b, _))| n > *b) {
                    biggest.push(Reverse((n, crate::display(&e.path()))));
                    if biggest.len() > TOP { biggest.pop(); }
                }
                files.push((name, n));
            }
            if !any && id != 0 && empty_ids.len() < MAX_EMPTY { empty_ids.push(id); }
            files.sort_by_key(|f| Reverse(f.1));
            let d = &mut dirs[id];
            d.size = files.iter().map(|f| f.1).sum();
            if files.len() > FILES_PER_DIR {
                let rest = files.split_off(FILES_PER_DIR);
                d.other_count = rest.len() as u64;
                d.other_size = rest.iter().map(|f| f.1).sum();
            }
            d.files = files;
        }
        // Children always come after their parent, so one backwards pass totals every folder.
        for i in (1..dirs.len()).rev() { let (p, n) = (dirs[i].parent, dirs[i].size); dirs[p].size += n; }
        s.total = dirs[0].size;
        s.folders = dirs.len() as u64 - 1;
        let mut scan = Scan { root: root.to_path_buf(), dirs, summary: Summary::default() };
        let mut order: Vec<usize> = (1..scan.dirs.len()).collect();
        order.sort_by_key(|&i| Reverse(scan.dirs[i].size));
        s.largest_folders = order.iter().take(50).map(|&i| scan.node(i)).collect();
        s.largest_files = biggest.into_sorted_vec().into_iter().map(|Reverse((size, path))| Node {
            name: Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path, size, is_dir: false, count: 0,
        }).collect();
        s.types = types.into_iter().map(|(ext, (size, count))| TypeStat { ext, size, count }).collect();
        s.types.sort_by_key(|t| Reverse(t.size));
        s.empty = empty_ids.iter().map(|&i| crate::display(&scan.path_of(i))).collect();
        scan.summary = s;
        Ok(scan)
    }

    fn node(&self, i: usize) -> Node {
        Node { name: self.dirs[i].name.clone(), path: crate::display(&self.path_of(i)), size: self.dirs[i].size, is_dir: true, count: 0 }
    }

    /// What's inside one scanned folder (biggest first): its folders, its largest files, and one
    /// "smaller files" bucket. None if `dir` isn't inside this scan.
    pub fn view(&self, dir: &Path) -> Option<Vec<Node>> {
        // Windows paths: compare case-insensitively.
        let (d, r) = (crate::display(dir), crate::display(&self.root));
        let rest = d.get(r.len()..).filter(|_| d.get(..r.len()).is_some_and(|h| h.eq_ignore_ascii_case(&r)))?;
        if !(rest.is_empty() || rest.starts_with('\\') || r.ends_with('\\')) { return None; }
        let mut id = 0;
        for name in rest.split('\\').filter(|s| !s.is_empty()) {
            id = *self.dirs[id].subdirs.iter().find(|&&k| self.dirs[k].name.to_lowercase() == name.to_lowercase())?;
        }
        let d = &self.dirs[id];
        let base = self.path_of(id);
        let mut out: Vec<Node> = d.subdirs.iter().map(|&k| self.node(k)).collect();
        out.extend(d.files.iter().map(|(n, s)| Node { name: n.clone(), path: crate::display(&base.join(n)), size: *s, is_dir: false, count: 0 }));
        if d.other_count > 0 {
            out.push(Node { name: format!("{} smaller files", d.other_count), path: String::new(), size: d.other_size, is_dir: false, count: d.other_count });
        }
        out.sort_by_key(|n| Reverse(n.size));
        Some(out)
    }
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
    fn sizes_add_up() {
        let d = std::env::temp_dir().join("DeltaAgent-storage").join(format!("scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/b")).unwrap();
        fs::create_dir_all(d.join("empty")).unwrap();
        fs::write(d.join("a/b/big.iso"), vec![0u8; 5000]).unwrap();
        fs::write(d.join("a/x.txt"), vec![0u8; 100]).unwrap();
        for i in 0..45 { fs::write(d.join(format!("f{i}.log")), b"1").unwrap(); }
        let s = Scan::run(&d, &mut T).unwrap();
        assert_eq!(s.summary.total, 5145);
        assert_eq!(s.summary.files, 47);
        assert_eq!(s.summary.largest_files[0].size, 5000);
        assert_eq!(s.summary.largest_folders[0].name, "a");
        assert_eq!(s.summary.largest_folders[0].size, 5100);
        assert_eq!(s.summary.types[0].ext, "iso");
        assert!(s.summary.empty[0].ends_with("empty"));
        let top = s.view(&d).unwrap();
        assert_eq!(top[0].name, "a");
        let bucket = top.iter().find(|n| n.path.is_empty()).unwrap();
        assert_eq!((bucket.count, bucket.size), (5, 5), "45 logs: 40 shown, 5 bucketed");
        assert_eq!(s.view(&d.join("A").join("b")).unwrap()[0].size, 5000, "case-insensitive");
        assert!(s.view(Path::new(r"Z:\elsewhere")).is_none());
        fs::remove_dir_all(&d).unwrap();
    }
}
