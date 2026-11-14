//! Git awareness through the `git` CLI (no libgit2): find the repo, run `git status --porcelain=v2 -z`,
//! and turn its output into a status per item of one folder. No git installed = no info, silently.
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    Ignored,
    /// A folder with a change somewhere inside.
    Dirty,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Status {
    /// Branch name, or the short commit when detached.
    pub branch: String,
    /// Repo-relative paths with forward slashes; folders git reports whole end in '/'.
    pub entries: Vec<(String, State)>,
}

/// The working tree root above (or at) `dir`: the first folder with a `.git` (a folder, or a file for worktrees/submodules).
pub fn find_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

fn xy_state(xy: &str) -> State {
    let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
    if x == 'A' { State::Added } else if x == 'D' || y == 'D' { State::Deleted } else { State::Modified }
}

/// Parses `git status --porcelain=v2 -z --branch --ignored`.
pub fn parse(out: &str) -> Status {
    let mut s = Status::default();
    let mut oid = String::new();
    let mut recs = out.split('\0');
    while let Some(r) = recs.next() {
        // Fields before the path: "1" has 8, "2" has 9 (then the original path as the next record), "u" has 10.
        let path_after = |n: usize| r.splitn(n + 1, ' ').nth(n).unwrap_or("").to_string();
        let xy = r.get(2..4).unwrap_or("");
        match r.as_bytes().first() {
            Some(b'#') => {
                if let Some(b) = r.strip_prefix("# branch.head ") { s.branch = b.to_string(); }
                if let Some(o) = r.strip_prefix("# branch.oid ") { oid = o.chars().take(7).collect(); }
            }
            Some(b'1') => s.entries.push((path_after(8), xy_state(xy))),
            Some(b'2') => { s.entries.push((path_after(9), State::Renamed)); recs.next(); }
            Some(b'u') => s.entries.push((path_after(10), State::Conflicted)),
            Some(b'?') => s.entries.push((r[2..].to_string(), State::Untracked)),
            Some(b'!') => s.entries.push((r[2..].to_string(), State::Ignored)),
            _ => {}
        }
    }
    if s.branch == "(detached)" { s.branch = oid; }
    s
}

/// Runs git in `root`. None when git isn't installed or this isn't a repo it accepts.
pub fn status(root: &Path) -> Option<Status> {
    let mut c = Command::new("git");
    c.arg("-C").arg(root).args(["status", "--porcelain=v2", "-z", "--branch", "--ignored"]);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000); // CREATE_NO_WINDOW: no console flash
    let out = c.output().ok()?;
    out.status.success().then(|| parse(&String::from_utf8_lossy(&out.stdout)))
}

/// Status of each direct child of `rel_dir` (repo-relative, '/'-separated, "" = root), keyed by lowercase name.
/// `all` is set when the folder itself sits inside something git reports whole (an untracked or ignored folder).
pub fn children(s: &Status, rel_dir: &str) -> (HashMap<String, State>, Option<State>) {
    let prefix = if rel_dir.is_empty() { String::new() } else { format!("{}/", rel_dir.trim_end_matches('/')) };
    let (pl, mut map, mut all) = (prefix.to_lowercase(), HashMap::new(), None);
    for (p, st) in &s.entries {
        let l = p.to_lowercase();
        if let Some(rest) = l.strip_prefix(&pl) {
            let rest = rest.trim_end_matches('/');
            if rest.is_empty() { all = Some(*st); continue; }
            match rest.split_once('/') {
                None => { map.insert(rest.to_string(), *st); }
                // Something inside a child folder changed; ignored files inside don't count as a change.
                Some((top, _)) if *st != State::Ignored => { map.entry(top.to_string()).or_insert(State::Dirty); }
                _ => {}
            }
        } else if l.ends_with('/') && pl.starts_with(&l) {
            all = Some(*st);
        }
    }
    (map, all)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "# branch.oid 0123456789abcdef\0# branch.head main\0\
1 .M N... 100644 100644 100644 aaa bbb src/main.rs\0\
1 A. N... 000000 100644 100644 000 ccc src/new file.rs\0\
1 .D N... 100644 100644 000000 aaa aaa gone.txt\0\
2 R. N... 100644 100644 100644 aaa aaa R100 docs/b.md\0docs/a.md\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? notes/\0\
! target/\0\
! src/debug.log\0";

    #[test]
    fn parses_porcelain_v2() {
        let s = parse(OUT);
        assert_eq!(s.branch, "main");
        assert_eq!(s.entries, [
            ("src/main.rs".into(), State::Modified), ("src/new file.rs".into(), State::Added), ("gone.txt".into(), State::Deleted),
            ("docs/b.md".into(), State::Renamed), ("conflict.txt".into(), State::Conflicted), ("notes/".into(), State::Untracked),
            ("target/".into(), State::Ignored), ("src/debug.log".into(), State::Ignored),
        ]);
        assert_eq!(parse("# branch.oid 0123456789abcdef\0# branch.head (detached)\0").branch, "0123456");
    }

    #[test]
    fn folds_to_children() {
        let s = parse(OUT);
        let (root, all) = children(&s, "");
        assert_eq!(all, None);
        assert_eq!(root.get("src"), Some(&State::Dirty));
        assert_eq!(root.get("notes"), Some(&State::Untracked));
        assert_eq!(root.get("target"), Some(&State::Ignored));
        assert_eq!(root.get("conflict.txt"), Some(&State::Conflicted));
        let (src, _) = children(&s, "Src"); // Windows: case-insensitive
        assert_eq!(src.get("main.rs"), Some(&State::Modified));
        assert_eq!(src.get("debug.log"), Some(&State::Ignored));
        // Inside an untracked folder everything is untracked.
        assert_eq!(children(&s, "notes/deep").1, Some(State::Untracked));
        assert_eq!(children(&s, "docs").0.get("b.md"), Some(&State::Renamed));
    }

    #[test]
    fn finds_repo_root() {
        let d = std::env::temp_dir().join("DeltaAgent-power").join(format!("git-{}", std::process::id()));
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::create_dir_all(d.join("a\\b")).unwrap();
        assert_eq!(find_root(&d.join("a\\b")), Some(d.clone()));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
