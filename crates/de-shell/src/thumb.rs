//! Thumbnails and real file icons from the Windows shell (IShellItemImageFactory), encoded as PNG.
//! Uses the same providers and thumbnail cache as File Explorer, so photos, videos, PDFs and exe icons all work.
use std::path::Path;
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ},
        System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, SIIGBF_THUMBNAILONLY},
    },
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    /// Content preview only (photos, videos, PDFs); fails for files without one.
    Thumbnail,
    /// The file's real icon (app icons for .exe/.lnk, associated app icon otherwise).
    Icon,
}

/// Returns PNG bytes, longest side <= `size`.
pub fn image(path: &Path, size: u32, kind: Kind) -> Result<Vec<u8>, String> {
    // The shell wants an STA. Re-initializing a thread that already has COM is harmless (S_FALSE).
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let wide: Vec<u16> = path.as_os_str().encode_wide_nul();
    let (w, h, rgba) = unsafe {
        let f: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).map_err(|e| e.to_string())?;
        let flags = match kind { Kind::Thumbnail => SIIGBF_THUMBNAILONLY, Kind::Icon => SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK };
        let s = size as i32;
        let hbm = f.GetImage(SIZE { cx: s, cy: s }, flags).map_err(|e| e.to_string())?;
        let r = read_bitmap(hbm.into(), kind);
        let _ = DeleteObject(hbm.into());
        r?
    };
    let (w, h, rgba) = if kind == Kind::Icon { unframe(w, h, rgba) } else { (w, h, rgba) };
    encode_png(w, h, &rgba)
}

/// Apps that only ship small icons come back drawn inside a faint 1px translucent frame at large sizes
/// (Windows' "small icon in a big slot" look). Detect that frame and crop to the real icon inside it.
fn unframe(w: u32, h: u32, px: Vec<u8>) -> (u32, u32, Vec<u8>) {
    let a = |x: u32, y: u32| px[((y * w + x) * 4 + 3) as usize];
    let ring: Vec<u8> = (0..w).flat_map(|x| [a(x, 0), a(x, h - 1)]).chain((0..h).flat_map(|y| [a(0, y), a(w - 1, y)])).collect();
    let faint = ring.iter().filter(|&&v| v > 0 && v < 90).count();
    if w < 24 || faint * 10 < ring.len() * 6 {
        return (w, h, px); // no frame: a normal icon
    }
    // Bounding box of solid pixels inside the frame.
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 3..h - 3 {
        for x in 3..w - 3 {
            if a(x, y) > 90 { x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y); }
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return (w, h, px);
    }
    // Square crop centred on the content, so the icon keeps its proportions.
    let side = (x1 - x0 + 1).max(y1 - y0 + 1);
    let sx = x0.saturating_sub((side - (x1 - x0 + 1)) / 2).min(w - side);
    let sy = y0.saturating_sub((side - (y1 - y0 + 1)) / 2).min(h - side);
    let mut out = Vec::with_capacity((side * side * 4) as usize);
    for y in sy..sy + side {
        let start = ((y * w + sx) * 4) as usize;
        out.extend_from_slice(&px[start..start + (side * 4) as usize]);
    }
    (side, side, out)
}

trait WideNul { fn encode_wide_nul(&self) -> Vec<u16>; }
impl WideNul for std::ffi::OsStr {
    fn encode_wide_nul(&self) -> Vec<u16> { std::os::windows::ffi::OsStrExt::encode_wide(self).chain([0]).collect() }
}

/// Copies a 32-bit HBITMAP out as straight (non-premultiplied) RGBA, top row first.
unsafe fn read_bitmap(obj: HGDIOBJ, kind: Kind) -> Result<(u32, u32, Vec<u8>), String> {
    let mut bm = BITMAP::default();
    if GetObjectW(obj, size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as _)) == 0 {
        return Err("bad bitmap".into());
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // negative = top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let dc = CreateCompatibleDC(None);
    let lines = GetDIBits(dc, windows::Win32::Graphics::Gdi::HBITMAP(obj.0), 0, h as u32, Some(px.as_mut_ptr() as _), &mut info, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    if lines == 0 {
        return Err("GetDIBits failed".into());
    }
    Ok((w as u32, h as u32, bgra_to_rgba(px, kind)))
}

/// Shell bitmaps are BGRA, premultiplied. With alpha 0 everywhere there was no alpha channel at all:
/// photos (JPEG) are then simply opaque, while legacy icons use black for their masked-out background.
fn bgra_to_rgba(mut px: Vec<u8>, kind: Kind) -> Vec<u8> {
    let no_alpha = px.as_chunks::<4>().0.iter().all(|p| p[3] == 0);
    for p in px.as_chunks_mut::<4>().0 {
        p.swap(0, 2);
        if no_alpha {
            // shortcut: pure-black icon pixels become transparent; exact for the mask, wrong only for true #000 artwork inside old icons.
            p[3] = if kind == Kind::Icon && p[..3] == [0, 0, 0] { 0 } else { 255 };
        } else if p[3] > 0 && p[3] < 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    px
}

pub(crate) fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast); // generated on demand; speed beats size
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(rgba).map_err(|e| e.to_string())?;
    wr.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_conversion() {
        // all-zero alpha (JPEG thumb) -> opaque, channels swapped
        assert_eq!(bgra_to_rgba(vec![1, 2, 3, 0, 0, 0, 0, 0], Kind::Thumbnail), vec![3, 2, 1, 255, 0, 0, 0, 255]);
        // legacy icon: black background becomes transparent, colours stay opaque
        assert_eq!(bgra_to_rgba(vec![1, 2, 3, 0, 0, 0, 0, 0], Kind::Icon), vec![3, 2, 1, 255, 0, 0, 0, 0]);
        // premultiplied half-alpha white -> straight white
        assert_eq!(bgra_to_rgba(vec![128, 128, 128, 128, 0, 0, 0, 255], Kind::Icon), vec![255, 255, 255, 128, 0, 0, 0, 255]);
    }

    #[test]
    fn strips_small_icon_frame() {
        // 32x32: faint 1px ring, solid 8x8 square in the middle.
        let (w, h) = (32u32, 32u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h { for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            if x == 0 || y == 0 || x == w - 1 || y == h - 1 { px[i..i + 4].copy_from_slice(&[255, 255, 255, 40]); }
            if (12..20).contains(&x) && (12..20).contains(&y) { px[i..i + 4].copy_from_slice(&[200, 0, 0, 255]); }
        }}
        let (cw, ch, out) = unframe(w, h, px);
        assert_eq!((cw, ch), (8, 8));
        assert!(out.chunks(4).all(|p| p[3] == 255));
        // A normal icon (no ring) is untouched.
        let plain = vec![0u8; (w * h * 4) as usize];
        assert_eq!(unframe(w, h, plain).0, 32);
    }

    #[test]
    fn icon_of_notepad_is_a_png() {
        let exe = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("notepad.exe");
        let p = image(&exe, 48, Kind::Icon).expect("notepad has an icon");
        assert_eq!(&p[1..4], b"PNG");
    }
}
