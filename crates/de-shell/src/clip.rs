//! The Windows file clipboard (what Explorer's Copy/Cut/Paste use), so files copied in Explorer paste in
//! Delta and the other way round. Also: resolving shortcuts (.lnk) and typed paths ("%USERPROFILE%").
use std::{
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::{HANDLE, HGLOBAL},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ},
            DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData},
            Environment::ExpandEnvironmentStringsW,
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_HDROP,
        },
        UI::Shell::{DragQueryFileW, IShellLinkW, ShellLink, DROPFILES, HDROP},
    },
};

const DROPEFFECT_MOVE: u32 = 2;

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
}

/// Opens the clipboard, retrying briefly: another app may be holding it for a moment.
fn open() -> Result<Guard, String> {
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(Guard);
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    Err("the clipboard is busy (another app is using it)".into())
}
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) { let _ = unsafe { CloseClipboard() }; }
}

fn effect_format() -> u32 {
    let name = wide("Preferred DropEffect");
    unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) }
}

/// Files on the clipboard and whether they were cut (Explorer's Ctrl+X). None if it holds no files.
pub fn read_files() -> Result<Option<(Vec<PathBuf>, bool)>, String> {
    if unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32) }.is_err() {
        return Ok(None);
    }
    let _g = open()?;
    unsafe {
        let h = GetClipboardData(CF_HDROP.0 as u32).map_err(|e| e.to_string())?;
        let drop = HDROP(h.0);
        let n = DragQueryFileW(drop, u32::MAX, None);
        let mut files = Vec::new();
        for i in 0..n {
            let len = DragQueryFileW(drop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(drop, i, Some(&mut buf));
            files.push(PathBuf::from(std::ffi::OsString::from_wide(&buf[..len])));
        }
        let mut cut = false;
        if let Ok(e) = GetClipboardData(effect_format()) {
            let p = GlobalLock(HGLOBAL(e.0)) as *const u32;
            if !p.is_null() {
                cut = *p & DROPEFFECT_MOVE != 0;
                let _ = GlobalUnlock(HGLOBAL(e.0));
            }
        }
        Ok(Some((files, cut)))
    }
}

fn global(bytes: &[u8]) -> Result<HGLOBAL, String> {
    unsafe {
        let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() { return Err("out of memory".into()); }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len().min(GlobalSize(g)));
        let _ = GlobalUnlock(g);
        Ok(g)
    }
}

