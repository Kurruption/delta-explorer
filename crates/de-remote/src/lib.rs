//! Remote locations (SFTP, FTP/FTPS, WebDAV) that browse like folders.
//! The UI addresses them as "remote:<connection-id>/<path>". Every protocol implements one blocking
//! [`RemoteProvider`]; callers run it off the UI thread (Tauri's blocking pool or a job thread).
//! Passwords live in Windows Credential Manager, never in Delta's settings.
mod ftp;
mod sftp;
pub mod transfer;
mod webdav;

pub use de_core::Entry;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

pub const PREFIX: &str = "remote:";
/// Connect / per-request limit; a dead server shows an error instead of a frozen spinner.
pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Sftp,
    Ftp,
    Ftps,
    Webdav,
    Webdavs,
}

/// A saved connection as the UI stores it. No secrets: those are in Credential Manager under `id`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Conn {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub host: String,
    /// 0 = the protocol's default.
    pub port: u16,
    pub user: String,
    /// Folder opened when the connection is clicked.
    pub path: String,
    /// SFTP: private key file to log in with ("" = password). The secret is then the key's passphrase.
    pub key_file: String,
    /// SFTP: pinned host key ("SHA256:..."); "" = not trusted yet.
    pub fingerprint: String,
}

impl Conn {
    pub fn port(&self) -> u16 {
        if self.port != 0 { return self.port; }
        match self.protocol { Protocol::Sftp => 22, Protocol::Ftp | Protocol::Ftps => 21, Protocol::Webdav => 80, Protocol::Webdavs => 443 }
    }
    /// Input from the UI: an id we can put in paths, and a bare host name (not a URL).
    pub fn validate(&self) -> io::Result<()> {
        if self.id.is_empty() || !self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(invalid("bad connection id"));
        }
        let h = self.host.trim();
        if h.is_empty() || h.contains(['/', '\\', ' ', '@']) {
            return Err(invalid("Enter just the server name or IP address, like files.example.com"));
        }
        Ok(())
    }
}

pub(crate) fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.to_string())
}

/// One protocol session. Paths are absolute, '/'-separated ("/", "/home/me/a.txt").
/// `progress(bytes_done_in_this_file)` returning false cancels with ErrorKind::Interrupted.
pub trait RemoteProvider: Send {
    /// Items in a folder (no "." / ".."). Names starting with '.' are reported hidden.
    fn list(&mut self, dir: &str) -> io::Result<Vec<Entry>>;
    /// The item at `path`, or None if nothing is there.
    fn stat(&mut self, path: &str) -> io::Result<Option<Entry>> {
        if path == "/" {
            return Ok(Some(Entry { name: "/".into(), is_dir: true, size: 0, modified: 0, hidden: false, ..Default::default() }));
        }
        let name = name(path);
        Ok(self.list(&parent(path))?.into_iter().find(|e| e.name == name))
    }
    fn download(&mut self, path: &str, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()>;
    /// Creates or replaces `path` with the local file `from` (callers pick a free name first).
    fn upload(&mut self, from: &Path, path: &str, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()>;
    fn mkdir(&mut self, path: &str) -> io::Result<()>;
    fn rename(&mut self, from: &str, to: &str) -> io::Result<()>;
    /// Deletes one file or one empty folder. See [`delete_tree`] for folders with contents.
    fn delete(&mut self, path: &str, is_dir: bool) -> io::Result<()>;
}

/// Deletes a file or a whole folder (children first). Remote deletes are permanent.
pub fn delete_tree(p: &mut dyn RemoteProvider, path: &str, is_dir: bool) -> io::Result<()> {
    if path == "/" { return Err(invalid("won't delete the server's root folder")); }
    if is_dir {
        for e in p.list(path)? { delete_tree(p, &join(path, &e.name), e.is_dir)?; }
    }
    p.delete(path, is_dir)
}

pub(crate) fn hidden(name: &str) -> bool { name.starts_with('.') }

// ---------------- paths ----------------

/// Clean absolute remote path: '/'-separated, no empty, "." or ".." segments (".." can't climb above "/").
pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => { out.pop(); }
            s => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}
/// "remote:<id>/<path>" -> (id, "/<path>").
pub fn parse(p: &str) -> Option<(&str, String)> {
    let rest = p.strip_prefix(PREFIX)?;
    let (id, path) = rest.split_once(['/', '\\']).unwrap_or((rest, ""));
    (!id.is_empty()).then(|| (id, normalize(path)))
}
pub fn is_remote(p: &str) -> bool { p.starts_with(PREFIX) }
/// The UI form of a remote location: "remote:id/" for the root, "remote:id/a/b" otherwise.
pub fn make(id: &str, path: &str) -> String { format!("{PREFIX}{id}{}", normalize(path)) }
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}
pub fn parent(path: &str) -> String {
    let p = normalize(path);
    match p.rfind('/') { Some(0) | None => "/".into(), Some(i) => p[..i].to_string() }
}
pub fn name(path: &str) -> &str { path.trim_end_matches('/').rsplit('/').next().unwrap_or("") }

