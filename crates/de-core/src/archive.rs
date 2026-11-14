//! Archives: browse (list), extract and create.
//! Reads zip, 7z, rar, tar (plain / .gz / .bz2 / .xz) and single compressed files (.gz / .bz2 / .xz);
//! writes zip, 7z and tar.gz. Same rules as `transfer::extract`: every entry path is checked (no "..",
//! no absolute or drive paths, no ":" streams or device names), links stored in archives are never
//! created (they could point outside), and output goes into a new folder that is removed on error/cancel.
use crate::{
    ops::free_name,
    transfer::{cancelled, Sink},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::HashMap,
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    rc::Rc,
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comp { None, Gz, Bz2, Xz }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind { Zip, SevenZ, Rar, Tar(Comp), Single(Comp) }

const SUFFIXES: &[(&str, Kind)] = &[
    (".tar.gz", Kind::Tar(Comp::Gz)), (".tgz", Kind::Tar(Comp::Gz)),
    (".tar.bz2", Kind::Tar(Comp::Bz2)), (".tbz2", Kind::Tar(Comp::Bz2)), (".tbz", Kind::Tar(Comp::Bz2)),
    (".tar.xz", Kind::Tar(Comp::Xz)), (".txz", Kind::Tar(Comp::Xz)), (".tar", Kind::Tar(Comp::None)),
    (".zip", Kind::Zip), (".7z", Kind::SevenZ), (".rar", Kind::Rar),
    (".gz", Kind::Single(Comp::Gz)), (".bz2", Kind::Single(Comp::Bz2)), (".xz", Kind::Single(Comp::Xz)),
];

/// File name without its archive suffix ("a.tar.gz" -> "a"), and the format.
pub fn split_name(p: &Path) -> Option<(String, Kind)> {
    let name = p.file_name()?.to_string_lossy().into_owned();
    SUFFIXES.iter().find_map(|(s, k)| {
        let cut = name.len().checked_sub(s.len()).filter(|&c| c > 0)?;
        name.get(cut..).filter(|t| t.eq_ignore_ascii_case(s)).map(|_| (name[..cut].to_string(), *k))
    })
}
pub fn is_archive(p: &Path) -> bool { split_name(p).is_some() }

fn not_archive() -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, "not an archive Delta can open") }
fn other(e: impl std::fmt::Display) -> io::Error { io::Error::other(e.to_string()) }
const LOCKED: &str = "This archive is password-protected. Delta can't open encrypted archives yet; use 7-Zip or Windows to extract it.";
fn locked() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, LOCKED) }
fn zip_err(e: zip::result::ZipError) -> io::Error {
    use zip::result::ZipError as Z;
    match e {
        Z::UnsupportedArchive(m) if m == Z::PASSWORD_REQUIRED => locked(),
        Z::InvalidPassword => locked(),
        Z::Io(e) => e,
        e => other(e),
    }
}
fn sz_err(e: sevenz_rust2::Error) -> io::Error {
    use sevenz_rust2::Error as E;
    match e {
        E::PasswordRequired | E::MaybeBadPassword(_) => locked(),
        E::Io(e, _) => e,
        e => other(e),
    }
}
fn at(p: &Path) -> impl FnOnce(io::Error) -> io::Error + '_ {
    move |e| if e.kind() == io::ErrorKind::Interrupted { e } else { io::Error::new(e.kind(), format!("{}: {e}", p.display())) }
}

/// An entry name as a safe relative path (either slash), or None if it could land outside the target
/// folder or hit something special on Windows. Leading slashes and "." are dropped; empty = the root.
pub fn safe_rel(name: &str) -> Option<PathBuf> {
    const DEVICES: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." { continue; }
        if part == ".." || part.contains(':') || part.chars().any(|c| (c as u32) < 32) { return None; }
        let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let numbered = (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit();
        if DEVICES.contains(&stem.as_str()) || numbered { return None; }
        out.push(part);
    }
    Some(out)
}

// ---------- times ----------
fn civil_to_unix(y: i64, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    (days * 86_400 + (hh * 3600 + mm * 60 + ss) as i64).max(0) as u64
}
fn unix_to_civil(t: u64) -> (i64, u32, u32, u32, u32, u32) {
    let (days, s) = ((t / 86_400) as i64, (t % 86_400) as u32);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d, s / 3600, s / 60 % 60, s % 60)
}
fn dos_to_unix(t: u32) -> u64 {
    let (date, time) = (t >> 16, t & 0xffff);
    civil_to_unix(1980 + (date >> 9) as i64, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2)
}
const NT_TO_UNIX: u64 = 11_644_473_600;
fn nt_to_unix(t: sevenz_rust2::NtTime) -> u64 { (u64::from(t) / 10_000_000).saturating_sub(NT_TO_UNIX) }

// unrar_sys uses the registry and CryptoAPI but doesn't ask the linker for advapi32 itself.
#[link(name = "advapi32")]
extern "system" {}
#[link(name = "kernel32")]
extern "system" {
    fn FileTimeToLocalFileTime(ft: *const u64, local: *mut u64) -> i32;
}
/// Zip stores local wall-clock time (what Explorer shows), clamped to the format's 1980–2107 range.
pub fn zip_time(t: std::time::SystemTime) -> zip::DateTime {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let ft = (secs + NT_TO_UNIX) * 10_000_000;
    let mut local = ft;
    // SAFETY: both pointers are valid u64s (FILETIME is two u32s: same size, less strict alignment).
    let local = if unsafe { FileTimeToLocalFileTime(&ft, &mut local) } != 0 { (local / 10_000_000).saturating_sub(NT_TO_UNIX) } else { secs };
    let (y, m, d, hh, mm, ss) = unix_to_civil(local);
    if y < 1980 { return zip::DateTime::default(); }
    if y > 2107 { return zip::DateTime::from_date_and_time(2107, 12, 31, 23, 59, 58).unwrap_or_default(); }
    zip::DateTime::from_date_and_time(y as u16, m as u8, d as u8, hh as u8, mm as u8, ss as u8).unwrap_or_default()
}
fn zip_to_unix(d: zip::DateTime) -> u64 { civil_to_unix(d.year() as i64, d.month() as u32, d.day() as u32, d.hour() as u32, d.minute() as u32, d.second() as u32) }

