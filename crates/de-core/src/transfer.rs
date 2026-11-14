//! Long-running operations with progress and cancel: copy, move, zip, extract, recursive search.
//! The actual per-file copy is injected (`CopyFile`), so Windows can use CopyFileEx (keeps attributes,
//! fast, cancellable) while tests use std.
use crate::{ops::free_name, Entry};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Receives progress; `cancelled` is polled often and stops the job with ErrorKind::Interrupted.
pub trait Sink {
    /// `n` more bytes are done.
    fn bytes(&mut self, n: u64);
    /// Now working on this file.
    fn item(&mut self, p: &Path);
    fn cancelled(&self) -> bool;
    /// `dst` already exists: what to do, and whether that goes for every remaining conflict too.
    /// None = nobody to ask: a copy keeps both, a move refuses (the behaviour before the dialog existed).
    fn conflict(&mut self, _src: &Path, _dst: &Path) -> io::Result<Option<(Choice, bool)>> { Ok(None) }
    /// Gets `dst` out of the way before it's replaced (the app sends it to the Recycle Bin). The default
    /// refuses, so nothing is ever destroyed silently.
    fn discard(&mut self, dst: &Path) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, format!("{}: can't replace it here", dst.display())))
    }
    /// One top-level item failed; the job carries on with the rest (the UI offers "Retry failed").
    fn failed(&mut self, _src: &Path, _e: &io::Error) {}
}

/// Answer to "this name already exists at the destination".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice { Replace, Skip, KeepBoth }

/// What happens to one item. `Replace(dst)`: dst is discarded first, then written.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan { Write(PathBuf), Replace(PathBuf), Skip }

/// A folder never replaces a file or the other way round: such a Replace keeps both instead.
pub fn effective(choice: Choice, src_is_dir: bool, dst_is_dir: bool) -> Choice {
    if choice == Choice::Replace && src_is_dir != dst_is_dir { Choice::KeepBoth } else { choice }
}

/// Where `src` goes in `dest`, asking the sink on a name clash (or reusing a "do this for all" answer).
/// Copying an item onto itself (paste in the same folder) always keeps both and never asks.
pub fn decide(src: &Path, dest: &Path, moving: bool, all: &mut Option<Choice>, sink: &mut dyn Sink) -> io::Result<Plan> {
    let name = src.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let to = dest.join(name);
    let Ok(dm) = fs::symlink_metadata(&to) else { return Ok(Plan::Write(to)) };
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    let same = norm(&to) == norm(src);
    let choice = if same {
        if moving { Choice::Skip } else { Choice::KeepBoth }
    } else if let Some(c) = *all {
        c
    } else {
        match sink.conflict(src, &to)? {
            Some((c, for_all)) => { if for_all { *all = Some(c); } c }
            None if moving => return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", to.display()))),
            None => Choice::KeepBoth,
        }
    };
    let src_dir = fs::symlink_metadata(src).map_err(at(src))?.is_dir();
    Ok(match effective(choice, src_dir, dm.is_dir()) {
        Choice::Skip => Plan::Skip,
        Choice::KeepBoth => Plan::Write(free_name(dest, &name.to_string_lossy())),
        Choice::Replace => Plan::Replace(to),
    })
}

/// Runs `one` for every item: a cancel stops at once, other errors are reported to the sink and the rest
/// carry on. Returns the first error (with a count when several failed).
fn each(items: &[PathBuf], sink: &mut dyn Sink, verb: &str, mut one: impl FnMut(&PathBuf, &mut dyn Sink) -> io::Result<()>) -> io::Result<()> {
    let mut first: Option<io::Error> = None;
    let mut n = 0;
    for src in items {
        if sink.cancelled() { return Err(cancelled()); }
        match one(src, sink) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(e),
            Err(e) => { sink.failed(src, &e); n += 1; first.get_or_insert(e); }
            Ok(()) => {}
        }
    }
    match first {
        None => Ok(()),
        Some(e) if n == 1 => Err(e),
        Some(e) => Err(io::Error::new(e.kind(), format!("{n} items couldn't be {verb}; first: {e}"))),
    }
}

/// Copies one file, calling `progress(bytes_done_in_this_file)`; returns false from it to cancel.
pub type CopyFile<'a> = &'a dyn Fn(&Path, &Path, &mut dyn FnMut(u64) -> bool) -> io::Result<()>;

