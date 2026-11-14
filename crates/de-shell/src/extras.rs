//! Shell extras: Share sheet, terminals here, Create shortcut, Send to, and starting Delta's elevated helper.
use std::{
    ffi::c_void,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use windows::{
    core::{Interface, HSTRING, PCWSTR},
    ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
    Foundation::TypedEventHandler,
    Storage::{IStorageItem, StorageFile, StorageFolder},
    Win32::{
        Foundation::{CloseHandle, HWND, POINTL},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, IDataObject, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            Ole::{IDropTarget, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_NONE},
            SystemServices::MK_LBUTTON,
            Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        },
        UI::{
            Shell::{
                Common::ITEMIDLIST, IDataTransferManagerInterop, ILFindLastID, IShellFolder, IShellLinkW, SHBindToParent, SHParseDisplayName, ShellExecuteExW,
                ShellLink, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
};

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
}
const CREATE_NEW_CONSOLE: u32 = 0x10;

// ---------------- elevated helper ----------------

/// Starts `exe args` elevated (UAC prompt) and waits for it. Returns its exit code.
/// The prompt is owned by `hwnd` so it comes to the front over Delta.
pub fn run_as_admin(hwnd: isize, exe: &Path, args: &[&str]) -> Result<u32, String> {
    let (file, verb) = (wide(exe), wide("runas"));
    // Each argument quoted; none of ours end in a backslash or contain quotes (checked by the caller).
    let params = wide(args.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" "));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: HWND(hwnd as *mut c_void),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            // ERROR_CANCELLED: the user said No on the UAC prompt.
            return Err(if e.code().0 as u32 == 0x8007_04C7 { "cancelled".into() } else { e.to_string() });
        }
        if info.hProcess.is_invalid() { return Err("the administrator helper didn't start".into()); }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        Ok(code)
    }
}

// ---------------- terminals ----------------

/// "wt" = Windows Terminal (falls back to PowerShell if it isn't installed), "powershell", or "cmd".
pub fn open_terminal(dir: &Path, kind: &str) -> Result<(), String> {
    if !dir.is_dir() { return Err(format!("{} is not a folder", dir.display())); }
    let console = |exe: &str, args: &[&str]| Command::new(exe).args(args).current_dir(dir).creation_flags(CREATE_NEW_CONSOLE).spawn().map(|_| ());
    let ps = || console("pwsh.exe", &["-NoExit"]).or_else(|_| console("powershell.exe", &["-NoExit"]));
    let d = dir.to_string_lossy();
    let r = match kind {
        // wt reads ";" as "next command", so it's escaped.
        "wt" => Command::new("wt.exe").args(["-d", &d.replace(';', "\\;")]).spawn().map(|_| ()).or_else(|_| ps()),
        "powershell" => ps(),
        // cmd can't start in a network folder; pushd maps it to a temporary drive letter.
        "cmd" if d.starts_with(r"\\") => console("cmd.exe", &["/K", "pushd", &d]),
        "cmd" => console("cmd.exe", &["/K"]),
        _ => return Err(format!("unknown terminal {kind}")),
    };
    r.map_err(|e| format!("couldn't open a terminal: {e}"))
}

// ---------------- shortcuts ----------------

/// Creates "<name> - Shortcut.lnk" next to `target` (like Explorer). Returns the shortcut's path.
pub fn create_shortcut(target: &Path) -> Result<PathBuf, String> {
    let dir = target.parent().ok_or("can't make a shortcut to a drive here")?;
    let name = target.file_name().ok_or("bad path")?.to_string_lossy();
    let lnk = de_core_free_name(dir, &format!("{name} - Shortcut.lnk"));
    let e = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(e)?;
        let (t, wd, out) = (wide(target), wide(dir), wide(&lnk));
        link.SetPath(PCWSTR(t.as_ptr())).map_err(e)?;
        link.SetWorkingDirectory(PCWSTR(wd.as_ptr())).map_err(e)?;
        link.cast::<IPersistFile>().map_err(e)?.Save(PCWSTR(out.as_ptr()), true).map_err(|err| format!("{}: {err}", lnk.display()))?;
    }
    Ok(lnk)
}

/// "name (2).ext" when taken (same rule as de_core::ops::free_name; de-shell doesn't depend on de-core).
fn de_core_free_name(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() { return p; }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (2..).map(|i| dir.join(if ext.is_empty() { format!("{stem} ({i})") } else { format!("{stem} ({i}).{ext}") })).find(|p| !p.exists()).unwrap()
}

// ---------------- Send to ----------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTarget {
    pub name: String,
    pub path: String,
}