// ---------- browse ----------
/// One entry of an archive listing; `path` uses '/' and is already safe.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}
fn push(out: &mut Vec<Item>, name: &str, is_dir: bool, size: u64, modified: u64) {
    if let Some(r) = safe_rel(name).filter(|r| !r.as_os_str().is_empty()) {
        out.push(Item { path: r.to_string_lossy().replace('\\', "/"), is_dir, size, modified });
    }
}

fn decoder<'a>(c: Comp, r: impl Read + 'a) -> Box<dyn Read + 'a> {
    match c {
        Comp::None => Box::new(r),
        Comp::Gz => Box::new(flate2::read::MultiGzDecoder::new(r)),
        Comp::Bz2 => Box::new(bzip2::read::MultiBzDecoder::new(r)),
        Comp::Xz => Box::new(lzma_rust2::XzReader::new(r, true)),
    }
}

/// Everything in an archive (unsafe names and links are left out). Tar and single files are read
/// through once; zip, 7z and rar only read their index.
pub fn list(path: &Path) -> io::Result<Vec<Item>> {
    let (stem, kind) = split_name(path).ok_or_else(not_archive)?;
    let mut out = Vec::new();
    let open = || fs::File::open(path).map(io::BufReader::new).map_err(at(path));
    match kind {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(open()?).map_err(zip_err)?;
            for i in 0..z.len() {
                let e = z.by_index_raw(i).map_err(zip_err)?;
                if e.is_symlink() { continue; }
                let name = e.name().map_err(zip_err)?.into_owned();
                push(&mut out, &name, e.is_dir(), e.size(), e.last_modified().map_or(0, zip_to_unix));
            }
        }
        Kind::SevenZ => {
            let a = sevenz_rust2::Archive::open(path).map_err(sz_err)?;
            for e in a.files.iter().filter(|e| !e.is_anti_item) {
                push(&mut out, &e.name, e.is_directory, e.size, nt_to_unix(e.last_modified_date));
            }
        }
        Kind::Tar(c) => {
            let mut t = tar::Archive::new(decoder(c, open()?));
            for e in t.entries()? {
                let e = e?;
                let ty = e.header().entry_type();
                if !(ty.is_file() || ty.is_dir()) { continue; }
                let name = String::from_utf8_lossy(&e.path_bytes()).into_owned();
                push(&mut out, &name, ty.is_dir(), e.size(), e.header().mtime().unwrap_or(0));
            }
        }
        Kind::Single(c) => {
            let n = io::copy(&mut decoder(c, open()?), &mut io::sink())?;
            let m = fs::metadata(path)?.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            push(&mut out, &stem, false, n, m);
        }
        Kind::Rar => {
            for h in unrar::Archive::new(path).open_for_listing().map_err(rar_err)? {
                let h = h.map_err(rar_err)?;
                push(&mut out, &h.filename.to_string_lossy(), h.is_directory(), h.unpacked_size, dos_to_unix(h.file_time));
            }
        }
    }
    Ok(out)
}
fn rar_err(e: unrar::error::UnrarError) -> io::Error {
    let s = e.to_string();
    if s.to_lowercase().contains("password") { locked() } else { other(format!("RAR: {s}")) }
}

/// Direct children of folder `inner` ('/'-separated, "" = top). Folders that only exist implicitly
/// (as part of deeper paths) are included.
pub fn children(items: &[Item], inner: &str) -> Vec<Item> {
    let inner = inner.trim_matches('/');
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let mut out: Vec<Item> = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for it in items {
        let Some(rest) = it.path.strip_prefix(&prefix) else { continue };
        let (name, deeper) = match rest.split_once('/') { Some((n, _)) => (n, true), None => (rest, false) };
        if name.is_empty() { continue; }
        let is_dir = deeper || it.is_dir;
        let i = *seen.entry(name).or_insert_with(|| {
            out.push(Item { path: format!("{prefix}{name}"), is_dir, size: 0, modified: 0 });
            out.len() - 1
        });
        let o = &mut out[i];
        o.is_dir |= is_dir;
        if !deeper { o.modified = it.modified; if !o.is_dir { o.size = it.size; } }
    }
    out
}

// ---------- extract ----------
/// Remembers the furthest byte read from the archive file, for progress.
struct Counted<R> { inner: R, at: u64, pos: Rc<Cell<u64>> }
impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.at += n as u64;
        if self.at > self.pos.get() { self.pos.set(self.at); }
        Ok(n)
    }
}
impl<R: Seek> Seek for Counted<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> { self.at = self.inner.seek(to)?; Ok(self.at) }
}

struct Out<'a> {
    root: PathBuf,
    sel: Option<&'a [String]>,
    sink: &'a mut dyn Sink,
    pos: Rc<Cell<u64>>,
    reported: u64,
    buf: Vec<u8>,
}
impl Out<'_> {
    fn tick(&mut self) {
        let p = self.pos.get();
        if p > self.reported { self.sink.bytes(p - self.reported); self.reported = p; }
    }
    /// Where an entry goes, or None to skip it. Errors on names that could escape.
    fn target(&self, name: &str) -> io::Result<Option<PathBuf>> {
        let rel = safe_rel(name).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("unsafe path in archive: {name}")))?;
        if rel.as_os_str().is_empty() { return Ok(None); }
        Ok(select(&rel, self.sel).map(|r| self.root.join(r)))
    }
    fn entry(&mut self, name: &str, is_dir: bool, is_link: bool, r: &mut dyn Read) -> io::Result<()> {
        if self.sink.cancelled() { return Err(cancelled()); }
        let Some(t) = self.target(name)? else { return Ok(()) };
        if is_link { return Ok(()); }
        if is_dir { return fs::create_dir_all(&t).map_err(at(&t)); }
        if let Some(p) = t.parent() { fs::create_dir_all(p).map_err(at(p))?; }
        self.sink.item(&t);
        let mut f = fs::File::create(&t).map_err(at(&t))?;
        loop {
            let n = r.read(&mut self.buf)?;
            if n == 0 { break; }
            f.write_all(&self.buf[..n]).map_err(at(&t))?;
            self.tick();
            if self.sink.cancelled() { return Err(cancelled()); }
        }
        Ok(())
    }
}

/// Only the selected items ('/'-separated) and what's inside them, placed relative to each one's parent.
fn select(rel: &Path, sel: Option<&[String]>) -> Option<PathBuf> {
    let Some(sel) = sel else { return Some(rel.to_path_buf()) };
    sel.iter().map(Path::new).find(|s| rel.starts_with(s)).and_then(|s| rel.strip_prefix(s.parent().unwrap_or(Path::new(""))).ok().map(Path::to_path_buf))
}