pub fn std_copy(from: &Path, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
    let n = fs::copy(from, to)?;
    if progress(n) { Ok(()) } else { Err(cancelled()) }
}

pub fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled")
}

fn at(p: &Path) -> impl FnOnce(io::Error) -> io::Error + '_ {
    move |e| if e.kind() == io::ErrorKind::Interrupted { e } else { io::Error::new(e.kind(), format!("{}: {e}", p.display())) }
}

/// Total bytes and file count under these items (for the progress bar).
pub fn measure(items: &[PathBuf]) -> (u64, u64) {
    fn walk(p: &Path, acc: &mut (u64, u64)) {
        match fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => {
                for e in fs::read_dir(p).into_iter().flatten().flatten() { walk(&e.path(), acc); }
            }
            Ok(m) => { acc.0 += m.len(); acc.1 += 1; }
            Err(_) => {}
        }
    }
    let mut acc = (0, 0);
    for i in items { walk(i, &mut acc); }
    acc
}

/// Copies a file or a whole folder to exactly 	o (which must not exist).
pub fn copy_tree(from: &Path, to: &Path, sink: &mut dyn Sink, copy: CopyFile) -> io::Result<()> {
    if sink.cancelled() { return Err(cancelled()); }
    if fs::symlink_metadata(from).map_err(at(from))?.is_dir() {
        fs::create_dir(to).map_err(at(to))?;
        for e in fs::read_dir(from).map_err(at(from))? {
            let e = e.map_err(at(from))?;
            copy_tree(&e.path(), &to.join(e.file_name()), sink, copy)?;
        }
        Ok(())
    } else {
        sink.item(from);
        let mut last = 0;
        copy(from, to, &mut |done| { sink.bytes(done.saturating_sub(last)); last = done; !sink.cancelled() }).map_err(at(from))
    }
}

fn check_dest(items: &[PathBuf], dest: &Path, verb: &str) -> io::Result<()> {
    if !dest.is_dir() {
        return Err(at(dest)(io::Error::new(io::ErrorKind::NotFound, "destination folder not found")));
    }
    // Windows paths are case-insensitive: "C:\Foo" into "c:\foo\bar" is still into itself.
    let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    if items.iter().any(|s| lower(dest).starts_with(lower(s))) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("can't {verb} a folder into itself")));
    }
    Ok(())
}

/// Copies into `dest`. Name clashes go through `decide` (keep both = " (n)" like Explorer's paste).
/// `out` collects what was created, including a partial item when cancelled, so undo can remove it.
/// An item that fails has its incomplete copy removed, and the rest still get copied.
pub fn copy_items(items: &[PathBuf], dest: &Path, sink: &mut dyn Sink, copy: CopyFile, out: &mut Vec<PathBuf>) -> io::Result<()> {
    check_dest(items, dest, "copy")?;
    let mut all = None;
    each(items, sink, "copied", |src, sink| {
        let to = match decide(src, dest, false, &mut all, sink)? {
            Plan::Skip => return Ok(()),
            Plan::Write(t) => t,
            Plan::Replace(t) => { sink.discard(&t)?; t }
        };
        let fresh = fs::symlink_metadata(&to).is_err();
        out.push(to.clone());
        copy_tree(src, &to, sink, copy).inspect_err(|e| {
            // Something that appeared under this name meanwhile (AlreadyExists) isn't ours: leave it.
            if e.kind() != io::ErrorKind::Interrupted && e.kind() != io::ErrorKind::AlreadyExists && fresh {
                let _ = if to.is_dir() { fs::remove_dir_all(&to) } else { fs::remove_file(&to) };
                out.pop();
            }
        })
    })
}

