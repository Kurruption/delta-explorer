//! Native Windows pieces: CopyFileEx with progress, restoring from the Recycle Bin, the real Explorer
//! right-click menu (with shell extensions: 7-Zip, VS Code, Git...), and the opt-in Win+E override.
use std::{cell::RefCell, ffi::c_void, io, os::windows::ffi::OsStrExt, path::{Path, PathBuf}};
use windows::{
    core::{Interface, PCSTR, PCWSTR},
    Win32::{
        Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM},
        Storage::FileSystem::{CopyFileExW, COPY_FILE_FAIL_IF_EXISTS, COPYPROGRESSROUTINE_PROGRESS, LPPROGRESS_ROUTINE_CALLBACK_REASON, PROGRESS_CANCEL, PROGRESS_CONTINUE},
        System::{
            Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
            Registry::{RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ},
        },
        UI::{
            Shell::{
                Common::ITEMIDLIST, DefSubclassProc, ILFindLastID, IContextMenu, IContextMenu3, IShellFolder, RemoveWindowSubclass, SHBindToParent,
                SHGetDesktopFolder, SHParseDisplayName, SetWindowSubclass, CMF_EXPLORE, CMF_EXTENDEDVERBS, CMF_NORMAL, CMIC_MASK_PTINVOKE,
                CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
            },
            WindowsAndMessaging::{
                CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemInfoW, HMENU, MENUITEMINFOW, MFS_DISABLED, MFT_OWNERDRAW, MFT_SEPARATOR,
                MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, SetForegroundWindow, TrackPopupMenuEx, SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DRAWITEM,
                WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
            },
        },
    },
};

/// SEE_MASK_UNICODE: lpVerbW / lpDirectoryW are used (not exported by the windows crate).
const CMIC_MASK_UNICODE: u32 = 0x4000;

fn wide(p: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    p.as_ref().encode_wide().chain([0]).collect()
}

// ---------------- copy with progress ----------------

type Progress<'a> = &'a mut dyn FnMut(u64) -> bool;

unsafe extern "system" fn on_progress(
    _total: i64, done: i64, _ss: i64, _sd: i64, _n: u32, _r: LPPROGRESS_ROUTINE_CALLBACK_REASON, _a: HANDLE, _b: HANDLE, data: *const c_void,
) -> COPYPROGRESSROUTINE_PROGRESS {
    let f = &mut *(data as *mut Progress);
    if f(done as u64) { PROGRESS_CONTINUE } else { PROGRESS_CANCEL }
}

/// Copies one file with Windows' own copier (keeps attributes and timestamps, handles huge files).
/// `progress(bytes_done)` returning false cancels; CopyFileEx then deletes the partial file itself.
pub fn copy_file(from: &Path, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
    let (a, b) = (wide(from), wide(to));
    let mut p: Progress = progress;
    let r = unsafe {
        CopyFileExW(PCWSTR(a.as_ptr()), PCWSTR(b.as_ptr()), Some(on_progress), Some(&mut p as *mut Progress as *const c_void), None, COPY_FILE_FAIL_IF_EXISTS)
    };
    r.map_err(|e| {
        // ERROR_REQUEST_ABORTED (1235) = we cancelled.
        if e.code().0 as u32 == 0x8007_04D3 { io::Error::new(io::ErrorKind::Interrupted, "cancelled") } else { io::Error::from_raw_os_error(e.code().0 & 0xFFFF) }
    })
}

// ---------------- Recycle Bin restore (for undo) ----------------

/// Puts back the most recently deleted item for each path. Returns how many were restored.
pub fn restore(paths: &[PathBuf]) -> Result<usize, String> {
    let all = trash::os_limited::list().map_err(|e| e.to_string())?;
    let mut picks = Vec::new();
    for p in paths {
        let best = all.iter().filter(|i| i.original_parent.join(&i.name) == *p).max_by_key(|i| i.time_deleted);
        if let Some(i) = best { picks.push(i.clone()); }
    }
    let n = picks.len();
    if n > 0 { trash::os_limited::restore_all(picks).map_err(|e| e.to_string())?; }
    Ok(n)
}

