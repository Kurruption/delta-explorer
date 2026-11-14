//! Folder compare and sync: what differs between two trees, what a sync would do (always previewed
//! by the UI first), and running that plan. Nothing is ever overwritten in place: a replaced file
//! goes to the Recycle Bin (injected `recycle`) and deletions in mirror mode do too.
use crate::transfer::{self, CopyFile, Sink};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    OnlyLeft,
    OnlyRight,
    NewerLeft,
    NewerRight,
    /// Same date, different size, or contents checked and found different.
    Differs,
    Identical,
    /// A file on one side, a folder on the other.
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub size: u64,
    pub modified: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Path relative to both roots, backslash-separated.
    pub rel: String,
    pub kind: Kind,
    pub left: Option<Side>,
    pub right: Option<Side>,
}

/// FAT/exFAT store times in 2-second steps; closer than this counts as the same time.
const SLACK: u64 = 2;
/// A compare bigger than this is refused rather than freezing the dialog.
pub const MAX_ITEMS: usize = 300_000;

pub fn classify(l: &Side, r: &Side) -> Kind {
    if l.is_dir != r.is_dir {
        Kind::Conflict
    } else if l.is_dir || l.modified.abs_diff(r.modified) <= SLACK {
        if l.is_dir || l.size == r.size { Kind::Identical } else { Kind::Differs }
    } else if l.modified > r.modified {
        Kind::NewerLeft
    } else {
        Kind::NewerRight
    }
}

fn side(m: &fs::Metadata) -> Side {
    let modified = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    Side { size: if m.is_dir() { 0 } else { m.len() }, modified, is_dir: m.is_dir() }
}

/// Children by lowercase name (Windows names are case-insensitive), keeping the real name.
fn children(dir: &Path) -> io::Result<BTreeMap<String, (String, Side)>> {
    let mut out = BTreeMap::new();
    for e in fs::read_dir(dir).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", dir.display())))? {
        let e = e?;
        // symlink_metadata: a junction is compared as itself, never followed (no loops).
        let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        out.insert(name.to_lowercase(), (name, side(&m)));
    }
    Ok(out)
}

/// Every difference (and identical file) between two folder trees, sorted by path.
/// A folder that exists on one side only is one item; its contents aren't listed.
/// Files up to this size that look identical (same size and date) are compared byte by byte.
const VERIFY_MAX: u64 = 1 << 20;

pub fn compare_dirs(left: &Path, right: &Path) -> io::Result<Vec<Item>> {
    let mut out = Vec::new();
    walk(left, right, "", &mut out)?;
    Ok(out)
}

fn walk(l: &Path, r: &Path, prefix: &str, out: &mut Vec<Item>) -> io::Result<()> {
    let (a, b) = (children(l)?, children(r)?);
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        if out.len() > MAX_ITEMS {
            return Err(io::Error::other(format!("more than {MAX_ITEMS} items; compare smaller folders")));
        }
        let (x, y) = (a.get(k), b.get(k));
        let name = &x.or(y).unwrap().0;
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}\\{name}") };
        match (x, y) {
            (Some((_, ls)), Some((_, rs))) if ls.is_dir && rs.is_dir => walk(&l.join(name), &r.join(name), &rel, out)?,
            (Some((_, ls)), Some((_, rs))) => {
                let mut kind = classify(ls, rs);
                // Same size and date usually means same file, but small files are cheap to check for real.
                if kind == Kind::Identical && !ls.is_dir && ls.size <= VERIFY_MAX && fs::read(l.join(name)).ok() != fs::read(r.join(name)).ok() { kind = Kind::Differs; }
                out.push(Item { rel, kind, left: Some(*ls), right: Some(*rs) })
            }
            (Some((_, ls)), None) => out.push(Item { rel, kind: Kind::OnlyLeft, left: Some(*ls), right: None }),
            (None, Some((_, rs))) => out.push(Item { rel, kind: Kind::OnlyRight, left: None, right: Some(*rs) }),
            (None, None) => unreachable!(),
        }
    }
    Ok(())
}

/// Byte-for-byte comparison (exact, and no slower than hashing both files).
pub fn same_contents(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut fa, mut fb) = (io::BufReader::new(fs::File::open(a)?), io::BufReader::new(fs::File::open(b)?));
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = fa.read(&mut ba)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    LeftToRight,
    RightToLeft,
    /// Each side gets what it's missing; the newer file wins.
    Both,
    /// Right becomes an exact copy of left (extra items on the right go to the Recycle Bin).
    Mirror,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    /// Target doesn't exist yet.
    Copy,
    /// Target file is recycled, then the source is copied over.
    Replace,
    /// Target goes to the Recycle Bin.
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub op: Op,
    pub rel: String,
    /// The side that is written to (or deleted from) is the right one.
    pub to_right: bool,
}