fn extract_into(path: &Path, kind: Kind, stem: &str, root: &Path, sel: Option<&[String]>, sink: &mut dyn Sink) -> io::Result<()> {
    let pos = Rc::new(Cell::new(0));
    let mut o = Out { root: root.to_path_buf(), sel, sink, pos: pos.clone(), reported: 0, buf: vec![0; 1 << 16] };
    if kind == Kind::Rar { return extract_rar(path, &mut o); }
    let file = Counted { inner: io::BufReader::new(fs::File::open(path).map_err(at(path))?), at: 0, pos };
    match kind {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(file).map_err(zip_err)?;
            for i in 0..z.len() {
                let mut e = z.by_index(i).map_err(zip_err)?;
                let name = e.name().map_err(zip_err)?.into_owned();
                let (d, l) = (e.is_dir(), e.is_symlink());
                o.entry(&name, d, l, &mut e)?;
            }
        }
        Kind::SevenZ => {
            let mut r = sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty()).map_err(sz_err)?;
            let mut err = None;
            let res = r.for_each_entries(|e, rd| {
                if e.is_anti_item { return Ok(true); }
                o.entry(&e.name, e.is_directory, false, rd).map(|_| true).map_err(|x| { err = Some(x); sevenz_rust2::Error::Other("stopped".into()) })
            });
            if let Some(e) = err { return Err(e); }
            res.map_err(sz_err)?;
        }
        Kind::Tar(c) => {
            let mut t = tar::Archive::new(decoder(c, file));
            for e in t.entries()? {
                let mut e = e?;
                let ty = e.header().entry_type();
                let name = String::from_utf8_lossy(&e.path_bytes()).into_owned();
                if ty.is_dir() { o.entry(&name, true, false, &mut io::empty())?; }
                else if ty.is_file() { o.entry(&name, false, false, &mut e)?; }
                else { o.target(&name)?; } // links, devices: never created, but a bad name still fails the archive
            }
        }
        Kind::Single(c) => o.entry(stem, false, false, &mut decoder(c, file))?,
        Kind::Rar => unreachable!(),
    }
    o.tick();
    Ok(())
}

fn extract_rar(path: &Path, o: &mut Out) -> io::Result<()> {
    let mut a = unrar::Archive::new(path).open_for_processing().map_err(rar_err)?;
    while let Some(h) = a.read_header().map_err(rar_err)? {
        if o.sink.cancelled() { return Err(cancelled()); }
        let e = h.entry();
        if e.is_encrypted() { return Err(locked()); }
        let (name, dir, size) = (e.filename.to_string_lossy().into_owned(), e.is_directory(), e.unpacked_size);
        a = match o.target(&name)? {
            Some(t) if dir => { fs::create_dir_all(&t).map_err(at(&t))?; h.skip() }
            Some(t) => {
                if let Some(p) = t.parent() { fs::create_dir_all(p).map_err(at(p))?; }
                o.sink.item(&t);
                let r = h.extract_to(&t);
                // unrar can restore links; remove one at once so later entries can't be written through it.
                if fs::symlink_metadata(&t).is_ok_and(|m| m.file_type().is_symlink()) { let _ = fs::remove_file(&t).or_else(|_| fs::remove_dir(&t)); }
                o.sink.bytes(size);
                r
            }
            None => h.skip(),
        }
        .map_err(rar_err)?;
    }
    Ok(())
}

/// Bytes a job's progress bar counts to for this archive (compressed bytes read; unpacked for RAR).
pub fn progress_total(path: &Path) -> io::Result<u64> {
    if split_name(path).is_some_and(|(_, k)| k == Kind::Rar) { return Ok(list(path)?.iter().map(|i| i.size).sum()); }
    Ok(fs::metadata(path).map_err(at(path))?.len())
}

/// A folder whose only content is one folder (or, with `files_too`, one file) is replaced by that item,
/// so "a.zip" holding "a/..." doesn't become "a\a\...". Returns where the result is.
fn lift(out: &Path, files_too: bool) -> io::Result<PathBuf> {
    let only = {
        let mut rd = fs::read_dir(out)?;
        match (rd.next().transpose()?, rd.next()) { (Some(e), None) => e, _ => return Ok(out.to_path_buf()) }
    };
    let is_dir = only.file_type()?.is_dir();
    if !is_dir && !files_too { return Ok(out.to_path_buf()); }
    let parent = out.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let tmp = free_name(parent, ".delta-extract");
    fs::rename(out, &tmp)?;
    let dest = if is_dir { out.to_path_buf() } else { free_name(parent, &only.file_name().to_string_lossy()) };
    match fs::rename(tmp.join(only.file_name()), &dest) {
        Ok(()) => { let _ = fs::remove_dir(&tmp); Ok(dest) }
        Err(e) => { let _ = fs::rename(&tmp, out); Err(e) }
    }
}

/// Zip bombs: an archive whose listed contents are hundreds of times its own size could fill the disk.
/// Zip/7z/RAR list their sizes up front, so this is checked before anything is written.
pub const BOMB_RATIO: u64 = 100;
pub const BOMB_MIN: u64 = 200 << 20;
fn bomb_check(path: &Path, kind: Kind) -> io::Result<()> {
    if !matches!(kind, Kind::Zip | Kind::SevenZ | Kind::Rar) { return Ok(()); }
    let packed = fs::metadata(path).map_err(at(path))?.len().max(1);
    let unpacked: u64 = list(path)?.iter().map(|i| i.size).sum();
    if unpacked > BOMB_MIN && unpacked / packed > BOMB_RATIO {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!(
            "This archive would unpack to {} GB from {} MB ({}× larger), which is typical of a \"zip bomb\" that fills the disk. Extraction was stopped.",
            unpacked >> 30, (packed >> 20).max(1), unpacked / packed)));
    }
    Ok(())
}

fn into_new_folder(path: &Path, sel: Option<&[String]>, parent: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    let (stem, kind) = split_name(path).ok_or_else(not_archive)?;
    if sel.is_none() { bomb_check(path, kind)?; }
    let out = free_name(parent, &stem);
    fs::create_dir(&out).map_err(at(&out))?; // only a folder we created is removed on failure
    let r = extract_into(path, kind, &stem, &out, sel, sink).and_then(|_| lift(&out, sel.is_some() || matches!(kind, Kind::Single(_))));
    if r.is_err() { let _ = fs::remove_dir_all(&out); }
    r
}