/// One item in the Recycle Bin, as Delta's own Recycle Bin view shows it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinItem {
    /// Shell id of the item inside the bin (used to restore/purge, and for its icon).
    pub id: String,
    pub name: String,
    pub original: String,
    /// Seconds since Unix epoch.
    pub deleted: i64,
    pub size: Option<u64>,
    pub is_dir: bool,
}

pub fn bin_list() -> Result<Vec<BinItem>, String> {
    let mut items: Vec<BinItem> = trash::os_limited::list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|i| {
            let meta = trash::os_limited::metadata(&i).ok();
            BinItem {
                id: i.id.to_string_lossy().into_owned(),
                name: i.name.to_string_lossy().into_owned(),
                original: i.original_parent.to_string_lossy().into_owned(),
                deleted: i.time_deleted,
                size: meta.as_ref().and_then(|m| m.size.size()),
                is_dir: meta.is_some_and(|m| m.size.entries().is_some()),
            }
        })
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.deleted));
    Ok(items)
}

fn bin_pick(ids: &[String]) -> Result<Vec<trash::TrashItem>, String> {
    let want: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    Ok(trash::os_limited::list().map_err(|e| e.to_string())?.into_iter().filter(|i| want.contains(i.id.to_string_lossy().as_ref())).collect())
}

/// Puts items back where they came from. Fails (and restores nothing) if something now exists at a target path.
pub fn bin_restore(ids: &[String]) -> Result<(), String> {
    trash::os_limited::restore_all(bin_pick(ids)?).map_err(|e| match e {
        trash::Error::RestoreCollision { path, .. } => format!("{} already exists; rename or move it first", path.display()),
        e => e.to_string(),
    })
}

/// Deletes items for good. Cannot be undone.
pub fn bin_purge(ids: &[String]) -> Result<(), String> {
    trash::os_limited::purge_all(bin_pick(ids)?).map_err(|e| e.to_string())
}

// ---------------- the Explorer context menu ----------------

thread_local! {
    // The open menu, so owner-drawn submenus ("Send to", "Open with", "New") can draw themselves.
    static OPEN_MENU: RefCell<Option<IContextMenu3>> = const { RefCell::new(None) };
}

unsafe extern "system" fn menu_subclass(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
    if matches!(msg, WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR) {
        if let Some(cm) = OPEN_MENU.with(|m| m.borrow().clone()) {
            let mut res = LRESULT(0);
            if cm.HandleMenuMsg2(msg, wp, lp, Some(&mut res)).is_ok() { return res; }
        }
    }
    DefSubclassProc(hwnd, msg, wp, lp)
}

struct Pidl(*mut ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) { unsafe { CoTaskMemFree(Some(self.0 as _)) } }
}
fn parse(p: &Path) -> Result<Pidl, String> {
    let w = wide(p);
    let mut pidl = std::ptr::null_mut();
    unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut pidl, 0, None) }.map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(Pidl(pidl))
}

/// Shows Windows' own context menu for `items` (all in one folder), or for the folder background when
/// `items` is empty, at screen point (x, y), and runs the chosen command. Must run on the window's UI thread.
/// Builds the shell's context menu object for `items` (or the folder background when empty).
unsafe fn context_menu(hwnd: HWND, folder: &Path, items: &[PathBuf]) -> Result<(IContextMenu, Vec<Pidl>), String> {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    let e = |e: windows::core::Error| e.to_string();
    if items.is_empty() {
        let pidl = parse(folder)?;
        let sf: IShellFolder = SHGetDesktopFolder().map_err(e)?.BindToObject(pidl.0, None).map_err(e)?;
        Ok((sf.CreateViewObject(hwnd).map_err(e)?, vec![pidl]))
    } else {
        let pidls = items.iter().map(|p| parse(p)).collect::<Result<Vec<_>, _>>()?;
        let parent: IShellFolder = SHBindToParent(pidls[0].0, None).map_err(e)?;
        let children: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| ILFindLastID(p.0) as *const _).collect();
        Ok((parent.GetUIObjectOf(hwnd, &children, None).map_err(e)?, pidls))
    }
}