/// What a sync in `mode` would do. Never overwrites a newer file in one-way modes; Differs (same date)
/// has no winner in Both mode and is skipped.
pub fn plan(items: &[Item], mode: Mode) -> Vec<Action> {
    use Kind::*;
    let mut out = Vec::new();
    let mut add = |op, rel: &str, to_right| out.push(Action { op, rel: rel.to_string(), to_right });
    for i in items {
        let r = i.rel.as_str();
        match (mode, i.kind) {
            (_, Identical) => {}
            (Mode::LeftToRight | Mode::Both | Mode::Mirror, OnlyLeft) => add(Op::Copy, r, true),
            (Mode::RightToLeft | Mode::Both, OnlyRight) => add(Op::Copy, r, false),
            (Mode::Mirror, OnlyRight) => add(Op::Delete, r, true),
            (Mode::LeftToRight | Mode::Both, NewerLeft) | (Mode::LeftToRight, Differs) | (Mode::Mirror, NewerLeft | NewerRight | Differs) => add(Op::Replace, r, true),
            (Mode::RightToLeft | Mode::Both, NewerRight) | (Mode::RightToLeft, Differs) => add(Op::Replace, r, false),
            (Mode::Mirror, Conflict) => { add(Op::Delete, r, true); add(Op::Copy, r, true); }
            _ => {} // e.g. a newer right file in left→right: left alone, so nothing newer is lost
        }
    }
    out
}

/// Only plain relative paths: no "..", no drive or root, nothing empty.
pub fn safe_rel(rel: &str) -> io::Result<&Path> {
    let p = Path::new(rel);
    if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unsafe path: {rel}")));
    }
    Ok(p)
}

/// Moves items to the Recycle Bin (de-shell in the app, a fake in tests).
pub type Recycle<'a> = &'a dyn Fn(&[PathBuf]) -> io::Result<()>;

/// Bytes the plan will copy (for the progress bar).
pub fn plan_bytes(left: &Path, right: &Path, actions: &[Action]) -> u64 {
    let srcs: Vec<PathBuf> = actions.iter().filter(|a| a.op != Op::Delete).filter_map(|a| Some(if a.to_right { left } else { right }.join(safe_rel(&a.rel).ok()?))).collect();
    transfer::measure(&srcs).0
}

