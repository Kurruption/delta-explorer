//! FTP and FTPS (explicit TLS, AUTH TLS) via suppaftp; TLS by rustls with the Windows certificate store.
use crate::{hidden, Conn, Entry, Protocol, RemoteProvider, TIMEOUT};
use std::{
    fs,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    str::FromStr,
    sync::Arc,
    time::UNIX_EPOCH,
};
use suppaftp::{list::{File, ListParser}, types::FileType, FtpError, RustlsConnector, RustlsFtpStream};

fn ftp_err(e: FtpError) -> io::Error {
    match e {
        FtpError::ConnectionError(e) => e,
        FtpError::UnexpectedResponse(r) => {
            let code = r.status.code();
            let msg = String::from_utf8_lossy(&r.body).trim().to_string();
            let kind = match code {
                421 => io::ErrorKind::ConnectionAborted, // server is closing the session
                530 => io::ErrorKind::PermissionDenied,
                550 => io::ErrorKind::NotFound,
                553 => io::ErrorKind::InvalidInput,
                _ => io::ErrorKind::Other,
            };
            io::Error::new(kind, if msg.is_empty() { format!("FTP error {code}") } else { msg })
        }
        e => io::Error::other(e.to_string()),
    }
}

pub struct Ftp {
    s: RustlsFtpStream,
    /// Server understands MLSD (exact sizes and dates); else LIST, parsed best-effort.
    mlsd: bool,
}

impl Ftp {
    pub fn connect(c: &Conn, secret: Option<String>) -> io::Result<Self> {
        let host = c.host.trim();
        let addr = (host, c.port()).to_socket_addrs()?.next().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("Couldn't find {host}")))?;
        let s = RustlsFtpStream::connect_timeout(addr, TIMEOUT).map_err(ftp_err)?;
        s.get_ref().set_read_timeout(Some(TIMEOUT))?;
        s.get_ref().set_write_timeout(Some(TIMEOUT))?;
        // Data connections get the same limits, so a stalled transfer errors out instead of hanging.
        let mut s = s.passive_stream_builder(|a| {
            let t = TcpStream::connect_timeout(&a, TIMEOUT).map_err(FtpError::ConnectionError)?;
            t.set_read_timeout(Some(TIMEOUT)).and_then(|_| t.set_write_timeout(Some(TIMEOUT))).map_err(FtpError::ConnectionError)?;
            Ok(t)
        });
        s.set_passive_nat_workaround(true); // servers behind NAT often announce a private address
        if c.protocol == Protocol::Ftps {
            crate::tls_init();
            use rustls_platform_verifier::ConfigVerifierExt;
            let cfg = rustls::ClientConfig::with_platform_verifier().map_err(io::Error::other)?;
            s = s.into_secure(RustlsConnector::from(Arc::new(cfg)), host).map_err(ftp_err)?;
        }
        let user = if c.user.is_empty() { "anonymous" } else { c.user.as_str() };
        let pw = secret.unwrap_or_default();
        s.login(user, pw.as_str()).map_err(|e| match ftp_err(e) {
            e if e.kind() == io::ErrorKind::PermissionDenied => io::Error::new(e.kind(), "The server rejected the user name or password"),
            e => e,
        })?;
        s.transfer_type(FileType::Binary).map_err(ftp_err)?;
        Ok(Self { s, mlsd: true })
    }
}

impl Drop for Ftp {
    fn drop(&mut self) { let _ = self.s.quit(); }
}

fn entry(f: &File) -> Entry {
    let name = f.name().to_string();
    Entry {
        hidden: hidden(&name),
        is_dir: f.is_directory(),
        size: if f.is_directory() { 0 } else { f.size() as u64 },
        modified: f.modified().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        name,
        ..Default::default()
    }
}

const CHUNK: usize = 256 * 1024;

impl RemoteProvider for Ftp {
    fn list(&mut self, dir: &str) -> io::Result<Vec<Entry>> {
        if self.mlsd {
            match self.s.mlsd(Some(dir)) {
                Ok(lines) => return Ok(lines.iter().filter_map(|l| ListParser::parse_mlsd(l).ok()).filter(|f| f.name() != "." && f.name() != "..").map(|f| entry(&f)).collect()),
                // 500/502: no MLSD on this server; fall back to LIST for good.
                Err(FtpError::UnexpectedResponse(r)) if matches!(r.status.code(), 500 | 501 | 502) => self.mlsd = false,
                Err(e) => return Err(ftp_err(e)),
            }
        }
        let lines = self.s.list(Some(dir)).map_err(ftp_err)?;
        Ok(lines.iter().filter_map(|l| File::from_str(l).ok()).filter(|f| f.name() != "." && f.name() != "..").map(|f| entry(&f)).collect())
    }
    fn download(&mut self, path: &str, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let mut out = fs::File::create(to)?;
        let mut stream = self.s.retr_as_stream(path).map_err(ftp_err)?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        loop {
            let n = stream.read(&mut buf)?;
            if n == 0 { break; }
            out.write_all(&buf[..n])?;
            done += n as u64;
            if !progress(done) { let _ = self.s.abort(stream); return Err(de_core::transfer::cancelled()); }
        }
        stream.finish().map_err(ftp_err)
    }
    fn upload(&mut self, from: &Path, path: &str, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let mut inp = fs::File::open(from)?;
        let mut stream = self.s.put_with_stream(path).map_err(ftp_err)?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        loop {
            let n = inp.read(&mut buf)?;
            if n == 0 { break; }
            stream.write_all(&buf[..n])?;
            done += n as u64;
            if !progress(done) { let _ = self.s.abort(stream); return Err(de_core::transfer::cancelled()); }
        }
        stream.flush()?;
        stream.finish().map_err(ftp_err)
    }
    fn mkdir(&mut self, path: &str) -> io::Result<()> { self.s.mkdir(path).map_err(ftp_err) }
    fn rename(&mut self, from: &str, to: &str) -> io::Result<()> { self.s.rename(from, to).map_err(ftp_err) }
    fn delete(&mut self, path: &str, is_dir: bool) -> io::Result<()> {
        if is_dir { self.s.rmdir(path) } else { self.s.rm(path) }.map_err(ftp_err)
    }
}