unsafe fn invoke(cm: &IContextMenu, hwnd: HWND, folder: &Path, cmd: u32, x: i32, y: i32) -> Result<(), String> {
    let dir = wide(folder);
    let verb = (cmd - 1) as usize; // MAKEINTRESOURCE(offset)
    let info = CMINVOKECOMMANDINFOEX {
        cbSize: size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE,
        hwnd,
        lpVerb: PCSTR(verb as *const u8),
        lpVerbW: PCWSTR(verb as *const u16),
        lpDirectoryW: PCWSTR(dir.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ptInvoke: POINT { x, y },
        ..Default::default()
    };
    cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(|e| e.to_string())
}

pub fn show_menu(hwnd: isize, folder: &Path, items: &[PathBuf], x: i32, y: i32, extended: bool) -> Result<(), String> {
    let hwnd = HWND(hwnd as *mut c_void);
    let e = |e: windows::core::Error| e.to_string();
    unsafe {
        let (cm, _keep) = context_menu(hwnd, folder, items)?;
        let menu = CreatePopupMenu().map_err(e)?;
        let flags = CMF_NORMAL | CMF_EXPLORE | if extended { CMF_EXTENDEDVERBS } else { 0 };
        cm.QueryContextMenu(menu, 0, 1, 0x7FFF, flags).ok().map_err(e)?;
        OPEN_MENU.with(|m| *m.borrow_mut() = cm.cast::<IContextMenu3>().ok());
        let _ = SetWindowSubclass(hwnd, Some(menu_subclass), 0xDE17A, 0);
        let _ = SetForegroundWindow(hwnd); // otherwise the menu won't close when clicking elsewhere
        let cmd = TrackPopupMenuEx(menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, x, y, hwnd, None).0;
        let _ = RemoveWindowSubclass(hwnd, Some(menu_subclass), 0xDE17A);
        OPEN_MENU.with(|m| *m.borrow_mut() = None);
        let result = if cmd > 0 { invoke(&cm, hwnd, folder, cmd as u32, x, y) } else { Ok(()) };
        let _ = DestroyMenu(menu);
        result
    }
}

// ---------------- Windows' menu entries, drawn by Delta ----------------

/// One entry of Windows' right-click menu, for Delta to draw in its own menu. `id` 0 = separator.
#[derive(serde::Serialize)]
pub struct NativeItem {
    pub id: u32,
    pub label: String,
    pub disabled: bool,
    pub sub: Vec<NativeItem>,
}

struct Held { cm: IContextMenu, menu: HMENU, folder: PathBuf, _pidls: Vec<Pidl> }
thread_local! {
    /// The menu last listed by `menu_items`, kept until an entry is run or a new menu is listed (UI thread only).
    static HELD: RefCell<Option<Held>> = const { RefCell::new(None) };
}

unsafe fn read_menu(menu: HMENU, cm3: Option<&IContextMenu3>, depth: u32) -> Vec<NativeItem> {
    let mut out = Vec::new();
    for i in 0..GetMenuItemCount(Some(menu)).max(0) as u32 {
        let mut mi = MENUITEMINFOW { cbSize: size_of::<MENUITEMINFOW>() as u32, fMask: MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_SUBMENU | MIIM_STRING, ..Default::default() };
        if GetMenuItemInfoW(menu, i, true, &mut mi).is_err() { continue; }
        if mi.fType.0 & MFT_SEPARATOR.0 != 0 {
            if out.last().is_some_and(|x: &NativeItem| x.id != 0) { out.push(NativeItem { id: 0, label: String::new(), disabled: false, sub: vec![] }); }
            continue;
        }
        let mut buf = vec![0u16; mi.cch as usize + 1];
        mi.dwTypeData = windows::core::PWSTR(buf.as_mut_ptr());
        mi.cch += 1;
        if GetMenuItemInfoW(menu, i, true, &mut mi).is_err() { continue; }
        let label: String = String::from_utf16_lossy(&buf[..mi.cch as usize]).split('\t').next().unwrap_or("").replace("&&", "\u{1}").replace('&', "").replace('\u{1}', "&");
        if label.trim().is_empty() || mi.fType.0 & MFT_OWNERDRAW.0 != 0 && label.trim().is_empty() { continue; }
        let mut sub = Vec::new();
        if !mi.hSubMenu.is_invalid() && depth < 3 {
            // Some extensions only fill their submenu when it's about to open.
            if let Some(c) = cm3 { let _ = c.HandleMenuMsg(WM_INITMENUPOPUP, WPARAM(mi.hSubMenu.0 as usize), LPARAM(i as isize)); }
            sub = read_menu(mi.hSubMenu, cm3, depth + 1);
            if sub.is_empty() { continue; }
        }
        out.push(NativeItem { id: mi.wID, label: label.trim().to_string(), disabled: mi.fState.0 & MFS_DISABLED.0 != 0, sub });
    }
    while out.last().is_some_and(|x| x.id == 0) { out.pop(); }
    out
}

/// Lists Windows' right-click menu for `items` (or the folder background). Run `menu_invoke` with an `id` to use one.
pub fn menu_items(hwnd: isize, folder: &Path, items: &[PathBuf], extended: bool) -> Result<Vec<NativeItem>, String> {
    let hwnd = HWND(hwnd as *mut c_void);
    unsafe {
        HELD.with(|h| { if let Some(old) = h.borrow_mut().take() { let _ = DestroyMenu(old.menu); } });
        let (cm, pidls) = context_menu(hwnd, folder, items)?;
        let menu = CreatePopupMenu().map_err(|e| e.to_string())?;
        let flags = CMF_NORMAL | CMF_EXPLORE | if extended { CMF_EXTENDEDVERBS } else { 0 };
        cm.QueryContextMenu(menu, 0, 1, 0x7FFF, flags).ok().map_err(|e| e.to_string())?;
        let cm3 = cm.cast::<IContextMenu3>().ok();
        let list = read_menu(menu, cm3.as_ref(), 0);
        HELD.with(|h| *h.borrow_mut() = Some(Held { cm, menu, folder: folder.to_path_buf(), _pidls: pidls }));
        Ok(list)
    }
}

/// Runs entry `id` of the menu `menu_items` listed last.
pub fn menu_invoke(hwnd: isize, id: u32, x: i32, y: i32) -> Result<(), String> {
    let hwnd = HWND(hwnd as *mut c_void);
    let held = HELD.with(|h| h.borrow_mut().take()).ok_or("That menu has closed; right-click again")?;
    unsafe {
        let r = invoke(&held.cm, hwnd, &held.folder, id, x, y);
        let _ = DestroyMenu(held.menu);
        r
    }
}

// ---------------- Win+E ----------------

/// Explorer launches this per-user override of "This PC → open new window" for Win+E.
const WIN_E: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";
const WIN_E_CMD: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command";

/// Makes Win+E open `exe`, or restores Windows' default (deletes only our per-user key).
pub fn set_win_e(exe: Option<&Path>) -> Result<(), String> {
    unsafe {
        match exe {
            None => {
                let k = wide(WIN_E);
                let r = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()));
                if r.0 != 0 && r.0 != 2 { return Err(format!("registry error {}", r.0)); } // 2 = already gone
                Ok(())
            }
            Some(exe) => {
                let k = wide(WIN_E_CMD);
                let cmd = wide(format!("\"{}\"", exe.display()));
                let empty = wide("");
                let de = wide("DelegateExecute");
                for (name, val) in [(PCWSTR::null(), &cmd), (PCWSTR(de.as_ptr()), &empty)] {
                    let r = RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), name, REG_SZ.0, Some(val.as_ptr() as _), (val.len() * 2) as u32);
                    if r.0 != 0 { return Err(format!("registry error {}", r.0)); }
                }
                Ok(())
            }
        }
    }
}

pub fn win_e_is_set() -> bool {
    let k = wide(WIN_E_CMD);
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), PCWSTR::null(), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as _), Some(&mut len)) };
    r.0 == 0 && String::from_utf16_lossy(&buf).to_lowercase().contains("delta-explorer")
}

#[cfg(test)]
mod tests {
    #[test]
    fn copy_file_reports_progress_and_cancels() {
        let d = std::env::temp_dir().join(format!("de-copyex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.bin"), vec![7u8; 3 << 20]).unwrap();
        let mut last = 0;
        super::copy_file(&d.join("a.bin"), &d.join("b.bin"), &mut |n| { last = n; true }).unwrap();
        assert_eq!(last, 3 << 20);
        assert!(super::copy_file(&d.join("a.bin"), &d.join("b.bin"), &mut |_| true).is_err(), "never overwrites");
        let e = super::copy_file(&d.join("a.bin"), &d.join("c.bin"), &mut |_| false).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::Interrupted);
        assert!(!d.join("c.bin").exists(), "cancelled copy leaves nothing behind");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