/// "name (2).ext", "name (3).ext"... like de_core::ops::free_name, checked against the server.
pub fn free_name(p: &mut dyn RemoteProvider, dir: &str, name: &str) -> io::Result<String> {
    let taken: Vec<String> = p.list(dir)?.into_iter().map(|e| e.name).collect();
    if !taken.iter().any(|t| t == name) { return Ok(join(dir, name)); }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let free = (2..).map(|i| format!("{stem} ({i}){ext}")).find(|n| !taken.contains(n)).unwrap();
    Ok(join(dir, &free))
}

/// A name that is legal on Windows (remote servers allow ':' '*' '?' etc.).
pub fn local_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c < ' ' || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let s = s.trim_end_matches([' ', '.']).to_string();
    if s.is_empty() { "_".into() } else { s }
}

// ---------------- connecting ----------------

/// Opens a session. `secret` = password, or the key passphrase when `key_file` is set.
/// SFTP refuses (before sending any password) a host key that isn't `conn.fingerprint`;
/// the error text then contains the server's "SHA256:..." fingerprint so the UI can offer to trust it.
pub fn connect(conn: &Conn, secret: Option<String>) -> io::Result<Box<dyn RemoteProvider>> {
    conn.validate()?;
    Ok(match conn.protocol {
        Protocol::Sftp => Box::new(sftp::Sftp::connect(conn, secret)?),
        Protocol::Ftp | Protocol::Ftps => Box::new(ftp::Ftp::connect(conn, secret)?),
        Protocol::Webdav | Protocol::Webdavs => Box::new(webdav::Dav::connect(conn, secret)?),
    })
}

/// Installs ring as rustls' crypto (FTPS and WebDAV over HTTPS); safe to call repeatedly.
pub(crate) fn tls_init() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

// ---------------- secrets (Windows Credential Manager) ----------------

const SERVICE: &str = "Delta Explorer";
fn entry(id: &str) -> io::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("{PREFIX}{id}")).map_err(io::Error::other)
}
pub fn load_secret(id: &str) -> io::Result<Option<String>> {
    match entry(id)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(io::Error::other(format!("Credential Manager: {e}"))),
    }
}
pub fn save_secret(id: &str, secret: &str) -> io::Result<()> {
    entry(id)?.set_password(secret).map_err(|e| io::Error::other(format!("Credential Manager: {e}")))
}
pub fn forget_secret(id: &str) -> io::Result<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(io::Error::other(format!("Credential Manager: {e}"))),
    }
}

// ---------------- pool ----------------

/// Errors that mean the session died (server restart, Wi-Fi drop, idle timeout): reconnect and retry once.
pub fn dropped(e: &io::Error) -> bool {
    use io::ErrorKind::*;
    matches!(e.kind(), ConnectionReset | ConnectionAborted | NotConnected | BrokenPipe | UnexpectedEof | TimedOut)
}

pub type Connector = dyn Fn(&Conn) -> io::Result<Box<dyn RemoteProvider>> + Send + Sync;
type Slot = Arc<Mutex<Option<Box<dyn RemoteProvider>>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }
/// Saying goodbye (FTP QUIT) is network I/O and callers may be on the UI thread: do it in the background.
fn close(slots: Vec<Slot>) {
    if !slots.is_empty() { std::thread::spawn(move || drop(slots)); }
}

/// One live session per saved connection, opened on first use and reopened when it drops.
/// Browsing shares it; jobs open their own (`open`) so a long copy never stalls browsing.
pub struct Pool {
    conns: Mutex<HashMap<String, Conn>>,
    live: Mutex<HashMap<String, Slot>>,
    connector: Box<Connector>,
}

impl Default for Pool {
    fn default() -> Self { Self::new(Box::new(|c: &Conn| connect(c, load_secret(&c.id)?))) }
}

