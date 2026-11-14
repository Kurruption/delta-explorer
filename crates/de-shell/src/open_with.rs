//! "Open with": the apps Windows has registered for a file type (Notepad, Obsidian, Photos, Paint...),
//! launching a file with one of them, and the system "Choose another app" dialog.
use serde::Serialize;
use std::path::Path;
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        System::Com::{CoInitializeEx, CoTaskMemFree, IDataObject, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        UI::Shell::{
            AssocGetPerceivedType,
            Common::{PERCEIVED, PERCEIVED_TYPE_AUDIO, PERCEIVED_TYPE_DOCUMENT, PERCEIVED_TYPE_IMAGE, PERCEIVED_TYPE_TEXT, PERCEIVED_TYPE_VIDEO},
            SHLoadIndirectString,
            BHID_DataObject, IAssocHandler, IShellItem, SHAssocEnumHandlers, SHCreateItemFromParsingName, SHOpenWithDialog, ASSOC_FILTER_RECOMMENDED,
            OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO,
        },
    },
};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// Stable id (the handler's GetName: an exe path or an app id) used to launch it later.
    pub id: String,
    pub name: String,
    /// File to take the icon from (exe/dll), when the app has a plain file icon.
    pub icon: Option<String>,
    pub recommended: bool,
}

fn com() {
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// Reads and frees a shell-allocated string.
unsafe fn take(p: PWSTR) -> String {
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as _));
    s
}

fn ext_of(path: &Path) -> Result<String, String> {
    path.extension().map(|e| format!(".{}", e.to_string_lossy())).ok_or_else(|| "this file has no extension".into())
}

fn handlers(ext: &str) -> Result<Vec<IAssocHandler>, String> {
    com();
    let w = wide(ext);
    let en = unsafe { SHAssocEnumHandlers(PCWSTR(w.as_ptr()), ASSOC_FILTER_RECOMMENDED) }.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    loop {
        let mut one = [None];
        let mut got = 0;
        if unsafe { en.Next(&mut one, Some(&mut got)) }.is_err() || got == 0 { break; }
        if let Some(h) = one[0].take() { out.push(h); }
    }
    Ok(out)
}

/// What kind of file this is, per Windows (PerceivedType), boiled down to what matters for picking apps.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind { Image, Video, Audio, Text, Document, Other }

fn kind_of(ext: &str) -> Kind {
    let w = wide(ext);
    let mut t = PERCEIVED::default();
    let mut f = 0u32;
    if unsafe { AssocGetPerceivedType(PCWSTR(w.as_ptr()), &mut t, &mut f, None) }.is_err() {
        return Kind::Other;
    }
    match t {
        PERCEIVED_TYPE_IMAGE => Kind::Image,
        PERCEIVED_TYPE_VIDEO => Kind::Video,
        PERCEIVED_TYPE_AUDIO => Kind::Audio,
        PERCEIVED_TYPE_TEXT => Kind::Text,
        PERCEIVED_TYPE_DOCUMENT => Kind::Document,
        _ => Kind::Other,
    }
}

/// Windows keeps apps "recommended" once a file of that type was opened with them (even Notepad on a PNG).
/// This keeps only apps that can actually show the file: well-known app families are matched to file kinds;
/// unknown apps (they registered for the type themselves) are kept.
fn fits(app: &str, kind: Kind) -> bool {
    let a = app.to_lowercase();
    let any = |names: &[&str]| names.iter().any(|n| a.contains(n));
    use Kind::*;
    if any(&["notepad", "wordpad", "sublime", "write"]) {
        return matches!(kind, Text | Other);
    }
    if any(&["photo viewer", "paint", "snipping", "photoshop", "gimp"]) {
        return kind == Image;
    }
    if any(&["photos"]) {
        return matches!(kind, Image | Video);
    }
    if any(&["media player", "vlc", "movies", "groove", "music", "mpv", "potplayer"]) {
        return matches!(kind, Video | Audio);
    }
    true
}

/// Apps Windows recommends for this type (the ones that actually handle it: no Notepad for photos).
/// Everything else stays reachable through `choose_app`.
pub fn apps_for(path: &Path) -> Result<Vec<App>, String> {
    let ext = ext_of(path)?;
    let kind = kind_of(&ext);
    let mut apps: Vec<App> = handlers(&ext)?
        .into_iter()
        .filter_map(|h| unsafe {
            let id = take(h.GetName().ok()?);
            let name = take(h.GetUIName().ok()?);
            let mut loc = PWSTR::null();
            let mut idx = 0;
            let icon = h.GetIconLocation(&mut loc, &mut idx).ok().map(|_| take(loc)).and_then(|l| {
                // Store apps give an indirect "@{Package?ms-resource://...}" string: resolve it to their PNG logo.
                let l = if l.starts_with('@') { resolve_indirect(&l)? } else { l };
                let low = l.to_lowercase();
                [".exe", ".dll", ".ico", ".png"].iter().any(|e| low.ends_with(e)).then_some(l)
            });
            if !fits(&name, kind) && !fits(&id, kind) { return None; }
            Some(App { id, name, icon, recommended: h.IsRecommended().is_ok() && h.IsRecommended() == windows::Win32::Foundation::S_OK })
        })
        .collect();
    apps.sort_by(|a, b| b.recommended.cmp(&a.recommended).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    apps.dedup_by(|a, b| a.name == b.name);
    Ok(apps)
}

fn resolve_indirect(s: &str) -> Option<String> {
    let w = wide(s);
    let mut buf = [0u16; 1024];
    unsafe { SHLoadIndirectString(PCWSTR(w.as_ptr()), &mut buf, None) }.ok()?;
    Some(String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0)?]))
}

/// Opens `path` with the app whose id came from `apps_for`.
pub fn open_with(path: &Path, app_id: &str) -> Result<(), String> {
    let h = handlers(&ext_of(path)?)?
        .into_iter()
        .find(|h| unsafe { h.GetName().map(|n| take(n) == app_id).unwrap_or(false) })
        .ok_or("that app is no longer registered for this file type")?;
    let w: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain([0]).collect();
    unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).map_err(|e| e.to_string())?;
        let data: IDataObject = item.BindToHandler(None, &BHID_DataObject).map_err(|e| e.to_string())?;
        h.Invoke(&data).map_err(|e| e.to_string())
    }
}

/// Windows' own "How do you want to open this file?" dialog (can also set the default app).
pub fn choose_app(path: &Path) -> Result<(), String> {
    com();
    let w: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain([0]).collect();
    let info = OPENASINFO { pcszFile: PCWSTR(w.as_ptr()), pcszClass: PCWSTR::null(), oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC };
    unsafe { SHOpenWithDialog(None, &info) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{fits, Kind};

    #[test]
    fn apps_match_file_kinds() {
        assert!(!fits("Notepad", Kind::Image));
        assert!(fits("Notepad", Kind::Text));
        assert!(!fits("Photo Viewer", Kind::Video));
        assert!(fits("Photos", Kind::Video));
        assert!(!fits("Windows Media Player Legacy", Kind::Text));
        assert!(fits("Visual Studio Code", Kind::Image));
        assert!(fits("Some Unknown App", Kind::Document));
    }

    #[test]
    fn txt_files_have_apps() {
        let apps = super::apps_for(std::path::Path::new(r"C:\x\a.txt")).unwrap();
        assert!(!apps.is_empty(), "every Windows install can open .txt");
        assert!(apps.iter().all(|a| !a.name.is_empty() && !a.id.is_empty()));
    }
}
