//! Background jobs (copy, move, zip, extract) with progress events and cancel.
//! Each job runs on its own thread; the UI gets a "job" event at most every 80 ms, plus a final one.
//! A copy/move that hits an existing name pauses (state "conflict") until the UI answers via `answer`.
use de_core::transfer::{self, Choice, Sink};
use serde::Serialize;
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// One side of a name clash, for the dialog's comparison.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub path: String,
    pub is_dir: bool,
    /// Bytes (a folder: everything inside it).
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub src: Side,
    pub dst: Side,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub id: u64,
    pub kind: String,
    /// "Copying 3 items to Downloads"
    pub label: String,
    pub done: u64,
    pub total: u64,
    pub current: String,
    /// running | conflict | done | error | cancelled
    pub state: &'static str,
    pub error: Option<String>,
    /// What the job created (copy/zip/extract): undo removes these.
    pub created: Vec<String>,
    /// (from, to) pairs a move produced: undo moves them back.
    pub moved: Vec<(String, String)>,
    /// Destination folder (copy/move), so failed items can be retried.
    pub dest: Option<String>,
    /// While state is "conflict": the clash waiting for an answer.
    pub conflict: Option<Conflict>,
    /// (item, why) for each item that failed; the others still went through.
    pub failed: Vec<(String, String)>,
    /// Items that were replaced (they're in the Recycle Bin): undo restores them.
    pub replaced: Vec<String>,
    /// Only on a failed copy/move (so "Try as administrator" can retry it); empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
}

struct Running {
    cancel: Arc<AtomicBool>,
    answer: mpsc::Sender<(Choice, bool)>,
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Running>>,
}

pub(crate) struct Emit {
    app: AppHandle,
    /// The window that started the job; only it shows progress and offers undo.
    window: String,
    pub(crate) upd: JobUpdate,
    last: Instant,
    cancel: Arc<AtomicBool>,
    answers: mpsc::Receiver<(Choice, bool)>,
}
impl Emit {
    fn send(&mut self, force: bool) {
        if force || self.last.elapsed() >= Duration::from_millis(80) {
            self.last = Instant::now();
            let _ = self.app.emit_to(self.window.as_str(), "job", &self.upd);
        }
    }
}
fn side(p: &Path) -> Side {
    let m = std::fs::metadata(p).ok();
    let is_dir = m.as_ref().is_some_and(|m| m.is_dir());
    Side {
        path: s(p),
        is_dir,
        size: if is_dir { transfer::measure(&[p.to_path_buf()]).0 } else { m.as_ref().map_or(0, |m| m.len()) },
        modified: m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()),
    }
}
impl Sink for Emit {
    fn bytes(&mut self, n: u64) { self.upd.done += n; self.send(false); }
    fn item(&mut self, p: &Path) { self.upd.current = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(); self.send(false); }
    fn cancelled(&self) -> bool { self.cancel.load(Ordering::Relaxed) }
    fn conflict(&mut self, src: &Path, dst: &Path) -> io::Result<Option<(Choice, bool)>> {
        self.upd.state = "conflict";
        self.upd.conflict = Some(Conflict { src: side(src), dst: side(dst) });
        self.send(true);
        // Wait for the dialog; Cancel on the job card (or closing the app) ends the wait.
        let r = loop {
            if self.cancelled() { break Err(transfer::cancelled()); }
            match self.answers.recv_timeout(Duration::from_millis(100)) {
                Ok(a) => break Ok(Some(a)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break Err(transfer::cancelled()),
            }
        };
        self.upd.state = "running";
        self.upd.conflict = None;
        self.send(true);
        r
    }
    /// Replace never destroys: the old item goes to the Recycle Bin (undo brings it back).
    fn discard(&mut self, dst: &Path) -> io::Result<()> {
        de_shell::recycle(&[dst.to_path_buf()]).map_err(|e| io::Error::other(format!("{}: couldn't move the old one to the Recycle Bin, so it wasn't replaced ({e})", dst.display())))?;
        self.upd.replaced.push(s(dst));
        Ok(())
    }
    fn failed(&mut self, src: &Path, e: &io::Error) { self.upd.failed.push((s(src), e.to_string())); }
}

pub(crate) fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}
pub(crate) fn s(p: &Path) -> String { de_core::display(p) }
pub(crate) fn things(items: &[PathBuf]) -> String {
    if items.len() == 1 { format!("\u{201c}{}\u{201d}", name(&items[0])) } else { format!("{} items", items.len()) }
}