/// Extracts into a new folder next to the archive ("name", "name (2)"...). A single compressed file
/// (.gz/.bz2/.xz) becomes that file. Removes what it made on error/cancel.
pub fn extract(path: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    into_new_folder(path, None, path.parent().ok_or_else(|| io::Error::other("bad path"))?, sink)
}

/// "Extract to folder…": a new "Name" folder inside `dest`.
pub fn extract_to(path: &Path, dest: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    if !dest.is_dir() { return Err(at(dest)(io::Error::new(io::ErrorKind::NotFound, "destination folder not found"))); }
    into_new_folder(path, None, dest, sink)
}

/// "Extract here": the archive's contents land next to it (clashes get " (n)" names). Extracted into a
/// hidden temp folder first, so a failed or cancelled run leaves nothing behind. Returns what was created.
pub fn extract_here(path: &Path, sink: &mut dyn Sink) -> io::Result<Vec<PathBuf>> {
    let parent = path.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let (stem, kind) = split_name(path).ok_or_else(not_archive)?;
    bomb_check(path, kind)?;
    let tmp = free_name(parent, &format!(".{stem}-extract{PARTIAL}"));
    fs::create_dir(&tmp).map_err(at(&tmp))?;
    set_hidden(&tmp);
    let mut made = Vec::new();
    let r = extract_into(path, kind, &stem, &tmp, None, sink).and_then(|()| {
        for e in fs::read_dir(&tmp)? {
            let e = e?;
            let dest = free_name(parent, &e.file_name().to_string_lossy());
            fs::rename(e.path(), &dest).map_err(at(&dest))?;
            made.push(dest);
        }
        Ok(())
    });
    let _ = fs::remove_dir_all(&tmp); // only our own temp folder
    r.map(|()| made)
}

/// Extracts only `sel` (inner '/'-paths) into a new folder in `dest` named after the archive; one selected
/// item comes out on its own (no wrapper folder).
pub fn extract_selected(path: &Path, sel: &[String], dest: &Path, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    into_new_folder(path, Some(sel), dest, sink)
}

// ---------- virtual paths ("archive:<file>?<inner>", inner with '\') ----------
pub const PREFIX: &str = "archive:";
pub fn parse_virtual(p: &str) -> Option<(PathBuf, String)> {
    let (file, inner) = p.strip_prefix(PREFIX)?.split_once('?')?;
    Some((PathBuf::from(file), inner.replace('\\', "/").trim_matches('/').to_string()))
}
pub fn virtual_path(file: &str, inner: &str) -> String { format!("{PREFIX}{file}?{}", inner.replace('/', "\\")) }

/// Turns archive paths into real files: extracts them into a new folder under `tmp_root`
/// and returns what came out, one path per selected item. Real paths pass through unchanged.
pub fn materialize(paths: &[PathBuf], tmp_root: &Path, sink: &mut dyn Sink) -> io::Result<Vec<PathBuf>> {
    let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let mut out = Vec::new();
    for p in paths {
        match parse_virtual(&p.to_string_lossy()) {
            Some((f, inner)) if !inner.is_empty() => match groups.iter_mut().find(|g| g.0 == f) {
                Some(g) => g.1.push(inner),
                None => groups.push((f, vec![inner])),
            },
            Some(_) => return Err(io::Error::new(io::ErrorKind::InvalidInput, "pick items inside the archive")),
            None => out.push(p.clone()),
        }
    }
    for (f, sel) in groups {
        fs::create_dir_all(tmp_root)?;
        let dir = free_name(tmp_root, "x");
        fs::create_dir(&dir)?;
        let (stem, kind) = split_name(&f).ok_or_else(not_archive)?;
        if let Err(e) = extract_into(&f, kind, &stem, &dir, Some(&sel), sink) { let _ = fs::remove_dir_all(&dir); return Err(e); }
        for e in fs::read_dir(&dir)? { out.push(e?.path()); }
    }
    Ok(out)
}

// ---------- create ----------
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Format { Zip, SevenZ, TarGz }
impl Format {
    pub fn ext(self) -> &'static str { match self { Format::Zip => "zip", Format::SevenZ => "7z", Format::TarGz => "tar.gz" } }
}

/// Compressing only makes sense for folders (a zipped shortcut or single file is pointless).
pub fn only_folders(items: &[PathBuf]) -> io::Result<()> {
    if items.is_empty() || !items.iter().all(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Only folders can be compressed. Select one or more folders (no files or shortcuts)."));
    }
    Ok(())
}

/// Every file and folder under `items`, with its name inside the archive ("Top/sub/file").
/// Links and junctions are skipped: following one could loop forever or pull in a whole drive.
fn walk(items: &[PathBuf], f: &mut dyn FnMut(&str, &Path, &fs::Metadata) -> io::Result<()>) -> io::Result<()> {
    fn go(p: &Path, name: String, f: &mut dyn FnMut(&str, &Path, &fs::Metadata) -> io::Result<()>) -> io::Result<()> {
        let m = fs::symlink_metadata(p).map_err(at(p))?;
        if m.file_type().is_symlink() { return Ok(()); }
        f(&name, p, &m)?;
        if m.is_dir() {
            for e in fs::read_dir(p).map_err(at(p))? {
                let e = e?;
                go(&e.path(), format!("{name}/{}", e.file_name().to_string_lossy()), f)?;
            }
        }
        Ok(())
    }
    for i in items { go(i, i.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), f)?; }
    Ok(())
}

/// Reads a source file, reporting bytes and stopping on cancel.
struct Progress<'a, R> { r: R, sink: &'a mut dyn Sink }
impl<R: Read> Read for Progress<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.sink.cancelled() { return Err(cancelled()); }
        let n = self.r.read(buf)?;
        self.sink.bytes(n as u64);
        Ok(n)
    }
}

// ---------- fast zip ----------
const BUF: usize = 1 << 20;
/// Files at least this big are sampled before compressing.
const SAMPLE_MIN: u64 = 64 * 1024;
/// Compressed pieces up to this size are kept in memory; bigger ones go through a temp file.
const IN_MEMORY: u64 = 4 << 20;