/// What's in the user's SendTo folder (Compressed folder, Desktop, Documents, Mail, shortcuts they added).
pub fn send_to_targets() -> Vec<SendTarget> {
    use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::{SHGetKnownFolderPath, FOLDERID_SendTo, KF_FLAG_DEFAULT}};
    let dir = unsafe {
        let Ok(p) = SHGetKnownFolderPath(&FOLDERID_SendTo, KF_FLAG_DEFAULT, None) else { return vec![] };
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as _));
        PathBuf::from(s)
    };
    let mut out: Vec<SendTarget> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        // desktop.ini and other hidden files aren't targets.
        .filter(|e| e.metadata().is_ok_and(|m| std::os::windows::fs::MetadataExt::file_attributes(&m) & 0x6 == 0))
        .map(|e| {
            let p = e.path();
            let name = p.file_stem().unwrap_or(p.as_os_str()).to_string_lossy().into_owned();
            SendTarget { name, path: p.to_string_lossy().into_owned() }
        })
        .collect();
    out.sort_by_key(|t| t.name.to_lowercase());
    out
}

struct Pidl(*mut ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) { unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(self.0 as _)) } }
}
fn parse(p: &Path) -> Result<Pidl, String> {
    let w = wide(p);
    let mut pidl = std::ptr::null_mut();
    unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut pidl, 0, None) }.map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(Pidl(pidl))
}

/// Drops `items` (all from one folder) on a Send To entry, exactly as Explorer does. Copy or link only:
/// Send to never moves the originals. Must run on a UI thread (some targets keep working after Drop returns).
pub fn send_to(hwnd: isize, target: &Path, items: &[PathBuf]) -> Result<(), String> {
    if items.is_empty() { return Err("nothing selected".into()); }
    let hwnd = HWND(hwnd as *mut c_void);
    let e = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let pidls = items.iter().map(|p| parse(p)).collect::<Result<Vec<_>, _>>()?;
        let parent: IShellFolder = SHBindToParent(pidls[0].0, None).map_err(e)?;
        let children: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| ILFindLastID(p.0) as *const _).collect();
        let data: IDataObject = parent.GetUIObjectOf(hwnd, &children, None).map_err(e)?;
        let t = parse(target)?;
        let tparent: IShellFolder = SHBindToParent(t.0, None).map_err(e)?;
        let drop: IDropTarget = tparent.GetUIObjectOf(hwnd, &[ILFindLastID(t.0) as *const _], None).map_err(e)?;
        let mut effect: DROPEFFECT = DROPEFFECT_COPY | DROPEFFECT_LINK;
        drop.DragEnter(&data, MK_LBUTTON, POINTL::default(), &mut effect).map_err(e)?;
        if effect == DROPEFFECT_NONE {
            let _ = drop.DragLeave();
            return Err("that Send to target doesn't accept these items".into());
        }
        drop.Drop(&data, MK_LBUTTON, POINTL::default(), &mut effect).map_err(e)
    }
}

// ---------------- Share ----------------

thread_local! {
    /// The DataRequested handler of the last Share, removed before the next one so they don't pile up.
    static SHARE_TOKEN: std::cell::Cell<Option<(isize, i64)>> = const { std::cell::Cell::new(None) };
}

/// Windows' Share sheet for these files/folders, attached to `hwnd`. Must run on that window's UI thread.
pub fn share(hwnd: isize, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() { return Err("nothing selected".into()); }
    let e = |e: windows::core::Error| e.to_string();
    let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let title = if paths.len() == 1 {
        Path::new(&paths[0]).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        format!("{} items", paths.len())
    };
    unsafe {
        let interop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>().map_err(e)?;
        let h = HWND(hwnd as *mut c_void);
        let dtm: DataTransferManager = interop.GetForWindow(h).map_err(e)?;
        if let Some((w, tok)) = SHARE_TOKEN.with(|t| t.take()) {
            if w == hwnd { let _ = dtm.RemoveDataRequested(tok); }
        }
        let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
            let Some(args) = args.as_ref() else { return Ok(()) };
            let data = args.Request()?.Data()?;
            data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
            let mut items: Vec<Option<IStorageItem>> = Vec::new();
            for p in &paths {
                let h = HSTRING::from(p.as_str());
                let item: IStorageItem = if Path::new(p).is_dir() { StorageFolder::GetFolderFromPathAsync(&h)?.join()?.cast()? } else { StorageFile::GetFileFromPathAsync(&h)?.join()?.cast()? };
                items.push(Some(item));
            }
            data.SetStorageItemsReadOnly(&windows_collections::IIterable::<IStorageItem>::from(items))
        });
        let tok = dtm.DataRequested(&handler).map_err(e)?;
        SHARE_TOKEN.with(|t| t.set(Some((hwnd, tok))));
        interop.ShowShareUIForWindow(h).map_err(e)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn shortcut_next_to_target() {
        let d = std::env::temp_dir().join(format!("de-lnk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("notes.txt"), "x").unwrap();
        let a = super::create_shortcut(&d.join("notes.txt")).unwrap();
        let b = super::create_shortcut(&d.join("notes.txt")).unwrap();
        assert_eq!(a, d.join("notes.txt - Shortcut.lnk"));
        assert_eq!(b, d.join("notes.txt - Shortcut (2).lnk"));
        assert_eq!(crate::clip::resolve_link(&a).as_deref(), Some(d.join("notes.txt").as_path()));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn send_to_lists_entries() {
        let t = super::send_to_targets();
        assert!(t.iter().all(|x| !x.path.to_lowercase().ends_with("desktop.ini")), "{t:?}");
    }
}