impl Pool {
    pub fn new(connector: Box<Connector>) -> Self {
        Self { conns: Default::default(), live: Default::default(), connector }
    }
    /// The saved connections changed: sessions of edited or removed ones close.
    pub fn configure(&self, list: Vec<Conn>) {
        let new: HashMap<String, Conn> = list.into_iter().map(|c| (c.id.clone(), c)).collect();
        let mut conns = lock(&self.conns);
        let mut live = lock(&self.live);
        let gone: Vec<String> = live.keys().filter(|id| conns.get(*id).is_none_or(|old| new.get(*id) != Some(old))).cloned().collect();
        close(gone.iter().filter_map(|id| live.remove(id)).collect());
        *conns = new;
    }
    /// Closes the session (next use reconnects), e.g. after its password changed.
    pub fn reset(&self, id: &str) { close(lock(&self.live).remove(id).into_iter().collect()); }
    pub fn conn(&self, id: &str) -> io::Result<Conn> {
        lock(&self.conns).get(id).cloned().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "This remote connection was removed"))
    }
    /// A fresh session not shared with browsing.
    pub fn open(&self, id: &str) -> io::Result<Box<dyn RemoteProvider>> { (self.connector)(&self.conn(id)?) }

    pub fn with<T>(&self, id: &str, mut f: impl FnMut(&mut dyn RemoteProvider) -> io::Result<T>) -> io::Result<T> {
        let conn = self.conn(id)?;
        let slot = lock(&self.live).entry(id.to_string()).or_default().clone();
        let mut s = lock(&slot);
        let mut retried = false;
        loop {
            if s.is_none() { *s = Some((self.connector)(&conn)?); }
            match f(s.as_deref_mut().unwrap()) {
                Err(e) if dropped(&e) && !retried => { *s = None; retried = true; }
                r => return r,
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod fake;

#[cfg(test)]
mod tests {
    use super::*;
    use fake::Fake;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn paths() {
        assert_eq!(parse("remote:abc/"), Some(("abc", "/".into())));
        assert_eq!(parse("remote:abc"), Some(("abc", "/".into())));
        assert_eq!(parse("remote:abc/home//me/./x/../y"), Some(("abc", "/home/me/y".into())));
        assert_eq!(parse("remote:abc/../../etc"), Some(("abc", "/etc".into())));
        assert_eq!(parse("remote:/x"), None);
        assert_eq!(parse("C:\\x"), None);
        assert_eq!(make("abc", "/"), "remote:abc/");
        assert_eq!(make("abc", "a/b/"), "remote:abc/a/b");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b c"), "/a/b c");
        assert_eq!(parent("/a/b"), "/a");
        assert_eq!(parent("/a"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(name("/a/b.txt"), "b.txt");
        assert_eq!(local_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(local_name("trailing. "), "trailing");
    }

    #[test]
    fn validates_input() {
        let ok = Conn { id: "a-1".into(), host: "files.example.com".into(), ..Default::default() };
        assert!(ok.validate().is_ok());
        assert!(Conn { id: "../x".into(), ..ok.clone() }.validate().is_err());
        assert!(Conn { host: "sftp://x".into(), ..ok.clone() }.validate().is_err());
        assert_eq!(Conn { protocol: Protocol::Webdavs, ..ok.clone() }.port(), 443);
        assert_eq!(Conn { port: 2222, ..ok }.port(), 2222);
    }

    #[test]
    fn free_names_and_tree_delete() {
        let mut f = Fake::default();
        f.file("/d/a.txt", b"1");
        f.file("/d/a (2).txt", b"2");
        f.file("/d/sub/x", b"3");
        assert_eq!(free_name(&mut f, "/d", "b.txt").unwrap(), "/d/b.txt");
        assert_eq!(free_name(&mut f, "/d", "a.txt").unwrap(), "/d/a (3).txt");
        assert_eq!(free_name(&mut f, "/d", "sub").unwrap(), "/d/sub (2)");
        assert!(f.stat("/d/sub").unwrap().unwrap().is_dir);
        assert!(f.stat("/nope").unwrap().is_none());
        delete_tree(&mut f, "/d", true).unwrap();
        assert!(f.stat("/d").unwrap().is_none());
        assert!(delete_tree(&mut f, "/", true).is_err());
    }

    #[test]
    fn pool_reconnects_once_and_drops_edited() {
        let made = Arc::new(AtomicUsize::new(0));
        let m = made.clone();
        let pool = Pool::new(Box::new(move |_c: &Conn| {
            m.fetch_add(1, Ordering::SeqCst);
            let mut f = Fake::default();
            f.file("/x", b"hi");
            Ok(Box::new(f) as Box<dyn RemoteProvider>)
        }));
        let c = Conn { id: "a".into(), host: "h".into(), ..Default::default() };
        pool.configure(vec![c.clone()]);
        assert_eq!(pool.with("a", |p| p.list("/")).unwrap().len(), 1);
        assert_eq!(pool.with("a", |p| p.list("/")).unwrap().len(), 1);
        assert_eq!(made.load(Ordering::SeqCst), 1, "session is reused");
        // The server dropped us: one transparent reconnect.
        let mut first = true;
        let r = pool.with("a", |p| if std::mem::take(&mut first) { Err(io::ErrorKind::ConnectionReset.into()) } else { p.list("/") });
        assert!(r.is_ok());
        assert_eq!(made.load(Ordering::SeqCst), 2);
        // Still failing after the retry: the error reaches the UI, no endless loop.
        let r: io::Result<()> = pool.with("a", |_| Err(io::ErrorKind::TimedOut.into()));
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::TimedOut);
        // Real errors are not retried.
        let before = made.load(Ordering::SeqCst);
        let r: io::Result<()> = pool.with("a", |_| Err(io::ErrorKind::NotFound.into()));
        assert!(r.is_err());
        assert_eq!(made.load(Ordering::SeqCst), before);
        // Unchanged config keeps the session; an edit closes it.
        pool.configure(vec![c.clone()]);
        pool.with("a", |p| p.list("/")).unwrap();
        assert_eq!(made.load(Ordering::SeqCst), before);
        pool.configure(vec![Conn { user: "other".into(), ..c }]);
        pool.with("a", |p| p.list("/")).unwrap();
        assert_eq!(made.load(Ordering::SeqCst), before + 1);
        pool.configure(vec![]);
        assert!(pool.with("a", |p| p.list("/")).is_err());
    }
}