/// Formats that are already compressed: deflating them again costs a lot of time and saves ~nothing.
fn already_compressed(name: &str) -> bool {
    const EXT: &[&str] = &[
        "jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "jxl", "mp4", "m4v", "mkv", "mov", "webm", "avi", "wmv", "flv",
        "mp3", "aac", "m4a", "ogg", "oga", "opus", "flac", "wma", "zip", "7z", "rar", "gz", "tgz", "xz", "txz", "bz2", "zst", "lz4",
        "lzma", "cab", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "apk", "aab", "jar", "ipa", "appx", "msix", "nupkg", "whl",
        "pck", "pak", "vpk", "bsa", "ba2", "upk", "utoc", "ucas", "bik", "bk2", "usm", "woff", "woff2", "crx", "xpi",
    ];
    name.rsplit_once('.').is_some_and(|(_, e)| EXT.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Deflates the first 1 MB at the fastest level: false if that saves under 5% (random, encrypted or packed data).
fn worth_compressing(p: &Path) -> io::Result<bool> {
    let mut buf = Vec::with_capacity(BUF);
    fs::File::open(p)?.take(BUF as u64).read_to_end(&mut buf)?;
    let mut e = flate2::write::DeflateEncoder::new(Vec::with_capacity(buf.len()), flate2::Compression::fast());
    e.write_all(&buf)?;
    Ok(e.finish()?.len() * 100 < buf.len() * 95)
}

struct Ent { name: String, path: PathBuf, dir: bool, len: u64, time: zip::DateTime, store: bool }
/// A compressed file, ready to be copied into the archive as is.
enum Piece { Direct, Mem(Vec<u8>), Tmp(PathBuf) }

/// Copies `r` into the current entry, checking `stop` between 1 MB chunks; `tick` gets the bytes done.
fn pump(r: &mut dyn Read, w: &mut dyn Write, buf: &mut [u8], stop: &dyn Fn() -> bool, tick: &mut dyn FnMut(u64)) -> io::Result<()> {
    loop {
        if stop() { return Err(cancelled()); }
        let n = r.read(buf)?;
        if n == 0 { return Ok(()); }
        w.write_all(&buf[..n])?;
        tick(n as u64);
    }
}

/// Zip writer tuned for speed: already-compressed files (known types, or a sample that won't shrink)
/// are stored at copy speed, everything else is deflated on all cores into single-entry pieces that
/// the main thread raw-copies into the archive in order (memory bounded by a small window).
fn fast_zip(items: &[PathBuf], target: &Path, file: fs::File, level: u32, password: Option<&str>, sink: &mut dyn Sink) -> io::Result<()> {
    use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed}, Condvar, Mutex};
    let mut ents = Vec::new();
    walk(items, &mut |name, p, m| {
        let time = zip_time(m.modified().unwrap_or(UNIX_EPOCH));
        ents.push(Ent { name: name.to_string(), path: p.to_path_buf(), dir: m.is_dir(), len: m.len(), time, store: level == 0 || already_compressed(name) });
        Ok(())
    })?;
    let opts = |store: bool, time: zip::DateTime| {
        let o = zip::write::SimpleFileOptions::default()
            .large_file(true)
            .last_modified_time(time)
            .compression_method(if store { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated })
            .compression_level((!store).then_some(level as i64));
        match password { Some(pw) => o.with_aes_encryption(zip::AesMode::Aes256, pw), None => o }
    };
    let parent = target.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let parts = free_name(parent, &format!(".{}-parts{PARTIAL}", target.file_name().unwrap_or_default().to_string_lossy()));
    fs::create_dir(&parts).map_err(at(&parts))?;
    set_hidden(&parts);

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let window = threads * 2;
    let state = Mutex::new((Vec::<Option<io::Result<Piece>>>::from_iter((0..ents.len()).map(|_| None)), 0usize));
    let cv = Condvar::new();
    let (next, stop) = (AtomicUsize::new(0), AtomicBool::new(false));
    let stopped = || stop.load(Relaxed);

    let compress = |i: usize| -> io::Result<Piece> {
        let e = &ents[i];
        if e.dir || e.store || (e.len >= SAMPLE_MIN && !worth_compressing(&e.path)?) { return Ok(Piece::Direct); }
        let mut buf = vec![0u8; BUF];
        let mut src = fs::File::open(&e.path).map_err(at(&e.path))?;
        if e.len <= IN_MEMORY {
            let mut w = zip::ZipWriter::new(io::Cursor::new(Vec::with_capacity(e.len as usize / 2 + 1024)));
            w.start_file(&e.name, opts(false, e.time)).map_err(zip_err)?;
            pump(&mut src, &mut w, &mut buf, &stopped, &mut |_| {})?;
            Ok(Piece::Mem(w.finish().map_err(zip_err)?.into_inner()))
        } else {
            let t = parts.join(format!("{i}.zip"));
            let mut w = zip::ZipWriter::new(io::BufWriter::with_capacity(BUF, fs::File::create(&t).map_err(at(&t))?));
            w.start_file(&e.name, opts(false, e.time)).map_err(zip_err)?;
            pump(&mut src, &mut w, &mut buf, &stopped, &mut |_| {})?;
            w.finish().map_err(zip_err)?.flush()?;
            Ok(Piece::Tmp(t))
        }
    };

    let r = std::thread::scope(|s| -> io::Result<()> {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Relaxed);
                if i >= ents.len() || stopped() { break; }
                {
                    let mut g = state.lock().unwrap();
                    while i >= g.1 + window && !stopped() { g = cv.wait(g).unwrap(); }
                }
                let r = compress(i);
                state.lock().unwrap().0[i] = Some(r);
                cv.notify_all();
            });
        }
        let main = (|| -> io::Result<()> {
            let mut z = zip::ZipWriter::new(io::BufWriter::with_capacity(BUF, file));
            let mut buf = vec![0u8; BUF];
            for (i, e) in ents.iter().enumerate() {
                let piece = {
                    let mut g = state.lock().unwrap();
                    loop {
                        if let Some(p) = g.0[i].take() { g.1 = i + 1; break p; }
                        if sink.cancelled() { return Err(cancelled()); }
                        g = cv.wait_timeout(g, std::time::Duration::from_millis(100)).unwrap().0;
                    }
                };
                cv.notify_all();
                if sink.cancelled() { return Err(cancelled()); }
                match piece? {
                    Piece::Direct if e.dir => z.add_directory(format!("{}/", e.name), opts(true, e.time)).map_err(zip_err)?,
                    Piece::Direct => {
                        sink.item(&e.path);
                        z.start_file(&e.name, opts(true, e.time)).map_err(zip_err)?;
                        let mut src = fs::File::open(&e.path).map_err(at(&e.path))?;
                        let cancel = || sink.cancelled();
                        let mut done = 0;
                        pump(&mut src, &mut z, &mut buf, &cancel, &mut |n| done += n)?;
                        sink.bytes(done);
                    }
                    Piece::Mem(v) => {
                        let mut a = zip::ZipArchive::new(io::Cursor::new(v)).map_err(zip_err)?;
                        z.raw_copy_file(a.by_index_raw(0).map_err(zip_err)?).map_err(zip_err)?;
                        sink.item(&e.path);
                        sink.bytes(e.len);
                    }
                    Piece::Tmp(t) => {
                        {
                            let mut a = zip::ZipArchive::new(io::BufReader::with_capacity(BUF, fs::File::open(&t)?)).map_err(zip_err)?;
                            z.raw_copy_file(a.by_index_raw(0).map_err(zip_err)?).map_err(zip_err)?;
                        }
                        let _ = fs::remove_file(&t);
                        sink.item(&e.path);
                        sink.bytes(e.len);
                    }
                }
            }
            z.finish().map_err(zip_err)?.flush()
        })();
        stop.store(true, Relaxed); // also releases workers if we failed
        cv.notify_all();
        main
    });
    let _ = fs::remove_dir_all(&parts);
    r
}

