//! WebDAV over HTTP(S): PROPFIND to list, GET/PUT to transfer, MKCOL/MOVE/DELETE to change.
//! shortcut: Basic auth only (no Digest/NTLM); fine over HTTPS, add Digest if someone's server needs it.
use crate::{hidden, invalid, Conn, Entry, Protocol, RemoteProvider, TIMEOUT};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{
    blocking::{Body, Client, RequestBuilder, Response},
    Method, StatusCode,
};
use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, UNIX_EPOCH},
};

/// Characters escaped inside one path segment.
const SEG: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}').add(b'/').add(b'\\').add(b'^').add(b'|').add(b'[').add(b']');

pub struct Dav {
    http: Client,
    base: String,
    user: String,
    pass: Option<String>,
}

fn http_err(e: reqwest::Error) -> io::Error {
    let kind = if e.is_timeout() { io::ErrorKind::TimedOut } else if e.is_connect() { io::ErrorKind::ConnectionRefused } else { io::ErrorKind::Other };
    // The innermost cause reads best ("certificate not valid for name", "connection refused").
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src { msg = s.to_string(); src = s.source(); }
    io::Error::new(kind, msg)
}
fn status_err(s: StatusCode) -> io::Error {
    let kind = match s.as_u16() {
        401 => return io::Error::new(io::ErrorKind::PermissionDenied, "The server rejected the user name or password"),
        403 => io::ErrorKind::PermissionDenied,
        404 | 409 => io::ErrorKind::NotFound,
        405 | 412 => io::ErrorKind::AlreadyExists,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, format!("server said {s}"))
}
fn check(r: Response) -> io::Result<Response> {
    if r.status().is_success() { Ok(r) } else { Err(status_err(r.status())) }
}

impl Dav {
    pub fn connect(c: &Conn, secret: Option<String>) -> io::Result<Self> {
        crate::tls_init();
        let http = Client::builder().connect_timeout(TIMEOUT).timeout(TIMEOUT).user_agent("Delta Explorer").build().map_err(http_err)?;
        let tls = c.protocol == Protocol::Webdavs;
        let default = if tls { 443 } else { 80 };
        let port = if c.port() == default { String::new() } else { format!(":{}", c.port()) };
        let base = format!("{}://{}{port}", if tls { "https" } else { "http" }, c.host.trim());
        Ok(Self { http, base, user: c.user.clone(), pass: secret })
    }
    fn url(&self, path: &str, dir: bool) -> String {
        let mut u = self.base.clone();
        for seg in path.split('/').filter(|s| !s.is_empty()) { u.push('/'); u.extend(utf8_percent_encode(seg, SEG)); }
        if dir || u == self.base { u.push('/'); }
        u
    }
    fn req(&self, m: &str, url: String) -> RequestBuilder {
        let r = self.http.request(Method::from_bytes(m.as_bytes()).unwrap(), url);
        if self.user.is_empty() { r } else { r.basic_auth(&self.user, self.pass.as_ref()) }
    }
}

const PROPFIND: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

/// Path part of an href ("https://h/a%20b/" or "/a%20b/" -> "/a b"), without a trailing slash.
fn href_path(href: &str) -> String {
    let p = match href.find("://") { Some(i) => href[i + 3..].find('/').map_or("/", |j| &href[i + 3 + j..]), None => href };
    let p = percent_decode_str(p).decode_utf8_lossy();
    let t = p.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_string() }
}

/// Entries of a Depth: 1 PROPFIND reply for folder `dir` (the folder itself is left out).
pub(crate) fn parse_propfind(xml: &str, dir: &str) -> io::Result<Vec<Entry>> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad WebDAV reply: {e}")))?;
    let dir = match dir.trim_end_matches('/') { "" => "/", d => d };
    let mut out = Vec::new();
    for r in doc.descendants().filter(|n| n.tag_name().name() == "response") {
        let find = |name: &str| r.descendants().find(|n| n.tag_name().name() == name);
        let Some(href) = find("href").and_then(|n| n.text()) else { continue };
        let p = href_path(href.trim());
        if p == dir { continue; } // the folder itself
        let name = crate::name(&p).to_string();
        if name.is_empty() { continue; }
        let is_dir = find("collection").is_some();
        let size = find("getcontentlength").and_then(|n| n.text()).and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        let modified = find("getlastmodified").and_then(|n| n.text()).and_then(|t| httpdate::parse_http_date(t.trim()).ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
        out.push(Entry { hidden: hidden(&name), name, is_dir, size: if is_dir { 0 } else { size }, modified, ..Default::default() });
    }
    Ok(out)
}

