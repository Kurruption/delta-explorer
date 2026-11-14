//! Bounded reads for the preview pane: only the start of a text file, only the directory of a zip.
use serde::Serialize;
use std::{fs, io::{self, Read}, path::Path};

pub const TEXT_LIMIT: usize = 256 * 1024;
pub const ZIP_LIMIT: usize = 5_000;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub binary: bool,
    /// The file is longer than what was read.
    pub truncated: bool,
}

/// The first `limit` bytes as text (UTF-8 lossy, or UTF-16 when it has a BOM, as .reg and some logs do).
pub fn text(p: &Path, limit: usize) -> io::Result<TextPreview> {
    let mut buf = Vec::new();
    fs::File::open(p)?.take(limit as u64 + 1).read_to_end(&mut buf)?;
    let truncated = buf.len() > limit;
    buf.truncate(limit);
    let utf16 = match buf.get(..2) {
        Some([0xFF, 0xFE]) => Some(false),
        Some([0xFE, 0xFF]) => Some(true),
        _ => None,
    };
    if let Some(be) = utf16 {
        let units: Vec<u16> = buf[2..].chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) }).collect();
        return Ok(TextPreview { text: String::from_utf16_lossy(&units), binary: false, truncated });
    }
    let body = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
    if body[..body.len().min(8192)].contains(&0) {
        return Ok(TextPreview { text: String::new(), binary: true, truncated });
    }
    let mut body = body;
    if truncated {
        // Don't end on half a character: drop a trailing partial UTF-8 sequence.
        while let [rest @ .., b] = body { if b & 0xC0 == 0x80 { body = rest } else { break } }
        if let [rest @ .., b] = body { if *b >= 0xC0 { body = rest } }
    }
    Ok(TextPreview { text: String::from_utf8_lossy(body).into_owned(), binary: false, truncated })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipItem {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipListing {
    pub entries: Vec<ZipItem>,
    /// Entries in the archive (may be more than listed).
    pub total: usize,
}

/// The archive's table of contents (read from its central directory; nothing is decompressed).
pub fn zip_entries(p: &Path, limit: usize) -> io::Result<ZipListing> {
    let mut z = zip::ZipArchive::new(fs::File::open(p)?).map_err(io::Error::other)?;
    let total = z.len();
    let mut entries = Vec::with_capacity(total.min(limit));
    for i in 0..total.min(limit) {
        let f = z.by_index_raw(i).map_err(io::Error::other)?;
        entries.push(ZipItem { name: f.name().map_or_else(|_| "(unreadable name)".into(), |n| n.into_owned()), size: f.size(), is_dir: f.is_dir() });
    }
    Ok(ZipListing { entries, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join("DeltaAgent-preview");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn text_reads_utf8_utf16_and_flags_binary() {
        let t = text(&tmp("a.txt", "\u{FEFF}héllo".as_bytes()), 100).unwrap();
        assert_eq!((t.text.as_str(), t.binary, t.truncated), ("héllo", false, false));
        let mut le = vec![0xFF, 0xFE];
        le.extend("Windows Registry".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(text(&tmp("b.reg", &le), 100).unwrap().text, "Windows Registry");
        assert!(text(&tmp("c.bin", b"MZ\0\0\x90"), 100).unwrap().binary);
    }

    #[test]
    fn text_truncates_on_a_char_boundary() {
        let t = text(&tmp("d.txt", "abé".as_bytes()), 3).unwrap(); // 'é' is 2 bytes: the cut lands inside it
        assert_eq!((t.text.as_str(), t.truncated), ("ab", true));
    }

    #[test]
    fn zip_lists_entries_without_extracting() {
        let p = std::env::temp_dir().join("DeltaAgent-preview").join("e.zip");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut z = zip::ZipWriter::new(fs::File::create(&p).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.add_directory("docs/", o).unwrap();
        z.start_file("docs/a.txt", o).unwrap();
        z.write_all(b"12345").unwrap();
        z.finish().unwrap();
        let l = zip_entries(&p, 1).unwrap();
        assert_eq!(l.total, 2);
        assert_eq!(l.entries.len(), 1);
        assert!(l.entries[0].is_dir);
        let l = zip_entries(&p, 10).unwrap();
        assert_eq!((l.entries[1].name.as_str(), l.entries[1].size), ("docs/a.txt", 5));
    }
}