/// Suffix of archives still being written; listings hide these.
pub const PARTIAL: &str = ".delta-partial";

/// Writes an archive under a hidden ".<name>.delta-partial" next to `target`, and gives it its real
/// name only once `write` succeeded, so nobody opens a half-written archive. Never overwrites: if
/// `target` was taken meanwhile, the result gets a free " (n)" name. On failure only the temp file is removed.
pub fn write_then_rename(target: &Path, write: impl FnOnce(fs::File) -> io::Result<()>) -> io::Result<PathBuf> {
    use std::os::windows::fs::OpenOptionsExt;
    if target.exists() { return Err(at(target)(io::Error::from(io::ErrorKind::AlreadyExists))); }
    let parent = target.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let name = target.file_name().ok_or_else(|| io::Error::other("bad path"))?.to_string_lossy().into_owned();
    let tmp = free_name(parent, &format!(".{name}{PARTIAL}"));
    let file = fs::OpenOptions::new().write(true).create_new(true).attributes(0x2 /* hidden */).open(&tmp).map_err(at(&tmp))?;
    let r = write(file).and_then(|()| {
        let dest = if target.exists() { free_name(parent, &name) } else { target.to_path_buf() };
        // A hard link can't replace an existing file (rename would); fall back where links aren't supported (FAT, some shares).
        match fs::hard_link(&tmp, &dest) {
            Ok(()) => { let _ = fs::remove_file(&tmp); }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(e),
            Err(_) => fs::rename(&tmp, &dest)?,
        }
        unhide(&dest); // the temp file was hidden; the archive itself shouldn't be
        Ok(dest)
    });
    if r.is_err() { let _ = fs::remove_file(&tmp); }
    r
}
fn unhide(p: &Path) { hidden(p, false) }
fn set_hidden(p: &Path) { hidden(p, true) }
fn hidden(p: &Path, on: bool) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileAttributesW(p: *const u16) -> u32;
        fn SetFileAttributesW(p: *const u16, a: u32) -> i32;
    }
    let w: Vec<u16> = p.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: `w` is a NUL-terminated wide string that outlives both calls.
    unsafe {
        let a = GetFileAttributesW(w.as_ptr());
        if a != u32::MAX && (a & 0x2 != 0) != on { SetFileAttributesW(w.as_ptr(), a ^ 0x2); }
    }
}

