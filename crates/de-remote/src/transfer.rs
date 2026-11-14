//! Copy / move between local folders and remote locations (and between two remotes), for the job system.
//! Same rules as de_core::transfer: clashes on copy get " (n)", moves never overwrite, a move removes
//! the source only after its copy fully succeeded.
use crate::{delete_tree, free_name, invalid, join, local_name, name, parent, parse, RemoteProvider};
use de_core::transfer::{cancelled, Sink};
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Debug, Clone, PartialEq)]
pub enum Loc {
    Local(PathBuf),
    Remote { id: String, path: String },
}

impl Loc {
    pub fn parse(s: &str) -> Loc {
        match parse(s) {
            Some((id, path)) => Loc::Remote { id: id.into(), path },
            None => Loc::Local(PathBuf::from(s)),
        }
    }
    fn name(&self) -> String {
        match self {
            Loc::Local(p) => p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            Loc::Remote { path, .. } => name(path).to_string(),
        }
    }
    fn child(&self, n: &str) -> Loc {
        match self {
            Loc::Local(p) => Loc::Local(p.join(local_name(n))),
            Loc::Remote { id, path } => Loc::Remote { id: id.clone(), path: join(path, n) },
        }
    }
    fn show(&self) -> String {
        match self { Loc::Local(p) => de_core::display(p), Loc::Remote { path, .. } => path.clone() }
    }
}

/// Sessions a job uses, opened on first need (a job may touch two servers).
pub struct Sessions<'a> {
    open: &'a dyn Fn(&str) -> io::Result<Box<dyn RemoteProvider>>,
    map: HashMap<String, Box<dyn RemoteProvider>>,
}
impl<'a> Sessions<'a> {
    pub fn new(open: &'a dyn Fn(&str) -> io::Result<Box<dyn RemoteProvider>>) -> Self { Self { open, map: HashMap::new() } }
    fn get(&mut self, id: &str) -> io::Result<&mut dyn RemoteProvider> {
        if !self.map.contains_key(id) { let p = (self.open)(id)?; self.map.insert(id.to_string(), p); }
        Ok(self.map.get_mut(id).unwrap().as_mut())
    }
}

fn at(l: &Loc) -> impl FnOnce(io::Error) -> io::Error + '_ {
    move |e| if e.kind() == io::ErrorKind::Interrupted { e } else { io::Error::new(e.kind(), format!("{}: {e}", l.show())) }
}

fn is_dir(l: &Loc, s: &mut Sessions) -> io::Result<Option<bool>> {
    match l {
        Loc::Local(p) => Ok(fs::symlink_metadata(p).ok().map(|m| m.is_dir())),
        Loc::Remote { id, path } => Ok(s.get(id)?.stat(path)?.map(|e| e.is_dir)),
    }
}
fn children(l: &Loc, s: &mut Sessions) -> io::Result<Vec<(String, bool, u64)>> {
    match l {
        Loc::Local(p) => fs::read_dir(p)?.map(|e| {
            let e = e?;
            let m = fs::symlink_metadata(e.path())?;
            Ok((e.file_name().to_string_lossy().into_owned(), m.is_dir(), m.len()))
        }).collect(),
        Loc::Remote { id, path } => Ok(s.get(id)?.list(path)?.into_iter().map(|e| (e.name, e.is_dir, e.size)).collect()),
    }
}

/// Total bytes under these items (for the progress bar).
pub fn measure(items: &[Loc], s: &mut Sessions) -> io::Result<u64> {
    fn walk(l: &Loc, dir: bool, s: &mut Sessions) -> io::Result<u64> {
        if !dir { return Ok(0); }
        let mut n = 0;
        for (c, d, size) in children(l, s)? { n += if d { walk(&l.child(&c), true, s)? } else { size }; }
        Ok(n)
    }
    let mut total = 0;
    for l in items {
        match l {
            Loc::Local(p) => total += de_core::transfer::measure(std::slice::from_ref(p)).0,
            Loc::Remote { id, path } => {
                let e = s.get(id)?.stat(path)?;
                total += match e { Some(e) if e.is_dir => walk(l, true, s)?, Some(e) => e.size, None => 0 };
            }
        }
    }
    Ok(total)
}