/// Runs a previewed plan. Re-checks each step against the disk, so anything that changed since the
/// preview stops the sync instead of being overwritten.
pub fn run(left: &Path, right: &Path, actions: &[Action], sink: &mut dyn Sink, copy: CopyFile, recycle: Recycle) -> io::Result<()> {
    for a in actions {
        if sink.cancelled() {
            return Err(transfer::cancelled());
        }
        let rel = safe_rel(&a.rel)?;
        let (src, dst) = if a.to_right { (left.join(rel), right.join(rel)) } else { (right.join(rel), left.join(rel)) };
        match a.op {
            Op::Delete => recycle(std::slice::from_ref(&dst))?, // shortcut: one Recycle Bin call per item; batch them if mirrors get big
            Op::Copy => {
                if fs::symlink_metadata(&dst).is_ok() {
                    return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} appeared since the preview", dst.display())));
                }
                transfer::copy_tree(&src, &dst, sink, copy)?;
            }
            Op::Replace => {
                if !fs::metadata(&src)?.is_file() || !fs::metadata(&dst)?.is_file() {
                    return Err(io::Error::other(format!("{} is no longer a file", a.rel)));
                }
                let name = dst.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let tmp = crate::ops::free_name(dst.parent().unwrap_or(right), &format!(".{name}.delta-sync"));
                if let Err(e) = transfer::copy_tree(&src, &tmp, sink, copy) {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
                if let Err(e) = recycle(std::slice::from_ref(&dst)) {
                    let _ = fs::remove_file(&tmp);
                    return Err(io::Error::other(format!("couldn't move {} to the Recycle Bin, nothing was replaced: {e}", dst.display())));
                }
                fs::rename(&tmp, &dst).map_err(|e| io::Error::new(e.kind(), format!("{}: {e} (the new copy is at {}, the old one is in the Recycle Bin)", dst.display(), tmp.display())))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoSink;
    impl Sink for NoSink {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { false }
    }

    fn s(size: u64, modified: u64) -> Side { Side { size, modified, is_dir: false } }
    fn item(rel: &str, kind: Kind) -> Item { Item { rel: rel.into(), kind, left: None, right: None } }

    #[test]
    fn classifies() {
        assert_eq!(classify(&s(1, 100), &s(1, 101)), Kind::Identical);
        assert_eq!(classify(&s(1, 100), &s(2, 100)), Kind::Differs);
        assert_eq!(classify(&s(1, 200), &s(1, 100)), Kind::NewerLeft);
        assert_eq!(classify(&s(5, 100), &s(1, 200)), Kind::NewerRight);
        assert_eq!(classify(&s(1, 1), &Side { size: 0, modified: 1, is_dir: true }), Kind::Conflict);
    }

    #[test]
    fn plans_each_mode() {
        use Kind::*;
        let items = [item("a", OnlyLeft), item("b", OnlyRight), item("c", NewerLeft), item("d", NewerRight), item("e", Differs), item("f", Identical), item("g", Conflict)];
        let ops = |m| plan(&items, m).into_iter().map(|a| (a.op, a.rel, a.to_right)).collect::<Vec<_>>();
        let a = |op, r: &str, t| (op, r.to_string(), t);
        assert_eq!(ops(Mode::LeftToRight), [a(Op::Copy, "a", true), a(Op::Replace, "c", true), a(Op::Replace, "e", true)]);
        assert_eq!(ops(Mode::RightToLeft), [a(Op::Copy, "b", false), a(Op::Replace, "d", false), a(Op::Replace, "e", false)]);
        assert_eq!(ops(Mode::Both), [a(Op::Copy, "a", true), a(Op::Copy, "b", false), a(Op::Replace, "c", true), a(Op::Replace, "d", false)]);
        assert_eq!(ops(Mode::Mirror), [
            a(Op::Copy, "a", true), a(Op::Delete, "b", true), a(Op::Replace, "c", true), a(Op::Replace, "d", true), a(Op::Replace, "e", true),
            a(Op::Delete, "g", true), a(Op::Copy, "g", true),
        ]);
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_rel("a\\b.txt").is_ok());
        for bad in ["", "..\\x", "a\\..\\..\\x", "C:\\x", "\\x"] {
            assert!(safe_rel(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn compares_and_mirrors() {
        let root = std::env::temp_dir().join("DeltaAgent-power").join(format!("cmp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (l, r, bin) = (root.join("L"), root.join("R"), root.join("bin"));
        for d in [l.join("sub"), r.join("sub"), l.join("onlyl"), bin.clone()] { fs::create_dir_all(d).unwrap(); }
        fs::write(l.join("same.txt"), "same").unwrap();
        fs::write(r.join("SAME.txt"), "same").unwrap(); // case-insensitive match
        fs::write(l.join("sub\\x.txt"), "left version").unwrap();
        fs::write(r.join("sub\\x.txt"), "right").unwrap();
        fs::write(l.join("onlyl\\in.txt"), "1").unwrap();
        fs::write(r.join("extra.txt"), "bye").unwrap();
        // Make the left copy of x clearly newer.
        let old = fs::File::options().write(true).open(r.join("sub\\x.txt")).unwrap();
        old.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        drop(old);

        let items = compare_dirs(&l, &r).unwrap();
        let kinds: Vec<_> = items.iter().map(|i| (i.rel.as_str(), i.kind)).collect();
        assert_eq!(kinds, [("extra.txt", Kind::OnlyRight), ("onlyl", Kind::OnlyLeft), ("same.txt", Kind::Identical), ("sub\\x.txt", Kind::NewerLeft)]);
        assert!(same_contents(&l.join("same.txt"), &r.join("SAME.txt")).unwrap());
        assert!(!same_contents(&l.join("sub\\x.txt"), &r.join("sub\\x.txt")).unwrap());

        let actions = plan(&items, Mode::Mirror);
        assert_eq!(plan_bytes(&l, &r, &actions), 1 + 12);
        let recycle = |ps: &[PathBuf]| -> io::Result<()> {
            for p in ps { fs::rename(p, crate::ops::free_name(&bin, &p.file_name().unwrap().to_string_lossy()))?; }
            Ok(())
        };
        run(&l, &r, &actions, &mut NoSink, &transfer::std_copy, &recycle).unwrap();
        assert!(compare_dirs(&l, &r).unwrap().iter().all(|i| i.kind == Kind::Identical || i.kind == Kind::NewerRight));
        assert_eq!(fs::read_to_string(r.join("sub\\x.txt")).unwrap(), "left version");
        // Both the replaced file and the extra one are recoverable, not gone.
        assert_eq!(fs::read_to_string(bin.join("x.txt")).unwrap(), "right");
        assert_eq!(fs::read_to_string(bin.join("extra.txt")).unwrap(), "bye");
        // A stale plan (target appeared since the preview) stops instead of overwriting.
        assert!(run(&l, &r, &[Action { op: Op::Copy, rel: "same.txt".into(), to_right: true }], &mut NoSink, &transfer::std_copy, &recycle).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
