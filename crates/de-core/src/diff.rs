//! Two-file compare: a side-by-side line diff for text, size + SHA-256 for anything else.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io, io::Read, path::Path, time::Duration};

/// Bigger files get only the size/hash comparison (a diff that size isn't readable anyway).
pub const MAX_TEXT: u64 = 4 << 20;
/// Rows sent to the UI at most.
pub const MAX_ROWS: usize = 20_000;
/// Unchanged lines kept around each change; longer unchanged runs fold into one "skip" row.
pub const CONTEXT: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// eq | chg | del | add | skip (then `l` is how many unchanged lines are folded)
    pub tag: &'static str,
    /// 1-based line numbers on each side.
    pub l: Option<usize>,
    pub r: Option<usize>,
    pub a: String,
    pub b: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub text: bool,
    pub rows: Vec<Row>,
    pub truncated: bool,
    pub size_a: u64,
    pub size_b: u64,
    pub hash_a: String,
    pub hash_b: String,
    pub identical: bool,
    pub added: usize,
    pub removed: usize,
}

pub fn sha256(p: &Path) -> io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Text if it's valid UTF-8 (BOM allowed) with no NUL bytes.
fn as_text(bytes: &[u8]) -> Option<&str> {
    let b = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if b.contains(&0) { return None; }
    std::str::from_utf8(b).ok()
}

fn lines(s: &str) -> Vec<&str> {
    s.lines().collect()
}

/// Aligned side-by-side rows. Changed blocks pair old and new lines ("chg"); leftovers are del/add.
pub fn line_rows(a: &str, b: &str, context: usize) -> Vec<Row> {
    let (la, lb) = (lines(a), lines(b));
    let d = similar::TextDiff::configure().timeout(Duration::from_secs(3)).diff_slices(&la, &lb);
    let mut rows = Vec::new();
    let row = |tag, i: Option<usize>, j: Option<usize>| Row {
        tag, l: i.map(|i| i + 1), r: j.map(|j| j + 1),
        a: i.map(|i| la[i].to_string()).unwrap_or_default(), b: j.map(|j| lb[j].to_string()).unwrap_or_default(),
    };
    let ops = d.ops();
    let mut k = 0;
    while k < ops.len() {
        let (_, old, new) = ops[k].as_tag_tuple();
        if matches!(ops[k], similar::DiffOp::Equal { .. }) {
            for x in 0..old.len() { rows.push(row("eq", Some(old.start + x), Some(new.start + x))); }
            k += 1;
            continue;
        }
        // Neighbouring delete/insert ops are one changed block (their ranges are contiguous).
        let (mut oe, mut ne) = (old.end, new.end);
        k += 1;
        while k < ops.len() && !matches!(ops[k], similar::DiffOp::Equal { .. }) {
            let (_, o, n) = ops[k].as_tag_tuple();
            (oe, ne) = (o.end, n.end);
            k += 1;
        }
        let (n, m) = (oe - old.start, ne - new.start);
        for x in 0..n.max(m) {
            let (i, j) = ((x < n).then(|| old.start + x), (x < m).then(|| new.start + x));
            rows.push(row(if i.is_some() && j.is_some() { "chg" } else if i.is_some() { "del" } else { "add" }, i, j));
        }
    }
    fold(rows, context)
}

/// Folds long runs of unchanged rows, keeping `context` rows next to each change.
fn fold(rows: Vec<Row>, context: usize) -> Vec<Row> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        if rows[i].tag != "eq" { out.push(rows[i].clone()); i += 1; continue; }
        let end = rows[i..].iter().position(|r| r.tag != "eq").map_or(rows.len(), |p| i + p);
        let keep_head = if i == 0 { 0 } else { context };
        let keep_tail = if end == rows.len() { 0 } else { context };
        if end - i > keep_head + keep_tail + 1 {
            out.extend_from_slice(&rows[i..i + keep_head]);
            out.push(Row { tag: "skip", l: Some(end - i - keep_head - keep_tail), r: None, a: String::new(), b: String::new() });
            out.extend_from_slice(&rows[end - keep_tail..end]);
        } else {
            out.extend_from_slice(&rows[i..end]);
        }
        i = end;
    }
    out
}

pub fn diff_files(a: &Path, b: &Path) -> io::Result<FileDiff> {
    fn at(p: &Path) -> impl FnOnce(io::Error) -> io::Error + '_ { move |e| io::Error::new(e.kind(), format!("{}: {e}", p.display())) }
    let (size_a, size_b) = (fs::metadata(a).map_err(at(a))?.len(), fs::metadata(b).map_err(at(b))?.len());
    let (hash_a, hash_b) = (sha256(a).map_err(at(a))?, sha256(b).map_err(at(b))?);
    let mut d = FileDiff { text: false, rows: vec![], truncated: false, size_a, size_b, identical: hash_a == hash_b, hash_a, hash_b, added: 0, removed: 0 };
    if size_a <= MAX_TEXT && size_b <= MAX_TEXT {
        let (ba, bb) = (fs::read(a)?, fs::read(b)?);
        if let (Some(ta), Some(tb)) = (as_text(&ba), as_text(&bb)) {
            d.text = true;
            d.rows = line_rows(ta, tb, CONTEXT);
            d.added = d.rows.iter().filter(|r| r.tag == "add" || r.tag == "chg").count();
            d.removed = d.rows.iter().filter(|r| r.tag == "del" || r.tag == "chg").count();
            d.truncated = d.rows.len() > MAX_ROWS;
            d.rows.truncate(MAX_ROWS);
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(rows: &[Row]) -> Vec<&str> { rows.iter().map(|r| r.tag).collect() }

    #[test]
    fn pairs_changes_and_folds_context() {
        let a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nold\n12\n";
        let b = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nnew\nextra\n12\n";
        let rows = line_rows(a, b, 2);
        assert_eq!(tags(&rows), ["skip", "eq", "eq", "chg", "add", "eq"]);
        assert_eq!(rows[0].l, Some(8));
        assert_eq!((rows[3].a.as_str(), rows[3].b.as_str(), rows[3].l, rows[3].r), ("old", "new", Some(11), Some(11)));
        assert_eq!((rows[4].l, rows[4].r), (None, Some(12)));
        assert!(line_rows("same\n", "same\n", 3).iter().all(|r| r.tag == "eq"));
        assert_eq!(tags(&line_rows("a\nb\n", "b\n", 3)), ["del", "eq"]);
        // CRLF and LF files with the same text are the same lines.
        assert_eq!(tags(&line_rows("x\r\ny\r\n", "x\ny\n", 3)), ["skip"]); // all unchanged: one folded row
    }

    #[test]
    fn text_vs_binary() {
        let d = std::env::temp_dir().join("DeltaAgent-power").join(format!("diff-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.txt"), "hello\nworld\n").unwrap();
        fs::write(d.join("b.txt"), "hello\nthere\n").unwrap();
        fs::write(d.join("a.bin"), [0u8, 1, 2]).unwrap();
        fs::write(d.join("b.bin"), [0u8, 1, 2]).unwrap();
        let t = diff_files(&d.join("a.txt"), &d.join("b.txt")).unwrap();
        assert!(t.text && !t.identical && t.added == 1 && t.removed == 1);
        let b = diff_files(&d.join("a.bin"), &d.join("b.bin")).unwrap();
        assert!(!b.text && b.identical && b.rows.is_empty());
        assert_eq!(sha256(&d.join("a.txt")).unwrap().len(), 64);
        fs::remove_dir_all(&d).unwrap();
    }
}