static TMP: AtomicU64 = AtomicU64::new(0);

fn copy_file(src: &Loc, to: &Loc, s: &mut Sessions, sink: &mut dyn Sink) -> io::Result<()> {
    sink.item(Path::new(&src.name()));
    let mut last = 0;
    let mut prog = |done: u64| { sink.bytes(done.saturating_sub(last)); last = done; !sink.cancelled() };
    match (src, to) {
        (Loc::Local(f), Loc::Remote { id, path }) => s.get(id)?.upload(f, path, &mut prog),
        (Loc::Remote { id, path }, Loc::Local(t)) => s.get(id)?.download(path, t, &mut prog),
        (Loc::Remote { id: a, path: p }, Loc::Remote { id: b, path: q }) => {
            // Through a temp file: the two ends may be one session, which can't read and write at once.
            let tmp = std::env::temp_dir().join(format!("delta-remote-{}-{}", std::process::id(), TMP.fetch_add(1, Ordering::Relaxed)));
            let r = s.get(a)?.download(p, &tmp, &mut prog).and_then(|_| s.get(b)?.upload(&tmp, q, &mut |_| true));
            let _ = fs::remove_file(&tmp);
            r
        }
        (Loc::Local(f), Loc::Local(t)) => { let n = fs::copy(f, t)?; if prog(n) { Ok(()) } else { Err(cancelled()) } }
    }
}

fn copy_tree(src: &Loc, dir: bool, to: &Loc, s: &mut Sessions, sink: &mut dyn Sink) -> io::Result<()> {
    if sink.cancelled() { return Err(cancelled()); }
    if !dir { return copy_file(src, to, s, sink).map_err(at(src)); }
    match to {
        Loc::Local(p) => fs::create_dir(p).map_err(at(to))?,
        Loc::Remote { id, path } => s.get(id)?.mkdir(path).map_err(at(to))?,
    }
    for (c, d, _) in children(src, s).map_err(at(src))? {
        copy_tree(&src.child(&c), d, &to.child(&c), s, sink)?;
    }
    Ok(())
}

fn remove(l: &Loc, dir: bool, s: &mut Sessions) -> io::Result<()> {
    match l {
        Loc::Local(p) => if dir { fs::remove_dir_all(p) } else { fs::remove_file(p) },
        Loc::Remote { id, path } => delete_tree(s.get(id)?, path, dir),
    }
}