/// Moves into `dest`. Name clashes go through `decide`; with nobody to ask it refuses to overwrite.
/// Same drive: instant rename. Other drive: copy, then delete the source only after its copy fully
/// succeeded. `out` gets the (source, destination) pairs that moved, also when a later item fails,
/// so undo can put back what did move.
pub fn move_items(items: &[PathBuf], dest: &Path, sink: &mut dyn Sink, copy: CopyFile, out: &mut Vec<(PathBuf, PathBuf)>) -> io::Result<()> {
    check_dest(items, dest, "move")?;
    let mut all = None;
    each(items, sink, "moved", |src, sink| {
        let to = match decide(src, dest, true, &mut all, sink)? {
            Plan::Skip => return Ok(()), // includes "already there"
            Plan::Write(t) => t,
            Plan::Replace(t) => { sink.discard(&t)?; t }
        };
        let meta = fs::symlink_metadata(src).map_err(at(src))?;
        match fs::rename(src, &to) {
            Ok(()) => sink.bytes(measure(std::slice::from_ref(&to)).0),
            // Only another drive needs copy + delete. Anything else (file in use, access denied) is a real
            // error: copying anyway would leave a duplicate and then fail to delete the source.
            Err(e) if e.raw_os_error() != Some(17) => return Err(at(src)(e)), // 17 = ERROR_NOT_SAME_DEVICE
            Err(_) => {
            if let Err(e) = copy_tree(src, &to, sink, copy) {
                // Leave the source untouched; remove the incomplete copy.
                let _ = if meta.is_dir() { fs::remove_dir_all(&to) } else { fs::remove_file(&to) };
                return Err(e);
            }
            if meta.is_dir() { fs::remove_dir_all(src).map_err(at(src))? } else { fs::remove_file(src).map_err(at(src))? }
            }
        }
        out.push((src.clone(), to));
        Ok(())
    })
}

