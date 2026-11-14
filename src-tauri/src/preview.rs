//! Preview pane backend: bounded text/zip reads, and the `raw://` protocol.
//! raw serves a file's own bytes for PDF, audio/video and fonts only (never HTML, SVG or scripts, so nothing on
//! disk can run in the page), in HTTP Range chunks so seeking works and a 4 GB video never sits in memory.
//! URL: http://raw.localhost/<url-encoded path>?m=<mtime>  (mtime only busts caches)
use de_core::preview;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tauri::http::{header, Request, Response};

/// Largest slice sent per request; players ask for the next range as they go.
const CHUNK: u64 = 4 * 1024 * 1024;
/// A plain GET (no Range) of a file up to this size gets the whole file (the PDF viewer does this).
const WHOLE: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn preview_text(path: PathBuf) -> Result<preview::TextPreview, String> {
    crate::blocking(move || preview::text(&path, preview::TEXT_LIMIT).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn preview_zip(path: PathBuf) -> Result<preview::ZipListing, String> {
    crate::blocking(move || preview::zip_entries(&path, preview::ZIP_LIMIT).map_err(|e| e.to_string())).await
}

/// Items directly inside a folder.
#[tauri::command]
pub async fn dir_count(path: PathBuf) -> Result<usize, String> {
    crate::blocking(move || Ok(std::fs::read_dir(&path).map_err(|e| e.to_string())?.count())).await
}

pub fn handle(req: Request<Vec<u8>>, reply: impl FnOnce(Response<Vec<u8>>) + Send + 'static) {
    std::thread::spawn(move || reply(serve(&req).unwrap_or_else(status)));
}

fn serve(req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, u16> {
    let path = percent_encoding::percent_decode_str(req.uri().path().trim_start_matches('/')).decode_utf8().map_err(|_| 400u16)?;
    let path = PathBuf::from(path.as_ref());
    if !path.is_absolute() { return Err(400); }
    let mime = raw_mime(&path).ok_or(403u16)?;
    let mut f = File::open(&path).map_err(|_| 404u16)?;
    let len = f.metadata().map_err(|_| 404u16)?.len();
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let (start, end, partial) = match range {
        Some(r) => {
            let (s, e) = parse_range(r, len).ok_or(416u16)?;
            (s, e.min(s + CHUNK - 1), true)
        }
        None if len <= WHOLE => (0, len.saturating_sub(1), false),
        // shortcut: a plain GET of a huge file gets its first chunk as 206; media players then switch to ranges. A >64 MB PDF won't open.
        None => (0, CHUNK - 1, true),
    };
    let mut body = vec![0; if len == 0 { 0 } else { (end - start + 1) as usize }];
    f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut body)).map_err(|_| 500u16)?;
    let mut res = Response::builder()
        .status(if partial { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len())
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"); // FontFace fetches fonts with CORS
    if partial { res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")); }
    Ok(res.body(body).unwrap())
}

/// First range of a `Range: bytes=...` header, clamped to the file. None = unsatisfiable (416).
pub fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 { return None; }
    let (s, e) = if a.is_empty() {
        let n: u64 = b.parse().ok()?; // suffix: the last n bytes
        if n == 0 { return None; }
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        (s, if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) })
    };
    (s <= e && s < len).then_some((s, e))
}

pub fn raw_mime(p: &Path) -> Option<&'static str> {
    Some(match p.extension()?.to_string_lossy().to_lowercase().as_str() {
        "pdf" => "application/pdf",
        "mp4" | "m4v" | "mov" => "video/mp4", // WebView2 plays H.264 .mov files when told they're mp4
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => return None,
    })
}

fn status(code: u16) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-500", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=5-9, 20-30", 100), Some((5, 9)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=9-5", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    #[test]
    fn serves_partial_content_and_refuses_other_types() {
        let d = std::env::temp_dir().join("DeltaAgent-preview-unit");
        std::fs::create_dir_all(&d).unwrap();
        let mp3 = d.join("a.mp3");
        std::fs::write(&mp3, b"0123456789").unwrap();
        std::fs::write(d.join("a.html"), b"<script>").unwrap();
        let url = |p: &Path| format!("http://raw.localhost/{}", percent_encoding::utf8_percent_encode(&p.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC));
        let req = |p: &Path, range: Option<&str>| {
            let mut b = Request::builder().uri(url(p));
            if let Some(r) = range { b = b.header(header::RANGE, r); }
            serve(&b.body(Vec::new()).unwrap())
        };
        let r = req(&mp3, Some("bytes=2-4")).unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), b"234");
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        let r = req(&mp3, None).unwrap();
        assert_eq!((r.status().as_u16(), r.body().len()), (200, 10));
        assert_eq!(req(&mp3, Some("bytes=50-")).unwrap_err(), 416);
        assert_eq!(req(&d.join("a.html"), None).unwrap_err(), 403);
        std::fs::remove_dir_all(&d).ok();
    }
}
