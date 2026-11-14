//! Filesystem core for Delta Explorer. No UI or Tauri dependency.
pub mod details;
pub mod elevated;
pub mod ops;
pub mod rename;
pub mod transfer;
pub mod preview;
pub mod compare;
pub mod diff;
pub mod git;
pub mod meta;
pub mod archive;
pub mod hash;
pub mod dupes;
pub mod storage;
pub mod cleaner;

use serde::{Deserialize, Serialize};
use std::{io, path::Path, time::UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    #[default]
    Name,
    Modified,
    Size,
    Kind,
    Created,
    Accessed,
    Attrs,
}

/// Folders always stay on top (like Explorer); `desc` flips the order within each group.
pub fn sort(entries: &mut [Entry], key: SortKey, desc: bool) {
    sort_by(entries, &[(key, desc)]);
}

/// Case-insensitive compare without allocating (sorting 100k names stays fast).
fn cmp_ci(a: &str, b: &str) -> std::cmp::Ordering {
    a.chars().flat_map(char::to_lowercase).cmp(b.chars().flat_map(char::to_lowercase))
}

/// Multi-column sort (Shift+click a second header): each key breaks ties of the one before; name is the final tiebreak.
pub fn sort_by(entries: &mut [Entry], keys: &[(SortKey, bool)]) {
    fn ext(e: &Entry) -> &str { e.name.rsplit_once('.').map_or("", |(_, x)| x) }
    entries.sort_by(|a, b| {
        let mut o = b.is_dir.cmp(&a.is_dir);
        for &(key, desc) in keys {
            if o.is_ne() { break; }
            let k = match key {
                SortKey::Name => cmp_ci(&a.name, &b.name),
                SortKey::Modified => a.modified.cmp(&b.modified),
                SortKey::Size => a.size.cmp(&b.size),
                SortKey::Kind => cmp_ci(ext(a), ext(b)),
                SortKey::Created => a.created.cmp(&b.created),
                SortKey::Accessed => a.accessed.cmp(&b.accessed),
                SortKey::Attrs => a.attrs.cmp(&b.attrs),
            };
            o = if desc { k.reverse() } else { k };
        }
        o.then_with(|| cmp_ci(&a.name, &b.name))
    });
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
}

/// The path as people write it: no `\\?\` prefix, and `\\?\UNC\server\share` back to `\\server\share`.
pub fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since Unix epoch; 0 if unknown.
    pub modified: u64,
    /// Hidden or system attribute set (Explorer hides these by default).
    pub hidden: bool,
    /// Seconds since Unix epoch; 0 if unknown. Same metadata call as `modified` (FindFirstFile data on Windows).
    pub created: u64,
    pub accessed: u64,
    /// Raw Windows file attributes (R 0x1, H 0x2, S 0x4, A 0x20).
    pub attrs: u32,
}

fn secs(t: io::Result<std::time::SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

impl Entry {
    /// `attrs` come from the item itself (a link's own attributes); times and size from `m` (its target if followed).
    pub fn from_meta(name: String, m: &std::fs::Metadata, attrs: u32) -> Entry {
        Entry {
            name,
            is_dir: m.is_dir(),
            size: if m.is_dir() { 0 } else { m.len() },
            modified: secs(m.modified()),
            hidden: attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0,
            created: secs(m.created()),
            accessed: secs(m.accessed()),
            attrs,
        }
    }
}

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

/// Lists one directory, sorted folders-first then case-insensitive by name.
/// `std::fs` is used deliberately: on Windows it reads FindFirstFile data, benchmarked as fast as raw Win32 (docs/ARCHITECTURE.md).
pub fn list_dir(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut out: Vec<Entry> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().ends_with(archive::PARTIAL)) // archives still being written
        .filter_map(|e| {
            let mut m = e.metadata().ok()?; // entries that vanish mid-listing are skipped
            let attrs = std::os::windows::fs::MetadataExt::file_attributes(&m);
            // Junctions/symlinks report as links; follow them so a linked folder shows as a folder.
            if m.file_type().is_symlink() {
                if let Ok(t) = std::fs::metadata(e.path()) { m = t; }
            }
            Some(Entry::from_meta(e.file_name().to_string_lossy().into_owned(), &m, attrs))
        })
        .collect();
    out.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(out)
}

/// A window into a listing, so the UI never receives the whole directory at once.
#[derive(Debug, Serialize)]
pub struct Page<'a> {
    pub total: usize,
    pub offset: usize,
    pub entries: &'a [Entry],
}

/// What the UI shows: drops hidden/system items unless asked, then applies the search box's case-insensitive name filter.
pub fn filter(entries: &[Entry], q: &str, show_hidden: bool) -> Vec<Entry> {
    let q = q.to_lowercase();
    entries.iter().filter(|e| (show_hidden || !e.hidden) && e.name.to_lowercase().contains(&q)).cloned().collect()
}

pub fn page(entries: &[Entry], offset: usize, limit: usize) -> Page<'_> {
    let start = offset.min(entries.len());
    let end = start.saturating_add(limit).min(entries.len());
    Page { total: entries.len(), offset: start, entries: &entries[start..end] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_paths() {
        assert_eq!(display(Path::new(r"\\?\C:\Users")), r"C:\Users");
        assert_eq!(display(Path::new(r"\\?\UNC\nas\share\x")), r"\\nas\share\x");
        assert_eq!(display(Path::new(r"\\nas\share")), r"\\nas\share");
    }

    #[test]
    fn lists_sorted_and_pages() {
        let d = std::env::temp_dir().join(format!("de-core-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("zdir")).unwrap();
        std::fs::write(d.join("B.txt"), b"12").unwrap();
        std::fs::write(d.join("a.txt"), b"1").unwrap();

        let l = list_dir(&d).unwrap();
        let names: Vec<_> = l.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zdir", "a.txt", "B.txt"]);
        assert_eq!(l[2].size, 2);

        let mut s = l.clone();
        sort(&mut s, SortKey::Size, true);
        assert_eq!(s.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["zdir", "B.txt", "a.txt"]);

        // Secondary key breaks ties of the first; name breaks the rest.
        let mut t = l.clone();
        for x in &mut t { x.modified = 7; x.attrs = 0; }
        t[1].attrs = 1;
        sort_by(&mut t, &[(SortKey::Modified, false), (SortKey::Attrs, true)]);
        assert_eq!(t.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["zdir", "a.txt", "B.txt"]);
        t[1].attrs = 0; t[2].attrs = 1;
        sort_by(&mut t, &[(SortKey::Modified, false), (SortKey::Attrs, true)]);
        assert_eq!(t.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["zdir", "B.txt", "a.txt"]);
        assert!(l[1].created > 0 && l[1].attrs & 0x10 == 0);

        assert_eq!(filter(&l, "TXT", true).len(), 2);
        let mut h = l.clone();
        h[1].hidden = true;
        assert_eq!(filter(&h, "", false).len(), 2);
        assert_eq!(filter(&h, "", true).len(), 3);

        let p = page(&l, 1, 10);
        assert_eq!((p.total, p.offset, p.entries.len()), (3, 1, 2));
        assert_eq!(page(&l, 99, 10).entries.len(), 0);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