/// Zips items into `zip_path` (folders keep their structure). Written under a hidden temp name and renamed
/// when complete, so a half-written zip never shows; returns the final path.
pub fn zip_items(items: &[PathBuf], zip_path: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    crate::archive::write_then_rename(zip_path, |file| {
        let mut z = zip::ZipWriter::new(io::BufWriter::new(file));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
        fn add(z: &mut zip::ZipWriter<io::BufWriter<fs::File>>, p: &Path, name: String, opts: zip::write::SimpleFileOptions, sink: &mut dyn Sink) -> io::Result<()> {
            if sink.cancelled() { return Err(cancelled()); }
            let meta = fs::symlink_metadata(p).map_err(at(p))?;
            // Without this every entry shows as 1980 in Explorer.
            let opts = opts.last_modified_time(crate::archive::zip_time(meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
            if meta.is_dir() {
                z.add_directory(format!("{name}/"), opts).map_err(io::Error::other)?;
                for e in fs::read_dir(p).map_err(at(p))? {
                    let e = e?;
                    add(z, &e.path(), format!("{name}/{}", e.file_name().to_string_lossy()), opts, sink)?;
                }
            } else {
                sink.item(p);
                z.start_file(name, opts).map_err(io::Error::other)?;
                let mut f = fs::File::open(p).map_err(at(p))?;
                let mut buf = vec![0u8; 1 << 20];
                loop {
                    let n = io::Read::read(&mut f, &mut buf)?;
                    if n == 0 { break; }
                    io::Write::write_all(z, &buf[..n])?;
                    sink.bytes(n as u64);
                    if sink.cancelled() { return Err(cancelled()); }
                }
            }
            Ok(())
        }
        for i in items {
            let name = i.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            add(&mut z, i, name, opts, sink)?;
        }
        io::Write::flush(&mut z.finish().map_err(io::Error::other)?)
    })
}

/// Uncompressed size of a zip (for progress).
pub fn zip_size(zip_path: &Path) -> io::Result<(u64, u64)> {
    let mut z = zip::ZipArchive::new(fs::File::open(zip_path).map_err(at(zip_path))?).map_err(io::Error::other)?;
    let mut total = 0;
    for i in 0..z.len() { total += z.by_index_raw(i).map_err(io::Error::other)?.size(); }
    Ok((total, z.len() as u64))
}

/// Extracts into a new folder next to the zip ("name", or "name (2)"...). Entries that would escape the
/// folder ("../") are refused. Removes the new folder on error/cancel.
pub fn extract(zip_path: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    let parent = zip_path.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let stem = zip_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Extracted".into());
    let out = free_name(parent, &stem);
    let mut z = zip::ZipArchive::new(fs::File::open(zip_path).map_err(at(zip_path))?).map_err(io::Error::other)?;
    fs::create_dir(&out).map_err(at(&out))?; // only a folder we created is removed on failure
    let r = (|| {
        let strip = single_root(&mut z);
        for i in 0..z.len() {
            if sink.cancelled() { return Err(cancelled()); }
            let mut e = z.by_index(i).map_err(io::Error::other)?;
            let Some(rel) = e.enclosed_name() else {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unsafe path in zip: {}", e.name().unwrap_or_default())));
            };
            let rel = match &strip { Some(r) => rel.strip_prefix(r).map(Path::to_path_buf).unwrap_or(rel), None => rel };
            if rel.as_os_str().is_empty() { continue; }
            let target = out.join(rel);
            if e.is_dir() {
                fs::create_dir_all(&target).map_err(at(&target))?;
                continue;
            }
            if let Some(p) = target.parent() { fs::create_dir_all(p).map_err(at(p))?; }
            sink.item(&target);
            let mut f = fs::File::create(&target).map_err(at(&target))?;
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = io::Read::read(&mut e, &mut buf)?;
                if n == 0 { break; }
                io::Write::write_all(&mut f, &buf[..n])?;
                sink.bytes(n as u64);
                if sink.cancelled() { return Err(cancelled()); }
            }
        }
        Ok(out.clone())
    })();
    if r.is_err() { let _ = fs::remove_dir_all(&out); }
    r
}

/// The one top-level folder every entry is inside, if there is exactly one.
fn single_root<R: io::Read + io::Seek>(z: &mut zip::ZipArchive<R>) -> Option<PathBuf> {
    let mut root: Option<PathBuf> = None;
    for i in 0..z.len() {
        let e = z.by_index_raw(i).ok()?;
        let p = e.enclosed_name()?;
        let mut c = p.components();
        let first = PathBuf::from(c.next()?.as_os_str());
        if c.next().is_none() && !e.is_dir() { return None; } // a file at the top level
        match &root {
            None => root = Some(first),
            Some(r) if *r == first => {}
            Some(_) => return None,
        }
    }
    root
}

/// Recursive name search under `root`. Results use absolute paths as names (they come from many folders).
/// Stops early when `cancelled()` (a newer search started) or after `limit` hits.
pub fn search(root: &Path, query: &str, show_hidden: bool, limit: usize, cancelled: &dyn Fn() -> bool) -> Vec<Entry> {
    let q = query.to_lowercase();
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancelled() || out.len() >= limit { break; }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            let attrs = std::os::windows::fs::MetadataExt::file_attributes(&m);
            let hidden = attrs & 0x6 != 0;
            if hidden && !show_hidden { continue; }
            let is_link = m.file_type().is_symlink();
            let name = e.file_name().to_string_lossy().into_owned();
            if m.is_dir() && !is_link { stack.push(e.path()); } // don't follow junctions: avoids loops
            if name.to_lowercase().contains(&q) {
                let mut en = Entry::from_meta(e.path().to_string_lossy().into_owned(), &m, attrs);
                en.is_dir = m.is_dir() || is_link && e.path().is_dir();
                out.push(en);
                if out.len() >= limit { break; }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct T { bytes: u64, items: u64, stop_after: Option<u64>, stopped: Cell<bool> }
    impl Sink for T {
        fn bytes(&mut self, n: u64) { self.bytes += n; }
        fn item(&mut self, _: &Path) { self.items += 1; }
        fn cancelled(&self) -> bool {
            let c = self.stop_after.is_some_and(|s| self.items >= s);
            if c { self.stopped.set(true); }
            c
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("de-xfer-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src/sub")).unwrap();
        fs::write(d.join("src/a.txt"), b"hello").unwrap();
        fs::write(d.join("src/sub/b.txt"), b"world!").unwrap();
        fs::create_dir_all(d.join("out")).unwrap();
        d
    }

    #[test]
    fn copy_counts_progress_and_cancels() {
        let d = tmp("copy");
        assert_eq!(measure(&[d.join("src")]), (11, 2));
        let mut t = T::default();
        let mut made = Vec::new();
        copy_items(&[d.join("src")], &d.join("out"), &mut t, &std_copy, &mut made).unwrap();
        assert_eq!((t.bytes, t.items), (11, 2));
        assert_eq!(fs::read(made[0].join("sub/b.txt")).unwrap(), b"world!");
        let mut t = T { stop_after: Some(1), ..T::default() };
        let mut partial = Vec::new();
        let e = copy_items(&[d.join("src")], &d.join("out"), &mut t, &std_copy, &mut partial).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert_eq!(partial, vec![d.join("out/src (2)")], "partial copy is reported for undo");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn move_refuses_clash_and_moves() {
        let d = tmp("move");
        fs::write(d.join("out/a.txt"), b"x").unwrap();
        assert!(move_items(&[d.join("src/a.txt")], &d.join("out"), &mut T::default(), &std_copy, &mut vec![]).is_err());
        assert!(d.join("src/a.txt").exists());
        let mut moved = vec![];
        move_items(&[d.join("src/sub")], &d.join("out"), &mut T::default(), &std_copy, &mut moved).unwrap();
        assert_eq!(moved[0], (d.join("src/sub"), d.join("out/sub")));
        assert!(!d.join("src/sub").exists() && d.join("out/sub/b.txt").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    /// Answers conflicts from a script; discard deletes (the app recycles instead).
    struct Ask { answers: Vec<(Choice, bool)>, asked: usize, failed: Vec<PathBuf> }
    impl Sink for Ask {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { false }
        fn conflict(&mut self, _: &Path, _: &Path) -> io::Result<Option<(Choice, bool)>> { self.asked += 1; Ok(Some(self.answers.remove(0))) }
        fn discard(&mut self, p: &Path) -> io::Result<()> { if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) } }
        fn failed(&mut self, p: &Path, _: &io::Error) { self.failed.push(p.to_path_buf()); }
    }
    fn ask(a: &[(Choice, bool)]) -> Ask { Ask { answers: a.to_vec(), asked: 0, failed: vec![] } }

    #[test]
    fn conflict_decisions() {
        assert_eq!(effective(Choice::Replace, true, false), Choice::KeepBoth, "a folder never replaces a file");
        assert_eq!(effective(Choice::Replace, false, true), Choice::KeepBoth);
        assert_eq!(effective(Choice::Replace, true, true), Choice::Replace);
        assert_eq!(effective(Choice::Skip, true, false), Choice::Skip);

        let d = tmp("conflict");
        for n in ["a.txt", "sub", "c.txt"] { let _ = fs::copy(d.join("src/a.txt"), d.join("out").join(n)); }
        fs::write(d.join("src/c.txt"), b"new").unwrap();
        // replace a.txt and remember it for all: c.txt is replaced without asking; "sub" (folder onto a file) is kept both
        let mut s = ask(&[(Choice::Replace, true)]);
        let mut made = vec![];
        copy_items(&[d.join("src/a.txt"), d.join("src/sub"), d.join("src/c.txt")], &d.join("out"), &mut s, &std_copy, &mut made).unwrap();
        assert_eq!(s.asked, 1);
        assert_eq!(fs::read(d.join("out/c.txt")).unwrap(), b"new");
        assert!(d.join("out/sub").is_file() && d.join("out/sub (2)/b.txt").exists());
        // skip once, then keep both
        let mut s = ask(&[(Choice::Skip, false), (Choice::KeepBoth, false)]);
        copy_items(&[d.join("src/a.txt"), d.join("src/c.txt")], &d.join("out"), &mut s, &std_copy, &mut vec![]).unwrap();
        assert!(!d.join("out/a (2).txt").exists() && d.join("out/c (2).txt").exists());
        // pasting into the same folder never asks
        let mut s = ask(&[]);
        copy_items(&[d.join("out/c.txt")], &d.join("out"), &mut s, &std_copy, &mut vec![]).unwrap();
        assert!(s.asked == 0 && d.join("out/c (3).txt").exists());
        // move with replace; a missing item fails but the others still move
        let mut s = ask(&[(Choice::Replace, false)]);
        let mut moved = vec![];
        let e = move_items(&[d.join("src/gone.txt"), d.join("src/c.txt")], &d.join("out"), &mut s, &std_copy, &mut moved).unwrap_err();
        assert!(e.to_string().contains("gone.txt"));
        assert_eq!(s.failed, [d.join("src/gone.txt")]);
        assert_eq!(moved, [(d.join("src/c.txt"), d.join("out/c.txt"))]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn zip_roundtrip_and_search() {
        let d = tmp("zip");
        let z = zip_items(&[d.join("src")], &d.join("out/src.zip"), &mut T::default()).unwrap();
        assert_eq!(zip_size(&z).unwrap().0, 11);
        let x = extract(&z, &mut T::default()).unwrap();
        assert_eq!(x, d.join("out/src"));
        assert_eq!(fs::read(x.join("sub/b.txt")).unwrap(), b"world!", "single top folder is not doubled");
        let hits = search(&d.join("src"), "B.TXT", false, 100, &|| false);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].name.ends_with("b.txt"));
        fs::remove_dir_all(&d).unwrap();
    }
}