/// Creates `target` (never overwrites) from folders. `level` 0 = store … 9 = smallest. A password
/// encrypts with AES-256 (zip and 7z only). Written via a hidden temp file (see `write_then_rename`).
pub fn create(items: &[PathBuf], target: &Path, format: Format, level: u32, password: Option<&str>, sink: &mut dyn Sink) -> io::Result<PathBuf> {
    only_folders(items)?;
    let level = level.min(9);
    let password = password.filter(|p| !p.is_empty());
    if password.is_some() && format == Format::TarGz { return Err(io::Error::new(io::ErrorKind::InvalidInput, "tar.gz can't have a password; use zip or 7z")); }
    let r = write_then_rename(target, |file| {
        match format {
            Format::Zip => fast_zip(items, target, file, level, password, sink),
            Format::SevenZ => {
                use sevenz_rust2::{encoder_options::{AesEncoderOptions, Lzma2Options}, ArchiveEntry, ArchiveWriter, EncoderMethod, Password};
                let mut w = ArchiveWriter::new(io::BufWriter::with_capacity(BUF, file)).map_err(sz_err)?;
                let methods = |store: bool| {
                    let mut v = Vec::new();
                    if let Some(pw) = password { v.push(AesEncoderOptions::new(Password::new(pw)).into()); }
                    v.push(if store || level == 0 { EncoderMethod::COPY.into() } else { Lzma2Options::from_level(level).into() });
                    v
                };
                let mut stored = None;
                walk(items, &mut |name, p, m| {
                    if m.is_dir() { return w.push_archive_entry::<fs::File>(ArchiveEntry::from_path(p, name.into()), None).map(|_| ()).map_err(sz_err); }
                    // Each 7z entry is its own stream here, so already-compressed files can simply be stored.
                    let store = already_compressed(name) || (m.len() >= SAMPLE_MIN && !worth_compressing(p).unwrap_or(true));
                    if stored != Some(store) { w.set_content_methods(methods(store)); stored = Some(store); }
                    sink.item(p);
                    let r = Progress { r: io::BufReader::with_capacity(BUF, fs::File::open(p).map_err(at(p))?), sink: &mut *sink };
                    w.push_archive_entry(ArchiveEntry::from_path(p, name.into()), Some(r)).map(|_| ()).map_err(sz_err)
                })?;
                w.finish()?.flush()
            }
            Format::TarGz => {
                // shortcut: one gzip stream can't store some files and compress others, nor use several cores; zip is the fast format.
                let gz = flate2::write::GzEncoder::new(io::BufWriter::with_capacity(BUF, file), flate2::Compression::new(level));
                let mut b = tar::Builder::new(gz);
                walk(items, &mut |name, p, m| {
                    if m.is_dir() { return b.append_dir(name, p); }
                    sink.item(p);
                    let f = fs::File::open(p).map_err(at(p))?;
                    let mut h = tar::Header::new_gnu();
                    h.set_metadata(&f.metadata()?);
                    b.append_data(&mut h, name, Progress { r: io::BufReader::with_capacity(BUF, f), sink: &mut *sink })
                })?;
                b.into_inner()?.finish()?.flush()
            }
        }
    });
    r.map_err(|e| if sink.cancelled() { cancelled() } else { e })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::zip_items;

    #[derive(Default)]
    struct T { bytes: u64 }
    impl Sink for T {
        fn bytes(&mut self, n: u64) { self.bytes += n; }
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { false }
    }
    struct Stop;
    impl Sink for Stop {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { true }
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join("DeltaAgent-storage").join(format!("arc-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src/sub")).unwrap();
        fs::write(d.join("src/a.txt"), b"hello").unwrap();
        fs::write(d.join("src/sub/b.txt"), b"world!").unwrap();
        d
    }

    #[test]
    fn names_and_safety() {
        assert_eq!(split_name(Path::new(r"C:\x\Pics.TAR.GZ")), Some(("Pics".into(), Kind::Tar(Comp::Gz))));
        assert_eq!(split_name(Path::new("notes.txt.gz")), Some(("notes.txt".into(), Kind::Single(Comp::Gz))));
        assert_eq!(split_name(Path::new(".zip")), None);
        assert_eq!(safe_rel("a/./b\\c"), Some(PathBuf::from(r"a\b\c")));
        assert_eq!(safe_rel("/etc/passwd"), Some(PathBuf::from(r"etc\passwd")));
        for bad in ["../x", "a/../../x", "C:/Windows/x", "a/b:stream", "nul", "dir/COM1.txt", "a\u{1}b"] {
            assert_eq!(safe_rel(bad), None, "{bad}");
        }
    }

    #[test]
    fn children_synthesizes_folders() {
        let items = vec![
            Item { path: "top/a.txt".into(), is_dir: false, size: 5, modified: 1 },
            Item { path: "top/deep/b.txt".into(), is_dir: false, size: 6, modified: 2 },
            Item { path: "c.txt".into(), is_dir: false, size: 7, modified: 3 },
        ];
        let root = children(&items, "");
        assert_eq!(root.iter().map(|i| (i.path.as_str(), i.is_dir)).collect::<Vec<_>>(), [("top", true), ("c.txt", false)]);
        let top = children(&items, "top/");
        assert_eq!(top.iter().map(|i| (i.path.as_str(), i.is_dir, i.size)).collect::<Vec<_>>(), [("top/a.txt", false, 5), ("top/deep", true, 0)]);
    }

    #[test]
    fn zip_rejects_traversal_and_cleans_up() {
        let d = tmp("evil");
        let z = d.join("evil.zip");
        let mut w = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        w.start_file("ok.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        w.start_file("../../escaped.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
        assert!(extract(&z, &mut T::default()).is_err());
        assert!(!d.join("evil").exists(), "the half-extracted folder is removed");
        assert!(!d.parent().unwrap().join("escaped.txt").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn tar_links_are_never_created() {
        let d = tmp("link");
        let t = d.join("l.tar");
        let mut b = tar::Builder::new(fs::File::create(&t).unwrap());
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        b.append_link(&mut h, "pkg/link", r"C:\Windows").unwrap();
        let mut h = tar::Header::new_gnu();
        h.set_size(2);
        b.append_data(&mut h, "pkg/f.txt", &b"hi"[..]).unwrap();
        b.into_inner().unwrap();
        let x = extract(&t, &mut T::default()).unwrap();
        assert_eq!(x, d.join("l"), "single top folder is lifted");
        assert_eq!(fs::read(x.join("f.txt")).unwrap(), b"hi");
        assert!(fs::symlink_metadata(x.join("link")).is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn create_and_extract_every_format() {
        let d = tmp("round");
        for f in [Format::Zip, Format::SevenZ, Format::TarGz] {
            let target = d.join(format!("src.{}", f.ext()));
            create(&[d.join("src")], &target, f, 5, None, &mut T::default()).unwrap();
            let listed = list(&target).unwrap();
            assert!(listed.iter().any(|i| i.path == "src/sub/b.txt" && i.size == 6), "{f:?}: {listed:?}");
            let mut t = T::default();
            let x = extract(&target, &mut t).unwrap();
            assert_eq!(fs::read(x.join("sub/b.txt")).unwrap(), b"world!", "{f:?}");
            assert!(t.bytes > 0);
            fs::remove_dir_all(&x).unwrap();
            // Just one file, out on its own next to where we asked.
            let one = extract_selected(&target, &["src/sub/b.txt".into()], &d, &mut T::default()).unwrap();
            assert_eq!(one, d.join("b.txt"));
            fs::remove_file(one).unwrap();
            let here = extract_here(&target, &mut T::default()).unwrap();
            assert_eq!(here, [d.join("src (2)")], "clash gets a free name");
            assert_eq!(fs::read(here[0].join("a.txt")).unwrap(), b"hello");
            fs::remove_dir_all(&here[0]).unwrap();
        }
        assert!(fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(PARTIAL)), "no temp leftovers");
        // Fast zip: already-compressed and incompressible files are stored, text is deflated; all round-trip.
        let mix = d.join("mix");
        fs::create_dir_all(&mix).unwrap();
        let mut noise = vec![0u8; 300_000];
        let mut x = 12345u32;
        for b in noise.iter_mut() { x ^= x << 13; x ^= x >> 17; x ^= x << 5; *b = x as u8; }
        fs::write(mix.join("noise.bin"), &noise).unwrap();
        fs::write(mix.join("photo.jpg"), b"pretend jpeg").unwrap();
        fs::write(mix.join("big.txt"), "lorem ipsum ".repeat(600_000)).unwrap(); // > IN_MEMORY: goes through a temp piece
        for i in 0..50 { fs::write(mix.join(format!("t{i}.txt")), format!("line {i}\n").repeat(100)).unwrap(); }
        let z = create(&[mix.clone()], &d.join("mix.zip"), Format::Zip, 1, None, &mut T::default()).unwrap();
        let mut a = zip::ZipArchive::new(fs::File::open(&z).unwrap()).unwrap();
        assert_eq!(a.by_name("mix/noise.bin").unwrap().compression(), zip::CompressionMethod::Stored);
        assert_eq!(a.by_name("mix/photo.jpg").unwrap().compression(), zip::CompressionMethod::Stored);
        assert_eq!(a.by_name("mix/big.txt").unwrap().compression(), zip::CompressionMethod::Deflated);
        assert_eq!(a.len(), 54);
        drop(a);
        let x = extract(&z, &mut T::default()).unwrap();
        assert_eq!(fs::read(x.join("noise.bin")).unwrap(), noise);
        assert_eq!(fs::read_to_string(x.join("t7.txt")).unwrap(), "line 7\n".repeat(100));
        assert_eq!(fs::read(x.join("big.txt")).unwrap().len(), 12 * 600_000);
        // Passwords: 7z and zip encrypt; Delta then refuses politely instead of writing garbage.
        let p = d.join("secret.7z");
        create(&[d.join("src")], &p, Format::SevenZ, 1, Some("pw"), &mut T::default()).unwrap();
        let e = extract(&p, &mut T::default()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{e}");
        let p = d.join("secret.zip");
        create(&[d.join("src")], &p, Format::Zip, 9, Some("pw"), &mut T::default()).unwrap();
        assert_eq!(extract(&p, &mut T::default()).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert!(!d.join("secret").exists());
        // Files are refused; a cancel leaves nothing behind.
        assert!(create(&[d.join("src/a.txt")], &d.join("f.zip"), Format::Zip, 5, None, &mut T::default()).is_err());
        assert!(!d.join("f.zip").exists());
        let e = create(&[d.join("src")], &d.join("c.7z"), Format::SevenZ, 5, None, &mut Stop).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!d.join("c.7z").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn single_gz_and_virtual_paths() {
        let d = tmp("gz");
        let g = d.join("notes.txt.gz");
        let mut e = flate2::write::GzEncoder::new(fs::File::create(&g).unwrap(), flate2::Compression::default());
        e.write_all(b"abc").unwrap();
        e.finish().unwrap();
        assert_eq!(list(&g).unwrap()[0].path, "notes.txt");
        let x = extract(&g, &mut T::default()).unwrap();
        assert_eq!(x, d.join("notes.txt"));
        assert_eq!(fs::read(&x).unwrap(), b"abc");
        let v = virtual_path(&g.to_string_lossy(), "notes.txt");
        assert_eq!(parse_virtual(&v), Some((g.clone(), "notes.txt".into())));
        let got = materialize(&[PathBuf::from(&v)], &d.join("tmp"), &mut T::default()).unwrap();
        assert_eq!(fs::read(&got[0]).unwrap(), b"abc");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn archives_appear_only_when_complete() {
        use std::os::windows::fs::MetadataExt;
        let d = tmp("partial");
        let target = d.join("Name.zip");
        let made = write_then_rename(&target, |mut f| {
            assert!(!target.exists(), "final name doesn't exist while writing");
            let tmp = d.join(format!(".Name.zip{PARTIAL}"));
            assert!(fs::metadata(&tmp).unwrap().file_attributes() & 0x2 != 0, "temp file is hidden");
            assert!(crate::list_dir(&d).unwrap().iter().all(|e| !e.name.ends_with(PARTIAL)), "listings skip it");
            f.write_all(b"data")
        }).unwrap();
        assert_eq!(made, target);
        assert_eq!(fs::read(&target).unwrap(), b"data");
        assert_eq!(fs::metadata(&target).unwrap().file_attributes() & 0x2, 0, "result is not hidden");
        // Someone took the name meanwhile: never overwritten, we get "Name (2).zip".
        let other = d.join("Other.zip");
        let made = write_then_rename(&other, |_| fs::write(&other, b"theirs")).unwrap();
        assert_eq!(made, d.join("Other (2).zip"));
        assert_eq!(fs::read(&other).unwrap(), b"theirs");
        // Failure: only the temp file goes.
        assert!(write_then_rename(&d.join("Bad.zip"), |_| Err(io::Error::other("boom"))).is_err());
        let left: Vec<_> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains("Bad")).collect();
        assert!(left.is_empty(), "{left:?}");
        assert!(write_then_rename(&target, |_| Ok(())).is_err(), "existing target refused up front");
        fs::remove_dir_all(&d).unwrap();
    }

    /// cargo test -p de-core --release --lib bench_zip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_zip() {
        let d = std::env::temp_dir().join("DeltaAgent-storage").join("bench");
        let src = d.join("Game");
        if !src.join("data.pck").exists() {
            fs::create_dir_all(src.join("text")).unwrap();
            let mut f = io::BufWriter::new(fs::File::create(src.join("data.pck")).unwrap());
            let mut x = 0x9e37_79b9_7f4a_7c15u64;
            let mut chunk = vec![0u8; 1 << 20];
            for _ in 0..1536 {
                for c in chunk.chunks_mut(8) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; c.copy_from_slice(&x.to_le_bytes()); }
                f.write_all(&chunk).unwrap();
            }
            for i in 0..5000 { fs::write(src.join(format!("text/file{i}.txt")), format!("Some config line number {i} with words\n").repeat(40)).unwrap(); }
        }
        let time = |label: &str, f: &dyn Fn(&Path) -> PathBuf| {
            let t = d.join(format!("{label}.zip"));
            let _ = fs::remove_file(&t);
            let s = std::time::Instant::now();
            let out = f(&t);
            println!("{label}: {:.1}s, {} MB", s.elapsed().as_secs_f64(), fs::metadata(&out).unwrap().len() >> 20);
            fs::remove_file(out).unwrap();
        };
        time("before (sequential deflate 6)", &|t| zip_items(&[src.clone()], t, &mut T::default()).unwrap());
        for (name, level) in [("fast", 1), ("balanced", 6), ("smallest", 9)] {
            time(name, &|t| create(&[src.clone()], t, Format::Zip, level, None, &mut T::default()).unwrap());
        }
    }

    #[test]
    fn zip_times_survive() {
        let d = tmp("time");
        let z = zip_items(&[d.join("src")], &d.join("t.zip"), &mut T::default()).unwrap();
        let mut a = zip::ZipArchive::new(fs::File::open(&z).unwrap()).unwrap();
        let e = a.by_name("src/a.txt").unwrap();
        assert!(e.last_modified().unwrap().year() >= 2024, "not the 1980 default");
        assert_eq!(unix_to_civil(civil_to_unix(2026, 2, 28, 13, 5, 7)), (2026, 2, 28, 13, 5, 7));
        assert_eq!(zip_time(UNIX_EPOCH).year(), 1980, "clamped");
        fs::remove_dir_all(&d).unwrap();
    }
}