/// Puts files on the clipboard the way Explorer does (CF_HDROP + Preferred DropEffect), so Explorer,
/// Discord, mail apps... can paste them.
pub fn write_files(paths: &[PathBuf], cut: bool) -> Result<(), String> {
    // DROPFILES header, then each path NUL-terminated, then a final NUL (all UTF-16).
    let mut list: Vec<u16> = Vec::new();
    for p in paths { list.extend(p.as_os_str().encode_wide()); list.push(0); }
    list.push(0);
    let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, fWide: true.into(), ..Default::default() };
    let mut bytes = unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, size_of::<DROPFILES>()) }.to_vec();
    bytes.extend(list.iter().flat_map(|c| c.to_le_bytes()));
    let effect: u32 = if cut { DROPEFFECT_MOVE } else { 1 | 4 }; // move, or copy | link
    let _g = open()?;
    unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        // After a successful SetClipboardData the system owns the memory.
        SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(global(&bytes)?.0))).map_err(|e| e.to_string())?;
        SetClipboardData(effect_format(), Some(HANDLE(global(&effect.to_le_bytes())?.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
fn png_format() -> u32 {
    let name = wide("PNG");
    unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) }
}
fn available(f: u32) -> bool { unsafe { IsClipboardFormatAvailable(f) }.is_ok() }

/// Text or a picture is on the clipboard (what "Paste as a new file" can use).
pub fn has_text_or_image() -> bool { available(CF_UNICODETEXT) || available(CF_DIB) || available(png_format()) }

/// Copies one clipboard format's bytes out (the clipboard must be open).
unsafe fn bytes_of(format: u32) -> Option<Vec<u8>> {
    let h = GetClipboardData(format).ok()?;
    let g = HGLOBAL(h.0);
    let p = GlobalLock(g) as *const u8;
    if p.is_null() { return None; }
    let v = std::slice::from_raw_parts(p, GlobalSize(g)).to_vec();
    let _ = GlobalUnlock(g);
    Some(v)
}

pub enum Pasted { Text(String), Png(Vec<u8>) }

/// What "Paste as a new file" writes: text first (copying from Word or Excel also puts a picture of it
/// on the clipboard), else a picture as PNG (apps' own "PNG" format, or the classic bitmap converted).
pub fn read_text_or_image() -> Result<Option<Pasted>, String> {
    let _g = open()?;
    unsafe {
        if available(CF_UNICODETEXT) {
            if let Some(b) = bytes_of(CF_UNICODETEXT) {
                let w: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
                return Ok(Some(Pasted::Text(String::from_utf16_lossy(&w))));
            }
        }
        if let Some(b) = bytes_of(png_format()) { return Ok(Some(Pasted::Png(b))); }
        if let Some(b) = bytes_of(CF_DIB) {
            let (w, h, rgba) = dib_to_rgba(&b).ok_or("this kind of picture can't be pasted as a file")?;
            return Ok(Some(Pasted::Png(crate::thumb::encode_png(w, h, &rgba)?)));
        }
    }
    Ok(None)
}

/// A CF_DIB (BITMAPINFOHEADER + pixels) to top-down RGBA. 24- and 32-bit only (what screenshots use).
fn dib_to_rgba(b: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let u32_at = |i: usize| Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?));
    let header = u32_at(0)? as usize;
    let w = u32_at(4)? as i32;
    let h = u32_at(8)? as i32;
    let bpp = u16::from_le_bytes(b.get(14..16)?.try_into().ok()?) as usize;
    let compression = u32_at(16)?;
    if w <= 0 || h == 0 || !(bpp == 24 || bpp == 32) || !(compression == 0 || compression == 3) { return None; }
    // BI_BITFIELDS with the small header: three colour masks follow it (assumed the usual BGR order).
    let start = header + if compression == 3 && header == 40 { 12 } else { 0 };
    let (w, rows) = (w as usize, h.unsigned_abs() as usize);
    let stride = (w * bpp).div_ceil(32) * 4;
    let px = b.get(start..start + stride * rows)?;
    let mut out = Vec::with_capacity(w * rows * 4);
    for y in 0..rows {
        let row = if h > 0 { rows - 1 - y } else { y }; // positive height = stored bottom-up
        for x in 0..w {
            let p = &px[row * stride + x * bpp / 8..];
            out.extend([p[2], p[1], p[0], if bpp == 32 { p[3] } else { 255 }]);
        }
    }
    // Many apps leave the alpha byte at 0: that means opaque, not invisible.
    if bpp == 32 && out.chunks_exact(4).all(|c| c[3] == 0) { out.chunks_exact_mut(4).for_each(|c| c[3] = 255); }
    Some((w as u32, rows as u32, out))
}

/// Where a shortcut (.lnk) points, if it can be read.
pub fn resolve_link(lnk: &Path) -> Option<PathBuf> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let w = wide(lnk);
        link.cast::<IPersistFile>().ok()?.Load(PCWSTR(w.as_ptr()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let n = buf.iter().position(|&c| c == 0)?;
        (n > 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
    }
}

/// Expands %VARS% in a typed path ("%USERPROFILE%\Downloads").
pub fn expand_env(s: &str) -> String {
    if !s.contains('%') { return s.into(); }
    let w = wide(s);
    let mut buf = vec![0u16; 2048];
    let n = unsafe { ExpandEnvironmentStringsW(PCWSTR(w.as_ptr()), Some(&mut buf)) } as usize;
    if n == 0 || n > buf.len() { return s.into(); }
    String::from_utf16_lossy(&buf[..n - 1])
}

#[cfg(test)]
mod tests {
    #[test]
    fn env_expands() {
        let home = std::env::var("USERPROFILE").unwrap();
        assert_eq!(super::expand_env(r"%USERPROFILE%\x"), format!(r"{home}\x"));
        assert_eq!(super::expand_env("plain"), "plain");
    }

    #[test]
    fn dib_converts() {
        // 2x2, 24-bit, bottom-up: rows are padded to 8 bytes. Bottom row blue, red; top row green, white.
        let mut b = vec![0u8; 40];
        b[0] = 40; b[4] = 2; b[8] = 2; b[12] = 1; b[14] = 24;
        b.extend([255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0, 0]);
        let (w, h, px) = super::dib_to_rgba(&b).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(px, [0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
        b[14] = 8;
        assert!(super::dib_to_rgba(&b).is_none(), "palette bitmaps are refused, not garbled");
    }
}

#[cfg(test)]
mod clipboard_roundtrip {
    /// Touches the real clipboard, so it only runs when asked: cargo test -p de-shell -- --ignored
    #[test]
    #[ignore]
    fn write_then_read() {
        let a = std::env::temp_dir().join("de clip ü.txt");
        std::fs::write(&a, "x").unwrap();
        super::write_files(&[a.clone()], true).unwrap();
        let (files, cut) = super::read_files().unwrap().unwrap();
        assert_eq!(files, [a]);
        assert!(cut);
    }
}
