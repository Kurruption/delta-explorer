//! Remote connections (SFTP, FTP/FTPS, WebDAV): Tauri commands plus the remote branches of
//! list_dir / create_dir / rename / delete_forever. The logic lives in crates/de-remote.
use de_remote::{Conn, Pool};
use std::{path::Path, sync::Arc};

pub type Remotes = Arc<Pool>;

fn e(e: std::io::Error) -> String { e.to_string() }
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// "remote:<id>/<path>" given as a PathBuf by the generic commands.
pub fn parse(p: &Path) -> Option<(String, String)> {
    p.to_str().and_then(de_remote::parse).map(|(id, path)| (id.to_string(), path))
}

pub fn list(pool: &Pool, path: &str) -> Result<Vec<de_core::Entry>, String> {
    let (id, p) = de_remote::parse(path).ok_or("bad remote path")?;
    pool.with(id, |r| r.list(&p)).map_err(|err| format!("{}: {err}", pool.conn(id).map(|c| c.name).unwrap_or_default()))
}

pub async fn create_dir(pool: Remotes, id: String, parent: String, name: String) -> Result<String, String> {
    de_core::ops::validate_name(&name).map_err(e)?;
    blocking(move || {
        pool.with(&id, |r| {
            let to = de_remote::free_name(r, &parent, &name)?;
            r.mkdir(&to)?;
            Ok(de_remote::name(&to).to_string())
        })
        .map_err(e)
    })
    .await
}

pub async fn rename(pool: Remotes, id: String, path: String, name: String) -> Result<(), String> {
    de_core::ops::validate_name(&name).map_err(e)?;
    blocking(move || {
        let to = de_remote::join(&de_remote::parent(&path), &name);
        pool.with(&id, |r| {
            if r.stat(&to)?.is_some() { return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, format!("“{name}” already exists"))); }
            r.rename(&path, &to)
        })
        .map_err(e)
    })
    .await
}

/// Remote deletes are permanent (servers have no Recycle Bin); the UI always confirms first.
pub async fn delete(pool: Remotes, items: Vec<(String, String)>) -> Result<(), String> {
    blocking(move || {
        for (id, path) in &items {
            pool.with(id, |r| {
                let dir = r.stat(path)?.map(|x| x.is_dir).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("{path}: not found")))?;
                de_remote::delete_tree(r, path, dir)
            })
            .map_err(|err| format!("{path}: {err}"))?;
        }
        Ok(())
    })
    .await
}

/// The saved connections (no secrets) as the UI keeps them.
#[tauri::command]
pub fn remote_configure(pool: tauri::State<'_, Remotes>, conns: Vec<Conn>) {
    pool.configure(conns.into_iter().filter(|c| c.validate().is_ok()).collect());
}
/// Stores a password / key passphrase in Windows Credential Manager.
#[tauri::command]
pub async fn remote_set_secret(pool: tauri::State<'_, Remotes>, id: String, secret: String) -> Result<(), String> {
    let pool = pool.inner().clone();
    blocking(move || { de_remote::save_secret(&id, &secret).map_err(e)?; pool.reset(&id); Ok(()) }).await
}
/// Connection removed: its credential goes too.
#[tauri::command]
pub async fn remote_forget(pool: tauri::State<'_, Remotes>, id: String) -> Result<(), String> {
    let pool = pool.inner().clone();
    blocking(move || { pool.reset(&id); de_remote::forget_secret(&id).map_err(e) }).await
}
/// Tries a connection before saving it: connects (with `secret`, or the stored one) and lists its folder.
/// An untrusted SFTP host key fails here with its fingerprint in the message, before any password is sent.
#[tauri::command]
pub async fn remote_test(conn: Conn, secret: Option<String>) -> Result<(), String> {
    blocking(move || {
        let secret = match secret { Some(s) => Some(s), None => de_remote::load_secret(&conn.id).map_err(e)? };
        let mut r = de_remote::connect(&conn, secret).map_err(e)?;
        r.list(&de_remote::normalize(&conn.path)).map(|_| ()).map_err(|err| format!("Connected, but couldn't open {}: {err}", de_remote::normalize(&conn.path)))
    })
    .await
}
/// Opens a remote file: downloads it to %TEMP%\Delta Remote\<id>\... and opens that copy with its app.
/// Returns the local copy. Changes to it are not uploaded back.
#[tauri::command]
pub async fn remote_open(pool: tauri::State<'_, Remotes>, path: String) -> Result<String, String> {
    let pool = pool.inner().clone();
    blocking(move || {
        let (id, p) = de_remote::parse(&path).ok_or("bad remote path")?;
        let mut local = std::env::temp_dir().join("Delta Remote").join(id);
        for seg in p.split('/').filter(|s| !s.is_empty()) { local.push(de_remote::local_name(seg)); }
        std::fs::create_dir_all(local.parent().unwrap()).map_err(e)?;
        // Through its own session: a big download shouldn't freeze browsing on the shared one.
        let mut r = pool.open(id).map_err(e)?;
        r.download(&p, &local, &mut |_| true).map_err(|err| format!("{p}: {err}"))?;
        de_shell::open(&local)?;
        Ok(de_core::display(&local))
    })
    .await
}