impl Jobs {
    pub fn start(self: &Arc<Self>, app: AppHandle, window: String, kind: String, items: Vec<PathBuf>, dest: Option<PathBuf>, remotes: crate::remote::Remotes) -> Result<u64, String> {
        if items.is_empty() { return Err("nothing selected".into()); }
        let remote = items.iter().chain(dest.iter()).any(|p| p.to_str().is_some_and(de_remote::is_remote));
        if remote && !matches!(kind.as_str(), "copy" | "move") { return Err("Compress and extract work on files on this PC; copy them here first".into()); }
        if kind == "zip" { de_core::archive::only_folders(&items).map_err(|e| e.to_string())?; }
        // Items inside a browsed archive are read-only: moving them out means copying.
        let from_archive = items.iter().any(|p| p.to_string_lossy().starts_with(de_core::archive::PREFIX));
        let kind = if kind == "move" && from_archive { "copy".to_string() } else { kind };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, answers) = mpsc::channel();
        let label = match (kind.as_str(), &dest) {
            ("copy", Some(d)) => format!("Copying {} to {}", things(&items), name(d)),
            ("move", Some(d)) => format!("Moving {} to {}", things(&items), name(d)),
            ("zip", _) => format!("Compressing {}", things(&items)),
            ("extract", _) => format!("Extracting {}", things(&items)),
            _ => return Err(format!("unknown job {kind}")),
        };
        self.running.lock().unwrap().insert(id, Running { cancel: cancel.clone(), answer: tx });
        let me = self.clone();
        std::thread::spawn(move || {
            let upd = JobUpdate { id, kind: kind.clone(), label, state: "running", dest: dest.as_deref().map(s), ..Default::default() };
            let mut e = Emit { app, window, upd, last: Instant::now(), cancel, answers };
            e.send(true);
            let copy: transfer::CopyFile = &de_shell::native::copy_file;
            let r: io::Result<()> = (|| {
                let items = if kind == "copy" && from_archive {
                    let m = de_core::archive::materialize(&items, &crate::tools::temp_root(), &mut e)?;
                    e.upd.done = 0;
                    m
                } else { items.clone() };
                match kind.as_str() {
                    // Anything touching a server: its own sessions (not the browsing one), same progress/cancel.
                    "copy" | "move" if remote => {
                        use de_remote::transfer::{self as rt, Loc};
                        let locs: Vec<Loc> = items.iter().map(|p| Loc::parse(&p.to_string_lossy())).collect();
                        let to = Loc::parse(&dest.clone().unwrap_or_default().to_string_lossy());
                        let open = |id: &str| remotes.open(id);
                        let mut sess = rt::Sessions::new(&open);
                        e.upd.total = rt::measure(&locs, &mut sess)?;
                        let mut made = Vec::new();
                        let r = rt::copy(&locs, &to, kind == "move", &mut sess, &mut e, &mut made);
                        e.upd.created = made.iter().map(|p| s(p)).collect();
                        r
                    }
                    "copy" | "move" => {
                        e.upd.total = transfer::measure(&items).0;
                        let dest = dest.clone().unwrap();
                        if kind == "copy" {
                            let mut made = Vec::new();
                            let r = transfer::copy_items(&items, &dest, &mut e, copy, &mut made);
                            e.upd.created = made.iter().map(|p| s(p)).collect(); // partial too, so Undo can clean up a cancel
                            r
                        } else {
                            let mut moved = Vec::new();
                            let r = transfer::move_items(&items, &dest, &mut e, copy, &mut moved);
                            e.upd.moved = moved.iter().map(|(a, b)| (s(a), s(b))).collect(); // partial too, for Undo
                            r
                        }
                    }
                    "zip" => crate::tools::compress(&mut e, &items, de_core::archive::Format::Zip, 1, None),
                    _ => crate::tools::extract(&mut e, &items, "folder", None),
                }
            })();
            match r {
                Ok(()) => e.upd.state = "done",
                Err(err) if err.kind() == io::ErrorKind::Interrupted => e.upd.state = "cancelled",
                Err(err) => {
                    e.upd.state = "error";
                    e.upd.error = Some(err.to_string());
                    if kind == "copy" || kind == "move" { e.upd.items = items.iter().map(|p| s(p)).collect(); e.upd.dest = dest.as_deref().map(s); }
                }
            }
            e.upd.done = e.upd.done.max(if e.upd.state == "done" { e.upd.total } else { 0 });
            e.send(true);
            me.running.lock().unwrap().remove(&id);
        });
        Ok(id)
    }

    /// Runs `work` on its own thread as a job (archive tools): progress events, cancel, final state. Never asks about conflicts.
    pub(crate) fn run(self: &Arc<Self>, app: AppHandle, window: String, kind: String, label: String, work: impl FnOnce(&mut Emit) -> io::Result<()> + Send + 'static) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, answers) = mpsc::channel();
        self.running.lock().unwrap().insert(id, Running { cancel: cancel.clone(), answer: tx });
        let me = self.clone();
        std::thread::spawn(move || {
            let mut e = Emit { app, window, upd: JobUpdate { id, kind, label, state: "running", ..Default::default() }, last: Instant::now(), cancel, answers };
            e.send(true);
            match work(&mut e) {
                Ok(()) => e.upd.state = "done",
                Err(err) if err.kind() == io::ErrorKind::Interrupted => e.upd.state = "cancelled",
                Err(err) => { e.upd.state = "error"; e.upd.error = Some(err.to_string()); }
            }
            e.upd.done = e.upd.done.max(if e.upd.state == "done" { e.upd.total } else { 0 });
            e.send(true);
            me.running.lock().unwrap().remove(&id);
        });
        id
    }

    /// Folder sync (power.rs): runs a plan the user already previewed. Replaced and deleted files go to the Recycle Bin.
    pub fn start_sync(self: &Arc<Self>, app: AppHandle, window: String, left: PathBuf, right: PathBuf, actions: Vec<de_core::compare::Action>) -> Result<u64, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, answers) = mpsc::channel(); // sync never asks: its plan was previewed already
        self.running.lock().unwrap().insert(id, Running { cancel: cancel.clone(), answer: tx });
        let label = format!("Syncing {} and {}", name(&left), name(&right));
        let me = self.clone();
        std::thread::spawn(move || {
            let mut e = Emit { app, window, upd: JobUpdate { id, kind: "sync".into(), label, state: "running", ..Default::default() }, last: Instant::now(), cancel, answers };
            e.upd.total = de_core::compare::plan_bytes(&left, &right, &actions);
            e.send(true);
            let recycle = |p: &[PathBuf]| de_shell::recycle(p).map_err(io::Error::other);
            match de_core::compare::run(&left, &right, &actions, &mut e, &de_shell::native::copy_file, &recycle) {
                Ok(()) => { e.upd.state = "done"; e.upd.done = e.upd.total; }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => e.upd.state = "cancelled",
                Err(err) => { e.upd.state = "error"; e.upd.error = Some(err.to_string()); }
            }
            e.send(true);
            me.running.lock().unwrap().remove(&id);
        });
        Ok(id)
    }

    pub fn cancel(&self, id: u64) {
        if let Some(r) = self.running.lock().unwrap().get(&id) { r.cancel.store(true, Ordering::Relaxed); }
    }

    /// The conflict dialog's answer; `all` = "Do this for all remaining conflicts".
    pub fn answer(&self, id: u64, choice: Choice, all: bool) {
        if let Some(r) = self.running.lock().unwrap().get(&id) { let _ = r.answer.send((choice, all)); }
    }
}
