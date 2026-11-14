//! `thumb://` protocol: thumbnails and real icons as PNG, served straight to <img> tags (no JSON, no base64).
//! URL: http://thumb.localhost/<url-encoded path>?s=<px>&k=t|i&m=<mtime>  (mtime only busts caches)
use de_shell::thumb::{self, Kind};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
};
use tauri::http::{Request, Response};

type Key = (PathBuf, u32, Kind, u64);
type Reply = Box<dyn FnOnce(Response<Vec<u8>>) + Send>;

const WORKERS: usize = 4;
const CACHE_BYTES: usize = 64 * 1024 * 1024;

/// Byte-budgeted LRU. Failures are cached as empty entries so a file without a preview isn't retried on every scroll.
#[derive(Default)]
struct Cache {
    map: HashMap<Key, Arc<Vec<u8>>>,
    order: VecDeque<Key>,
    bytes: usize,
}
impl Cache {
    fn get(&mut self, k: &Key) -> Option<Arc<Vec<u8>>> {
        let v = self.map.get(k)?.clone();
        // shortcut: O(n) recency bump; fine for a few thousand entries, use an intrusive list if profiling says so.
        if let Some(i) = self.order.iter().position(|x| x == k) {
            let k = self.order.remove(i).unwrap();
            self.order.push_back(k);
        }
        Some(v)
    }
    fn put(&mut self, k: Key, v: Arc<Vec<u8>>) {
        self.bytes += v.len() + 64;
        if let Some(old) = self.map.insert(k.clone(), v) {
            self.bytes -= old.len() + 64;
        } else {
            self.order.push_back(k);
        }
        while self.bytes > CACHE_BYTES {
            let Some(k) = self.order.pop_front() else { break };
            if let Some(v) = self.map.remove(&k) { self.bytes -= v.len() + 64; }
        }
    }
}

/// Newest request first: while scrolling, what's on screen now matters more than rows already scrolled past.
#[derive(Default)]
struct Queue {
    jobs: Mutex<Vec<(Key, Reply)>>,
    ready: Condvar,
}

pub struct Thumbs {
    cache: Mutex<Cache>,
    queue: Queue,
}

impl Thumbs {
    pub fn start() -> Arc<Self> {
        let t = Arc::new(Thumbs { cache: Mutex::default(), queue: Queue::default() });
        for _ in 0..WORKERS {
            let t = t.clone();
            thread::spawn(move || loop {
                let (key, reply) = {
                    let mut q = t.queue.jobs.lock().unwrap();
                    while q.is_empty() { q = t.queue.ready.wait(q).unwrap(); }
                    q.pop().unwrap()
                };
                let cached = t.cache.lock().unwrap().get(&key); // may have been made while queued
                let png = cached.unwrap_or_else(|| {
                    let png = Arc::new(thumb::image(&key.0, key.1, key.2).unwrap_or_default());
                    // "No preview" is a normal answer for many files, so remember it. An icon failure is a
                    // transient shell hiccup (busy COM, file being written): don't cache it, let it retry.
                    if !(png.is_empty() && key.2 == Kind::Icon) { t.cache.lock().unwrap().put(key, png.clone()); }
                    png
                });
                reply(respond(&png));
            });
        }
        t
    }

    pub fn handle(&self, req: Request<Vec<u8>>, reply: Reply) {
        if req.uri().query().unwrap_or("").split('&').any(|kv| kv == "k=f") {
            thread::spawn(move || reply(full_image(&req))); // big reads stay off the thumbnail workers
            return;
        }
        let Some(key) = parse(&req) else { return reply(status(400)) };
        if let Some(png) = self.cache.lock().unwrap().get(&key) {
            return reply(respond(&png));
        }
        self.queue.jobs.lock().unwrap().push((key, reply));
        self.queue.ready.notify_one();
    }
}

fn parse(req: &Request<Vec<u8>>) -> Option<Key> {
    let uri = req.uri();
    let path = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/')).decode_utf8().ok()?;
    let (mut size, mut kind, mut mtime) = (96, Kind::Thumbnail, 0);
    for kv in uri.query().unwrap_or("").split('&') {
        match kv.split_once('=') {
            Some(("s", v)) => size = v.parse().ok()?,
            Some(("k", "i")) => kind = Kind::Icon,
            Some(("m", v)) => mtime = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    // Only plain absolute local paths; nothing relative, no huge renders.
    let p = PathBuf::from(path.as_ref());
    (p.is_absolute() && (16..=512).contains(&size)).then_some((p, size, kind, mtime))
}

/// The original image file, for the photo viewer. Only image types, so the page can't read arbitrary files.
fn full_image(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = percent_encoding::percent_decode_str(req.uri().path().trim_start_matches('/')).decode_utf8().ok().map(|p| PathBuf::from(p.as_ref())) else {
        return status(400);
    };
    let Some(mime) = image_mime(&path) else { return status(403) };
    match std::fs::read(&path) {
        // CORS so the viewer's canvas isn't "tainted" and can export edits.
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => status(404),
    }
}

pub fn image_mime(p: &std::path::Path) -> Option<&'static str> {
    Some(match p.extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn status(code: u16) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

fn respond(png: &[u8]) -> Response<Vec<u8>> {
    if png.is_empty() {
        return status(404); // no preview: the UI keeps its Delta icon
    }
    Response::builder()
        .header("Content-Type", "image/png")
        .header("Cache-Control", "max-age=31536000, immutable")
        .body(png.to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls_and_rejects_bad_ones() {
        let r = |u: &str| Request::builder().uri(u).body(Vec::new()).unwrap();
        let k = parse(&r("http://thumb.localhost/C%3A%5CPics%5Ca%20b.png?s=128&k=i&m=5")).unwrap();
        assert_eq!(k, (PathBuf::from(r"C:\Pics\a b.png"), 128, Kind::Icon, 5));
        assert!(parse(&r("http://thumb.localhost/relative.png?s=96")).is_none());
        assert!(parse(&r("http://thumb.localhost/C%3A%5Cx.png?s=9000")).is_none());
    }

    #[test]
    fn cache_evicts_oldest_over_budget() {
        let mut c = Cache::default();
        let k = |n: u64| (PathBuf::from("C:\\x"), 96, Kind::Thumbnail, n);
        let big = Arc::new(vec![0u8; CACHE_BYTES / 3]); // three fit only with overhead, so the third put evicts one
        c.put(k(1), big.clone());
        c.put(k(2), big.clone());
        c.get(&k(1)); // 1 is now most recent
        c.put(k(3), big);
        assert!(c.map.contains_key(&k(1)) && c.map.contains_key(&k(3)) && !c.map.contains_key(&k(2)));
    }
}
