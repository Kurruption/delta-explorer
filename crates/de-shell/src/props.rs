//! File properties Windows already knows (the same property handlers File Explorer's Details columns use):
//! picture/video dimensions and audio/video duration, for any format with a handler installed.
use serde::Serialize;
use std::path::Path;
use windows::{
    core::{GUID, PCWSTR},
    Win32::{
        Foundation::PROPERTYKEY,
        Storage::FileSystem::GetDiskFreeSpaceExW,
        System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        UI::Shell::{IShellItem2, SHCreateItemFromParsingName},
    },
};

// From propkey.h (kept here so de-shell needs no extra `windows` features).
const IMAGE_W: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x6444048f_4c8b_11d1_8b70_080036b11a03), pid: 3 };
const IMAGE_H: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x6444048f_4c8b_11d1_8b70_080036b11a03), pid: 4 };
const VIDEO_W: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x64440491_4c8b_11d1_8b70_080036b11a03), pid: 3 };
const VIDEO_H: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x64440491_4c8b_11d1_8b70_080036b11a03), pid: 4 };
/// 100 ns units.
const DURATION: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x64440490_4c8b_11d1_8b70_080036b11a03), pid: 3 };

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    /// 0 when unknown (not a picture/video, or no handler).
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
}

/// Dimensions and duration of one file; all zero if Windows has none.
pub fn media(path: &Path) -> Media {
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let w = crate::wide(path);
    let item: windows::core::Result<IShellItem2> = unsafe { SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None) };
    let Ok(item) = item else { return Media::default() };
    let u32_of = |k: &PROPERTYKEY| unsafe { item.GetUInt32(k) }.unwrap_or(0);
    let (mut width, mut height) = (u32_of(&IMAGE_W), u32_of(&IMAGE_H));
    if width == 0 {
        (width, height) = (u32_of(&VIDEO_W), u32_of(&VIDEO_H));
    }
    let duration_ms = unsafe { item.GetUInt64(&DURATION) }.unwrap_or(0) / 10_000;
    Media { width, height, duration_ms }
}

/// Free bytes on the volume holding `path` (works for folders, drive roots and network shares).
pub fn free_space(path: &Path) -> Option<u64> {
    let w = crate::wide(path);
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

#[cfg(test)]
mod tests {
    #[test]
    fn free_space_of_temp() {
        assert!(super::free_space(&std::env::temp_dir()).is_some_and(|f| f > 0));
        assert_eq!(super::media(&std::env::temp_dir().join("does-not-exist.png")), super::Media::default());
        // Files every Windows install ships.
        let wav = std::path::Path::new(r"C:\Windows\Media\chimes.wav");
        if wav.exists() { assert!(super::media(wav).duration_ms > 0); }
        let jpg = std::path::Path::new(r"C:\Windows\Web\Wallpaper\Windows\img0.jpg");
        if jpg.exists() { assert!(super::media(jpg).width > 0); }
    }
}