/// Counts what reqwest has read of an upload, and stops it when cancelled.
struct Counting { f: fs::File, n: Arc<AtomicU64>, stop: Arc<AtomicBool> }
impl Read for Counting {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.stop.load(Ordering::Relaxed) { return Err(de_core::transfer::cancelled()); }
        let k = self.f.read(buf)?;
        self.n.fetch_add(k as u64, Ordering::Relaxed);
        Ok(k)
    }
}

impl RemoteProvider for Dav {
    fn list(&mut self, dir: &str) -> io::Result<Vec<Entry>> {
        let r = self.req("PROPFIND", self.url(dir, true)).header("Depth", "1").header("Content-Type", "application/xml").body(PROPFIND).send().map_err(http_err)?;
        let r = check(r)?;
        parse_propfind(&r.text().map_err(http_err)?, dir)
    }
    fn download(&mut self, path: &str, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let mut r = check(self.req("GET", self.url(path, false)).send().map_err(http_err)?)?;
        let mut out = fs::File::create(to)?;
        let mut buf = vec![0; 256 * 1024];
        let mut done = 0;
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 { return Ok(()); }
            out.write_all(&buf[..n])?;
            done += n as u64;
            if !progress(done) { return Err(de_core::transfer::cancelled()); }
        }
    }
    fn upload(&mut self, from: &Path, path: &str, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let f = fs::File::open(from)?;
        let len = f.metadata()?.len();
        let (n, stop) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicBool::new(false)));
        let body = Body::sized(Counting { f, n: n.clone(), stop: stop.clone() }, len);
        // Big files take longer than TIMEOUT; cancelling (or a dead link: read errors) still ends it.
        let req = self.req("PUT", self.url(path, false)).timeout(Duration::from_secs(24 * 3600)).body(body);
        let t = std::thread::spawn(move || req.send());
        while !t.is_finished() {
            if !progress(n.load(Ordering::Relaxed)) { stop.store(true, Ordering::Relaxed); }
            std::thread::sleep(Duration::from_millis(100));
        }
        let r = t.join().map_err(|_| io::Error::other("upload thread failed"))?;
        if stop.load(Ordering::Relaxed) { return Err(de_core::transfer::cancelled()); }
        check(r.map_err(http_err)?)?;
        progress(len);
        Ok(())
    }
    fn mkdir(&mut self, path: &str) -> io::Result<()> {
        check(self.req("MKCOL", self.url(path, false)).send().map_err(http_err)?).map(|_| ())
    }
    fn rename(&mut self, from: &str, to: &str) -> io::Result<()> {
        if from == "/" { return Err(invalid("can't rename the root folder")); }
        check(self.req("MOVE", self.url(from, false)).header("Destination", self.url(to, false)).header("Overwrite", "F").send().map_err(http_err)?).map(|_| ())
    }
    fn delete(&mut self, path: &str, _is_dir: bool) -> io::Result<()> {
        check(self.req("DELETE", self.url(path, false)).send().map_err(http_err)?).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_propfind() {
        // Nextcloud-style: absolute paths, a base path in front, escaped names, a 404 propstat for folders.
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/files/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/files/me/My%20Docs/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 10 Nov 2026 08:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>https://cloud.example.com/dav/files/me/.env</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>42</d:getcontentlength></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/files/me/a%26b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength> 7 </d:getcontentlength></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let e = parse_propfind(xml, "/dav/files/me").unwrap();
        let names: Vec<_> = e.iter().map(|e| (e.name.as_str(), e.is_dir, e.size, e.hidden)).collect();
        assert_eq!(names, vec![("My Docs", true, 0, false), (".env", false, 42, true), ("a&b.txt", false, 7, false)]);
        assert_eq!(e[0].modified, 1_794_297_600);
        // Other namespace prefixes are fine too.
        let xml2 = r#"<multistatus xmlns="DAV:"><response><href>/x/</href></response><response><href>/x/y</href><propstat><prop><resourcetype/></prop></propstat></response></multistatus>"#;
        assert_eq!(parse_propfind(xml2, "/x").unwrap().len(), 1);
        assert!(parse_propfind("not xml", "/").is_err());
    }

    /// Starts dav-server (in memory) on a free local port.
    fn server() -> u16 {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let dav = dav_server::DavHandler::builder().filesystem(dav_server::memfs::MemFs::new()).locksystem(dav_server::fakels::FakeLs::new()).build_handler();
                let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(l.local_addr().unwrap().port()).unwrap();
                loop {
                    let (s, _) = l.accept().await.unwrap();
                    let dav = dav.clone();
                    tokio::spawn(async move {
                        let svc = hyper::service::service_fn(move |req| { let dav = dav.clone(); async move { Ok::<_, std::convert::Infallible>(dav.handle(req).await) } });
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(s), svc).await;
                    });
                }
            });
        });
        rx.recv().unwrap()
    }

    #[test]
    fn against_a_real_server() {
        let port = server();
        let c = Conn { id: "w".into(), host: "127.0.0.1".into(), port, protocol: Protocol::Webdav, ..Default::default() };
        let mut d = crate::connect(&c, None).unwrap();
        let tmp = std::env::temp_dir().join(format!("DeltaAgent-dav-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.txt"), b"hello dav").unwrap();

        d.mkdir("/My Docs").unwrap();
        d.upload(&tmp.join("a.txt"), "/My Docs/a #1.txt", &mut |_| true).unwrap();
        let l = d.list("/My Docs").unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].name.as_str(), l[0].size, l[0].is_dir), ("a #1.txt", 9, false));
        assert!(d.list("/").unwrap().iter().any(|e| e.name == "My Docs" && e.is_dir));
        assert!(d.stat("/My Docs/a #1.txt").unwrap().is_some());
        assert!(d.stat("/nope").unwrap().is_none());
        assert_eq!(d.list("/nope").unwrap_err().kind(), io::ErrorKind::NotFound);

        let mut seen = 0;
        d.download("/My Docs/a #1.txt", &tmp.join("b.txt"), &mut |n| { seen = n; true }).unwrap();
        assert_eq!(fs::read(tmp.join("b.txt")).unwrap(), b"hello dav");
        assert_eq!(seen, 9);

        d.rename("/My Docs", "/Renamed").unwrap();
        assert!(d.stat("/Renamed/a #1.txt").unwrap().is_some());
        // Whole-job path: pool + transfer, local folder up and back down.
        let pool = crate::Pool::new(Box::new(|c: &Conn| crate::connect(c, None)));
        pool.configure(vec![c.clone()]);
        let open = |id: &str| pool.open(id);
        let mut s = crate::transfer::Sessions::new(&open);
        struct Nop;
        impl de_core::transfer::Sink for Nop { fn bytes(&mut self, _: u64) {} fn item(&mut self, _: &Path) {} fn cancelled(&self) -> bool { false } }
        crate::transfer::copy(&[crate::transfer::Loc::Remote { id: "w".into(), path: "/Renamed".into() }], &crate::transfer::Loc::Local(tmp.clone()), false, &mut s, &mut Nop, &mut vec![]).unwrap();
        assert_eq!(fs::read(tmp.join("Renamed").join("a #1.txt")).unwrap(), b"hello dav");

        crate::delete_tree(d.as_mut(), "/Renamed", true).unwrap();
        assert!(d.list("/").unwrap().is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn urls() {
        let c = Conn { id: "a".into(), host: "dav.example.com".into(), protocol: Protocol::Webdavs, ..Default::default() };
        let d = Dav::connect(&c, None).unwrap();
        assert_eq!(d.url("/", true), "https://dav.example.com/");
        assert_eq!(d.url("/a b/c#1.txt", false), "https://dav.example.com/a%20b/c%231.txt");
        assert_eq!(d.url("/a", true), "https://dav.example.com/a/");
        let d = Dav::connect(&Conn { port: 8080, protocol: Protocol::Webdav, ..c }, None).unwrap();
        assert_eq!(d.url("/x", false), "http://dav.example.com:8080/x");
        assert_eq!(href_path("https://h:1/a%20b/"), "/a b");
        assert_eq!(href_path("/"), "/");
    }
}