/// Copies (or moves, `mv`) `items` into the folder `dest`. `created` gets the local items made,
/// partial ones included, so undo can recycle them (remote ones can't be recycled, so aren't listed).
pub fn copy(items: &[Loc], dest: &Loc, mv: bool, s: &mut Sessions, sink: &mut dyn Sink, created: &mut Vec<PathBuf>) -> io::Result<()> {
    if is_dir(dest, s)? != Some(true) {
        return Err(at(dest)(io::Error::new(io::ErrorKind::NotFound, "destination folder not found")));
    }
    for src in items {
        if sink.cancelled() { return Err(cancelled()); }
        let n = src.name();
        if n.is_empty() { return Err(invalid("can't copy a whole server; open it and select what to copy")); }
        if let (Loc::Remote { id: a, path: p }, Loc::Remote { id: b, path: d }) = (src, dest) {
            if a == b && (d == p || d.starts_with(&format!("{p}/"))) {
                return Err(invalid(&format!("can't {} a folder into itself", if mv { "move" } else { "copy" })));
            }
            if a == b && mv {
                if parent(p) == *d { continue; } // already there
                let to = join(d, &n);
                let sess = s.get(a)?;
                if sess.stat(&to)?.is_some() { return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{to} already exists"))); }
                sess.rename(p, &to).map_err(at(src))?; // same server: instant
                continue;
            }
        }
        let dir = is_dir(src, s)?.ok_or_else(|| at(src)(io::Error::new(io::ErrorKind::NotFound, "not found")))?;
        let to = match dest {
            Loc::Local(d) if mv => { let t = d.join(local_name(&n)); if t.exists() { return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", t.display()))); } Loc::Local(t) }
            Loc::Local(d) => Loc::Local(de_core::ops::free_name(d, &local_name(&n))),
            Loc::Remote { id, path } => {
                let sess = s.get(id)?;
                let t = if mv { join(path, &n) } else { free_name(sess, path, &n)? };
                if mv && sess.stat(&t)?.is_some() { return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{t} already exists"))); }
                Loc::Remote { id: id.clone(), path: t }
            }
        };
        if let Loc::Local(t) = &to { created.push(t.clone()); }
        if let Err(e) = copy_tree(src, dir, &to, s, sink) {
            // Remote leftovers can't go to the Recycle Bin for undo: remove the incomplete copy now.
            // (A partial local copy stays listed in `created` for "Remove partial copy".)
            if matches!(to, Loc::Remote { .. }) { let _ = remove(&to, dir, s); }
            if mv { if let Loc::Local(t) = &to { let _ = remove(&Loc::Local(t.clone()), dir, s); created.pop(); } }
            return Err(e);
        }
        if mv { remove(src, dir, s).map_err(at(src))?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::Fake;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Count { bytes: u64, stop_after: Option<u64> }
    impl Sink for Count {
        fn bytes(&mut self, n: u64) { self.bytes += n; }
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { self.stop_after.is_some_and(|n| self.bytes >= n) }
    }

    /// Shares one fake server between the job's sessions and the test's checks.
    #[derive(Clone)]
    struct Shared(Arc<Mutex<Fake>>);
    impl RemoteProvider for Shared {
        fn list(&mut self, d: &str) -> io::Result<Vec<crate::Entry>> { self.0.lock().unwrap().list(d) }
        fn download(&mut self, p: &str, t: &Path, g: &mut dyn FnMut(u64) -> bool) -> io::Result<()> { self.0.lock().unwrap().download(p, t, g) }
        fn upload(&mut self, f: &Path, p: &str, g: &mut dyn FnMut(u64) -> bool) -> io::Result<()> { self.0.lock().unwrap().upload(f, p, g) }
        fn mkdir(&mut self, p: &str) -> io::Result<()> { self.0.lock().unwrap().mkdir(p) }
        fn rename(&mut self, a: &str, b: &str) -> io::Result<()> { self.0.lock().unwrap().rename(a, b) }
        fn delete(&mut self, p: &str, d: bool) -> io::Result<()> { self.0.lock().unwrap().delete(p, d) }
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("DeltaAgent-remote-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn r(path: &str) -> Loc { Loc::Remote { id: "s".into(), path: path.into() } }

    #[test]
    fn upload_download_and_clashes() {
        let server = Shared(Arc::new(Mutex::new(Fake::default())));
        server.0.lock().unwrap().dir("/up");
        let open = { let s = server.clone(); move |_: &str| Ok(Box::new(s.clone()) as Box<dyn RemoteProvider>) };
        let mut sess = Sessions::new(&open);
        let local = tmp("updown");
        fs::create_dir_all(local.join("tree/inner")).unwrap();
        fs::write(local.join("tree/a.txt"), b"hello").unwrap();
        fs::write(local.join("tree/inner/b.bin"), b"12345678").unwrap();

        // Local -> remote, twice: the second lands as "tree (2)".
        let mut sink = Count::default();
        let mut made = vec![];
        let items = [Loc::Local(local.join("tree"))];
        assert_eq!(measure(&items, &mut sess).unwrap(), 13);
        copy(&items, &r("/up"), false, &mut sess, &mut sink, &mut made).unwrap();
        copy(&items, &r("/up"), false, &mut sess, &mut sink, &mut made).unwrap();
        assert_eq!(sink.bytes, 26);
        assert!(made.is_empty(), "remote items aren't undoable via the Recycle Bin");
        {
            let f = server.0.lock().unwrap();
            assert_eq!(f.items["/up/tree/inner/b.bin"].as_deref(), Some(&b"12345678"[..]));
            assert!(f.items.contains_key("/up/tree (2)/a.txt"));
        }
        assert_eq!(measure(&[r("/up/tree")], &mut sess).unwrap(), 13);

        // Remote -> local, names made Windows-safe.
        server.0.lock().unwrap().file("/up/what?.txt", b"q");
        let back = local.join("back");
        fs::create_dir(&back).unwrap();
        copy(&[r("/up/tree"), r("/up/what?.txt")], &Loc::Local(back.clone()), false, &mut sess, &mut Count::default(), &mut made).unwrap();
        assert_eq!(fs::read(back.join("tree/inner/b.bin")).unwrap(), b"12345678");
        assert_eq!(fs::read(back.join("what_.txt")).unwrap(), b"q");
        assert_eq!(made, vec![back.join("tree"), back.join("what_.txt")]);

        // Remote -> same remote copy goes through a temp file; into itself is refused.
        copy(&[r("/up/what?.txt")], &r("/up/tree"), false, &mut sess, &mut Count::default(), &mut made).unwrap();
        assert!(server.0.lock().unwrap().items.contains_key("/up/tree/what?.txt"));
        assert!(copy(&[r("/up/tree")], &r("/up/tree/inner"), false, &mut sess, &mut Count::default(), &mut made).is_err());
        assert!(copy(&[r("/up/tree")], &r("/missing"), false, &mut sess, &mut Count::default(), &mut made).is_err());
        let _ = fs::remove_dir_all(&local);
    }

    #[test]
    fn moves_and_cancel() {
        let server = Shared(Arc::new(Mutex::new(Fake::default())));
        {
            let mut f = server.0.lock().unwrap();
            f.file("/a/x.txt", b"xx");
            f.dir("/b");
        }
        let open = { let s = server.clone(); move |_: &str| Ok(Box::new(s.clone()) as Box<dyn RemoteProvider>) };
        let mut sess = Sessions::new(&open);
        let mut made = vec![];
        // Same server: a rename.
        copy(&[r("/a")], &r("/b"), true, &mut sess, &mut Count::default(), &mut made).unwrap();
        assert!(server.0.lock().unwrap().items.contains_key("/b/a/x.txt"));
        assert!(!server.0.lock().unwrap().items.contains_key("/a"));
        // Moving onto an existing name is refused, nothing lost.
        server.0.lock().unwrap().file("/c/a", b"other");
        assert_eq!(copy(&[r("/b/a")], &r("/c"), true, &mut sess, &mut Count::default(), &mut made).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert!(server.0.lock().unwrap().items.contains_key("/b/a/x.txt"));

        // Local -> remote move deletes the local file only after the upload.
        let local = tmp("move");
        fs::write(local.join("m.txt"), b"move me").unwrap();
        copy(&[Loc::Local(local.join("m.txt"))], &r("/b"), true, &mut sess, &mut Count::default(), &mut made).unwrap();
        assert!(!local.join("m.txt").exists());
        assert_eq!(server.0.lock().unwrap().items["/b/m.txt"].as_deref(), Some(&b"move me"[..]));

        // Cancelled mid-way: the partial remote copy is removed, the source stays.
        fs::create_dir(local.join("big")).unwrap();
        for i in 0..5 { fs::write(local.join(format!("big/{i}")), b"0123456789").unwrap(); }
        let mut sink = Count { stop_after: Some(15), ..Default::default() };
        let e = copy(&[Loc::Local(local.join("big"))], &r("/b"), true, &mut sess, &mut sink, &mut made).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!server.0.lock().unwrap().items.keys().any(|k| k.starts_with("/b/big")));
        assert_eq!(fs::read_dir(local.join("big")).unwrap().count(), 5);
        let _ = fs::remove_dir_all(&local);
    }
}
