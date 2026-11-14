//! "Try as administrator". Delta itself never runs elevated: one operation goes to a short-lived copy of
//! delta-explorer.exe started through UAC with `--elevated-op <request.json>`. That helper re-validates the
//! request, performs only that operation, writes `<request>.result.json` and exits; this side waits and reports.
use de_core::elevated::{validate, Op, Outcome, Request};
use std::{
    io,
    path::{Path, PathBuf},
};

struct NoProgress;
impl de_core::transfer::Sink for NoProgress {
    fn bytes(&mut self, _: u64) {}
    fn item(&mut self, _: &Path) {}
    fn cancelled(&self) -> bool { false }
}

fn result_path(req: &Path) -> PathBuf { req.with_extension("result.json") }

fn perform(r: &Request) -> Outcome {
    let s = |p: &Path| de_core::display(p);
    let mut out = Outcome::default();
    let copy: de_core::transfer::CopyFile = &de_shell::native::copy_file;
    let res: Result<(), String> = match r.op {
        Op::Copy => {
            let mut made = Vec::new();
            let x = de_core::transfer::copy_items(&r.items, r.dest.as_deref().unwrap(), &mut NoProgress, copy, &mut made).map_err(|e| e.to_string());
            out.created = made.iter().map(|p| s(p)).collect();
            x
        }
        Op::Move => {
            let mut moved = Vec::new();
            let x = de_core::transfer::move_items(&r.items, r.dest.as_deref().unwrap(), &mut NoProgress, copy, &mut moved).map_err(|e| e.to_string());
            out.moved = moved.iter().map(|(a, b)| (s(a), s(b))).collect();
            x
        }
        Op::Recycle => de_shell::recycle(&r.items),
        Op::Delete => de_core::ops::remove_forever(&r.items),
        Op::Rename => de_core::ops::rename(&r.items[0], r.name.as_deref().unwrap()).map(|to| out.created = vec![s(&to)]).map_err(|e| e.to_string()),
        Op::Mkdir => {
            let free = de_core::ops::free_name(&r.items[0], r.name.as_deref().unwrap());
            let used = free.file_name().unwrap().to_string_lossy().into_owned();
            de_core::ops::create_dir(&r.items[0], &used).map(|p| out.created = vec![s(&p)]).map_err(|e| e.to_string())
        }
    };
    out.ok = res.is_ok();
    out.error = res.err();
    out
}

/// Entry point of the elevated helper (see main.rs). Exit code 0 = a result file was written.
pub fn helper_main(file: Option<&std::ffi::OsStr>) -> i32 {
    let Some(file) = file.map(PathBuf::from) else { return 2 };
    // Only request files Delta writes: our own folder in temp, our own name pattern.
    let named_ok = file.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("op-") && n.ends_with(".json") && !n.ends_with(".result.json"));
    if !named_ok || file.parent().and_then(|p| p.file_name()).is_none_or(|n| n != "DeltaElevated") { return 2; }
    let out = (|| -> Result<Outcome, String> {
        let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        if text.len() > 8 << 20 { return Err("request too large".into()); }
        let req: Request = serde_json::from_str(&text).map_err(|e| format!("bad request: {e}"))?;
        validate(&req)?;
        Ok(perform(&req))
    })()
    .unwrap_or_else(|e| Outcome { error: Some(e), ..Default::default() });
    match serde_json::to_string(&out).map_err(io::Error::other).and_then(|j| std::fs::write(result_path(&file), j)) {
        Ok(()) => 0,
        Err(_) => 3,
    }
}

/// Runs one operation through the elevated helper and waits for it (UAC prompt in between).
#[tauri::command]
pub async fn run_elevated(window: tauri::WebviewWindow, request: Request) -> Result<Outcome, String> {
    validate(&request)?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::env::temp_dir().join("DeltaElevated");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let file = dir.join(format!("op-{}-{nanos}.json", std::process::id()));
        std::fs::write(&file, serde_json::to_string(&request).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let ran = de_shell::extras::run_as_admin(hwnd, &exe, &["--elevated-op", &file.to_string_lossy()]);
        let res = result_path(&file);
        let read = std::fs::read_to_string(&res);
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_file(&res);
        let code = ran?;
        // A failed operation still comes back as Ok: a partial move's pairs matter to the UI.
        serde_json::from_str::<Outcome>(&read.map_err(|_| format!("the administrator helper failed (exit code {code})"))?).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
