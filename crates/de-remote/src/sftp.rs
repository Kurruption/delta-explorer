//! SFTP over pure-Rust SSH (russh + russh-sftp). Async inside; blocking to callers via a small shared runtime.
use crate::{hidden, join, Conn, Entry, RemoteProvider, TIMEOUT};
use russh::{
    client,
    keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use russh_sftp::client::{error::Error as SftpError, SftpSession};
use std::{
    fs,
    future::Future,
    io::{self, Read, Write},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("delta-sftp").enable_all().build().expect("tokio runtime")
});

/// Runs one network step with a time limit.
fn run<T>(f: impl Future<Output = io::Result<T>>) -> io::Result<T> {
    RT.block_on(async { tokio::time::timeout(TIMEOUT, f).await.unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "the server stopped responding"))) })
}

fn ssh_err(e: russh::Error) -> io::Error {
    match e {
        russh::Error::IO(e) => io::Error::new(e.kind(), e.to_string()),
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout | russh::Error::InactivityTimeout => io::Error::new(io::ErrorKind::TimedOut, "connection timed out"),
        russh::Error::Disconnect | russh::Error::HUP | russh::Error::SendError => io::Error::new(io::ErrorKind::ConnectionAborted, "the server closed the connection"),
        e => io::Error::other(e.to_string()),
    }
}
fn sftp_err(e: SftpError) -> io::Error {
    use russh_sftp::protocol::StatusCode::*;
    match e {
        SftpError::Status(s) => {
            let kind = match s.status_code { NoSuchFile => io::ErrorKind::NotFound, PermissionDenied => io::ErrorKind::PermissionDenied, NoConnection | ConnectionLost => io::ErrorKind::ConnectionAborted, _ => io::ErrorKind::Other };
            let msg = if s.error_message.is_empty() { format!("{:?}", s.status_code) } else { s.error_message };
            io::Error::new(kind, msg)
        }
        SftpError::Timeout => io::Error::new(io::ErrorKind::TimedOut, "the server stopped responding"),
        SftpError::IO(m) => io::Error::new(io::ErrorKind::ConnectionAborted, m),
        e => io::Error::other(e.to_string()),
    }
}

/// Accepts only the pinned host key; remembers what the server offered so the error can show it.
struct Hk {
    pinned: String,
    seen: Arc<Mutex<String>>,
}
impl client::Handler for Hk {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().fingerprint(HashAlg::Sha256),
        }
        .to_string();
        let ok = !self.pinned.is_empty() && fp == self.pinned;
        *self.seen.lock().unwrap() = fp;
        Ok(ok)
    }
}

pub struct Sftp {
    ssh: Option<client::Handle<Hk>>,
    sftp: SftpSession,
}

impl Sftp {
    pub fn connect(c: &Conn, secret: Option<String>) -> io::Result<Self> {
        let seen = Arc::new(Mutex::new(String::new()));
        let cfg = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(600)),
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            ..Default::default()
        };
        let hk = Hk { pinned: c.fingerprint.clone(), seen: seen.clone() };
        let host = (c.host.trim().to_string(), c.port());
        let mut ssh = match run(async { client::connect(Arc::new(cfg), host, hk).await.map_err(ssh_err) }) {
            Ok(h) => h,
            Err(e) => {
                let fp = seen.lock().unwrap().clone();
                return Err(match (fp.is_empty(), c.fingerprint.is_empty()) {
                    (true, _) => e,
                    (false, true) => io::Error::new(io::ErrorKind::PermissionDenied, format!("This server's host key isn't trusted yet: {fp}. Edit the connection to check and trust it.")),
                    (false, false) => io::Error::new(io::ErrorKind::PermissionDenied, format!("Warning: this server's host key changed (now {fp}, trusted {}). Someone may be intercepting the connection. If the server was reinstalled, edit the connection to trust the new key.", c.fingerprint)),
                });
            }
        };
        let user = c.user.clone();
        let ok = if c.key_file.trim().is_empty() {
            let pw = secret.unwrap_or_default();
            run(async { ssh.authenticate_password(user, pw).await.map_err(ssh_err) })?.success()
        } else {
            let key = load_secret_key(c.key_file.trim(), secret.as_deref().filter(|s| !s.is_empty()))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("Couldn't read the key file {}: {e}", c.key_file.trim())))?;
            run(async {
                let hash = ssh.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
                ssh.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(ssh_err)
            })?
            .success()
        };
        if !ok {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "The server rejected the user name, password or key"));
        }
        let sftp = run(async {
            let ch = ssh.channel_open_session().await.map_err(ssh_err)?;
            ch.request_subsystem(true, "sftp").await.map_err(ssh_err)?;
            let s = SftpSession::new(ch.into_stream()).await.map_err(sftp_err)?;
            s.set_timeout(TIMEOUT.as_secs());
            Ok(s)
        })?;
        Ok(Self { ssh: Some(ssh), sftp })
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        // Say goodbye without blocking whoever dropped us (maybe the UI thread).
        if let Some(h) = self.ssh.take() {
            RT.spawn(async move { let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await; });
        }
    }
}

