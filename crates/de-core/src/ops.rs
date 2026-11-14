//! File operations. All refuse to overwrite: an existing destination is an error, never silently replaced.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn exists_err(p: &Path) -> io::Error {
    io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", p.display()))
}

/// Rejects names that would escape the folder or that Windows can't store.
pub fn validate_name(name: &str) -> io::Result<()> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32)
        || reserved(name);
    if bad {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("\"{name}\" is not a valid name")));
    }
    Ok(())
}

/// Device names Windows won't store as files, with or without an extension ("CON", "nul.txt", "COM1").
fn reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}

pub fn create_dir(parent: &Path, name: &str) -> io::Result<PathBuf> {
    validate_name(name)?;
    let p = parent.join(name);
    fs::create_dir(&p)?; // fails with AlreadyExists on its own
    Ok(p)
}

pub fn rename(path: &Path, new_name: &str) -> io::Result<PathBuf> {
    validate_name(new_name)?;
    let mut to = path.with_file_name(new_name);
    // Name taken by another item: use the next free "Name (1).ext", like Explorer does.
    // Case-only renames ("a.txt" -> "A.txt") point at the same file on NTFS and stay as typed.
    if to.exists() && !to.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy()) {
        to = numbered(path.parent().unwrap_or(Path::new("")), new_name, 1);
    }
    fs::rename(path, &to)?;
    Ok(to)
}

/// Creates one folder per line; "a\b" (or "a/b") makes nested folders. Every name is checked before
/// anything is created. Returns the topmost folders that are new (what undo removes); existing ones are fine.
pub fn create_dirs(parent: &Path, lines: &[String]) -> io::Result<Vec<PathBuf>> {
    let paths: Vec<Vec<&str>> = lines
        .iter()
        .map(|l| l.split(['\\', '/']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .filter(|p| !p.is_empty())
        .collect();
    for part in paths.iter().flatten() { validate_name(part)?; }
    let mut made = Vec::new();
    for parts in paths {
        let mut p = parent.to_path_buf();
        for part in parts {
            p.push(part);
            match fs::create_dir(&p) {
                Ok(()) => { if !made.iter().any(|m: &PathBuf| p.starts_with(m)) { made.push(p.clone()); } }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && p.is_dir() => {}
                Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", p.display()))),
            }
        }
    }
    Ok(made)
}

/// Picks "name (2).ext", "name (3).ext"... when pasting into a folder that already has `name`.
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    numbered(dir, name, 2)
}

/// First "stem (n).ext" in `dir` that doesn't exist, counting from `from`.
fn numbered(dir: &Path, name: &str, from: u32) -> PathBuf {
    let path = Path::new(name);
    let (stem, ext) = match (path.file_stem(), path.extension()) {
        (Some(s), Some(e)) if !name.starts_with('.') => (s.to_string_lossy(), format!(".{}", e.to_string_lossy())),
        _ => (name.into(), String::new()),
    };
    (from..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap()
}

/// Removes items for good (callers confirm first). A link/junction is removed, never what it points to.
pub fn remove_forever(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths {
        let m = fs::symlink_metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
        let r = if m.file_type().is_symlink() {
            fs::remove_dir(p).or_else(|_| fs::remove_file(p))
        } else if m.is_dir() {
            fs::remove_dir_all(p)
        } else {
            fs::remove_file(p)
        };
        r.map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("de-ops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn names() {
        assert!(validate_name("ok.txt").is_ok());
        assert!(validate_name("console.txt").is_ok() && validate_name("COM0").is_ok());
        for bad in ["", "..", "a/b", "a\\b", "x:", "end.", "end ", "CON", "nul.txt", "com1", "LPT9.log", "aux "] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rename_and_mkdir() {
        let d = tmp("ops");
        create_dir(&d, "b").unwrap();
        assert!(create_dir(&d, "b").is_err());
        fs::write(d.join("x.txt"), b"x").unwrap();
        fs::write(d.join("y.txt"), b"y").unwrap();
        assert_eq!(free_name(&d, "x.txt"), d.join("x (2).txt"));
        assert_eq!(rename(&d.join("x.txt"), "y.txt").unwrap(), d.join("y (1).txt"), "taken name gets the next free number");
        rename(&d.join("y (1).txt"), "X.txt").unwrap();
        rename(&d.join("X.txt"), "x.txt").unwrap(); // case-only rename keeps the typed name
        assert!(d.join("x.txt").exists() && !d.join("x (1).txt").exists());
        rename(&d.join("x.txt"), "X.txt").unwrap();
        assert!(rename(&d.join("X.txt"), "bad/name").is_err());
        let lines = ["2024\\Jan", " 2024/Feb ", "", "b\\new", "Single"].map(String::from);
        assert_eq!(create_dirs(&d, &lines).unwrap(), [d.join("2024"), d.join("b\\new"), d.join("Single")]);
        assert!(d.join("2024/Feb").is_dir());
        assert!(create_dirs(&d, &["ok".into(), "a\\..\\x".into()]).is_err());
        assert!(!d.join("ok").exists(), "nothing created when one name is bad");
        fs::remove_dir_all(&d).unwrap();
    }
}
