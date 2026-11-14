//! Windows shell integration for Delta Explorer. Each feature lands here behind a plain function
//! so the Tauri layer never touches Win32 directly. Planned: native context menu, icons (see docs/ARCHITECTURE.md).
pub mod clip;
pub mod extras;
pub mod native;
pub mod open_with;
pub mod props;
pub mod thumb;

use serde::Serialize;
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW},
        UI::{
            Shell::{SHObjectProperties, ShellExecuteW, SHOP_FILEPATH},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
};

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
}

/// Moves items to the Recycle Bin (undoable by the user from the Bin).
/// shortcut: uses the `trash` crate (IFileOperation underneath); switch to our own IFileOperation call when we need progress UI.
pub fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    trash::delete_all(paths).map_err(|e| e.to_string())
}

/// Opens a file with its default app, exactly like double-clicking it in Explorer.
pub fn open(path: &Path) -> Result<(), String> {
    let w = wide(path);
    // ShellExecute returns a pseudo-HINSTANCE; values <= 32 are errors.
    let r = unsafe { ShellExecuteW(None, PCWSTR::null(), PCWSTR(w.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("couldn't open {} (shell error {})", path.display(), r.0 as isize)) }
}

/// Shows the standard Windows Properties dialog for a file or folder.
pub fn properties(path: &Path) -> Result<(), String> {
    let w = wide(path);
    let ok = unsafe { SHObjectProperties(None, SHOP_FILEPATH, PCWSTR(w.as_ptr()), PCWSTR::null()) };
    if ok.as_bool() { Ok(()) } else { Err(format!("couldn't show properties for {}", path.display())) }
}

/// The user's standard folders where Windows really keeps them (OneDrive backup moves Desktop,
/// Documents and Pictures into OneDrive, so "%USERPROFILE%\Pictures" can be an empty leftover).
pub fn known_folders() -> Vec<(&'static str, PathBuf)> {
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Videos, KF_FLAG_DEFAULT},
    };
    [("Desktop", FOLDERID_Desktop), ("Downloads", FOLDERID_Downloads), ("Documents", FOLDERID_Documents), ("Pictures", FOLDERID_Pictures), ("Music", FOLDERID_Music), ("Videos", FOLDERID_Videos)]
        .into_iter()
        .filter_map(|(name, id)| unsafe {
            let p = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as _));
            Some((name, PathBuf::from(s?)))
        })
        .filter(|(_, p)| p.is_dir())
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub total: u64,
    pub free: u64,
    /// "fixed", "removable", "network", "cdrom" or "other"
    pub kind: &'static str,
}

pub fn drives() -> Vec<Drive> {
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| {
            let path = format!("{}:\\", (b'A' + i) as char);
            let w = wide(&path);
            let kind = match unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) } {
                3 => "fixed",
                2 => "removable",
                4 => "network",
                5 => "cdrom",
                _ => "other",
            };
            let mut name = [0u16; 261];
            let mut label = String::new();
            if unsafe { GetVolumeInformationW(PCWSTR(w.as_ptr()), Some(&mut name), None, None, None, None) }.is_ok() {
                label = String::from_utf16_lossy(&name[..name.iter().position(|&c| c == 0).unwrap_or(0)]);
            }
            let (mut total, mut free) = (0u64, 0u64);
            // Empty card readers / disc drives fail here; they still show, with no usage bar.
            let _ = unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), None, Some(&mut total), Some(&mut free)) };
            if label.is_empty() {
                label = if kind == "fixed" { "Local Disk".into() } else { "Drive".into() };
            }
            Drive { path, label, total, free, kind }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn known_folders_exist() {
        let k = super::known_folders();
        assert!(k.iter().any(|(n, _)| *n == "Documents"), "{k:?}");
    }

    #[test]
    fn system_drive_listed_with_space() {
        let sys = std::env::var("SystemDrive").unwrap_or("C:".into());
        let d = super::drives();
        let c = d.iter().find(|d| d.path.starts_with(&sys)).expect("system drive present");
        assert!(c.total > 0 && c.free <= c.total);
    }
}