const CHUNK: usize = 256 * 1024;

impl RemoteProvider for Sftp {
    fn list(&mut self, dir: &str) -> io::Result<Vec<Entry>> {
        let s = &self.sftp;
        run(async {
            let mut out = Vec::new();
            for e in s.read_dir(dir).await.map_err(sftp_err)? {
                let name = e.file_name();
                if name == "." || name == ".." { continue; }
                let mut m = e.metadata();
                // Links: show what they point to (a linked folder opens like a folder).
                if e.file_type().is_symlink() { if let Ok(t) = s.metadata(join(dir, &name)).await { m = t; } }
                out.push(Entry { hidden: hidden(&name), is_dir: m.is_dir(), size: if m.is_dir() { 0 } else { m.size.unwrap_or(0) }, modified: m.mtime.unwrap_or(0) as u64, name, ..Default::default() });
            }
            Ok(out)
        })
    }
    fn stat(&mut self, path: &str) -> io::Result<Option<Entry>> {
        let s = &self.sftp;
        run(async {
            match s.metadata(path).await {
                Ok(m) => Ok(Some(Entry { name: crate::name(path).into(), hidden: hidden(crate::name(path)), is_dir: m.is_dir(), size: m.size.unwrap_or(0), modified: m.mtime.unwrap_or(0) as u64, ..Default::default() })),
                Err(e) => { let e = sftp_err(e); if e.kind() == io::ErrorKind::NotFound { Ok(None) } else { Err(e) } }
            }
        })
    }
    fn download(&mut self, path: &str, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let mut f = run(async { self.sftp.open(path).await.map_err(sftp_err) })?;
        let mut out = fs::File::create(to)?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        loop {
            let n = run(async { f.read(&mut buf).await.map_err(|e| io::Error::new(io::ErrorKind::ConnectionAborted, e.to_string())) })?;
            if n == 0 { break; }
            out.write_all(&buf[..n])?;
            done += n as u64;
            if !progress(done) { return Err(de_core::transfer::cancelled()); }
        }
        let _ = run(async { f.shutdown().await.map_err(io::Error::other) });
        Ok(())
    }
    fn upload(&mut self, from: &Path, path: &str, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let mut inp = fs::File::open(from)?;
        let mut f = run(async { self.sftp.create(path).await.map_err(sftp_err) })?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        loop {
            let n = inp.read(&mut buf)?;
            if n == 0 { break; }
            run(async { f.write_all(&buf[..n]).await.map_err(|e| io::Error::new(io::ErrorKind::ConnectionAborted, e.to_string())) })?;
            done += n as u64;
            if !progress(done) { return Err(de_core::transfer::cancelled()); }
        }
        run(async { f.shutdown().await.map_err(|e| io::Error::new(io::ErrorKind::ConnectionAborted, e.to_string())) })
    }
    fn mkdir(&mut self, path: &str) -> io::Result<()> { run(async { self.sftp.create_dir(path).await.map_err(sftp_err) }) }
    fn rename(&mut self, from: &str, to: &str) -> io::Result<()> { run(async { self.sftp.rename(from, to).await.map_err(sftp_err) }) }
    fn delete(&mut self, path: &str, is_dir: bool) -> io::Result<()> {
        run(async { if is_dir { self.sftp.remove_dir(path).await } else { self.sftp.remove_file(path).await }.map_err(sftp_err) })
    }
}
