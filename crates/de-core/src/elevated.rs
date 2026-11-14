//! "Try as administrator": the single file operation an elevated helper process may run, and the strict
//! checks it passes first. The helper is the same exe started with `--elevated-op <request.json>`; it does
//! exactly one of these operations and nothing else (no commands, no scripts).
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Copy,
    Move,
    /// To the Recycle Bin.
    Recycle,
    /// Permanently (the UI has already asked).
    Delete,
    Rename,
    /// New folder `name` inside `items[0]`.
    Mkdir,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub op: Op,
    pub items: Vec<PathBuf>,
    #[serde(default)]
    pub dest: Option<PathBuf>,
    #[serde(default)]
    pub name: Option<String>,
}

/// What the helper reports back (written next to the request as `<request>.result.json`).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    pub error: Option<String>,
    pub created: Vec<String>,
    pub moved: Vec<(String, String)>,
}

pub const MAX_ITEMS: usize = 10_000;

/// A full, plain path: drive or UNC root, no "." / ".." tricks, not a drive root itself.
fn plain(p: &Path, allow_root: bool) -> Result<(), String> {
    let mut parts = p.components();
    let rooted = matches!(parts.next(), Some(Component::Prefix(_))) && matches!(parts.next(), Some(Component::RootDir));
    if !rooted {
        return Err(format!("not a full path: {}", p.display()));
    }
    if p.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return Err(format!("path may not contain . or ..: {}", p.display()));
    }
    if !allow_root && p.parent().is_none() {
        return Err(format!("refusing to change a drive root: {}", p.display()));
    }
    Ok(())
}

/// Rejects anything that isn't exactly one well-formed operation.
pub fn validate(r: &Request) -> Result<(), String> {
    if r.items.is_empty() || r.items.len() > MAX_ITEMS {
        return Err("expected 1 to 10000 items".into());
    }
    let one = r.items.len() == 1;
    let name = |need: bool| match (&r.name, need) {
        (Some(n), true) => crate::ops::validate_name(n).map_err(|e| e.to_string()),
        (None, false) => Ok(()),
        (None, true) => Err("missing name".to_string()),
        (Some(_), false) => Err("unexpected name".to_string()),
    };
    match r.op {
        Op::Copy | Op::Move => {
            let d = r.dest.as_deref().ok_or("missing destination")?;
            plain(d, true)?;
            name(false)?;
        }
        Op::Recycle | Op::Delete => {
            if r.dest.is_some() { return Err("unexpected destination".into()); }
            name(false)?;
        }
        Op::Rename | Op::Mkdir => {
            if !one { return Err("expected exactly one item".into()); }
            if r.dest.is_some() { return Err("unexpected destination".into()); }
            name(true)?;
        }
    }
    // A new folder goes inside items[0], so a drive root is fine there; everything else changes the item itself.
    for p in &r.items { plain(p, r.op == Op::Mkdir || r.op == Op::Copy)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(op: Op, items: &[&str], dest: Option<&str>, name: Option<&str>) -> Request {
        Request { op, items: items.iter().map(PathBuf::from).collect(), dest: dest.map(PathBuf::from), name: name.map(String::from) }
    }

    #[test]
    fn accepts_well_formed() {
        assert!(validate(&req(Op::Copy, &[r"C:\a.txt"], Some(r"C:\Program Files\X"), None)).is_ok());
        assert!(validate(&req(Op::Move, &[r"\\nas\share\a"], Some(r"D:\"), None)).is_ok());
        assert!(validate(&req(Op::Recycle, &[r"C:\Program Files\Old"], None, None)).is_ok());
        assert!(validate(&req(Op::Rename, &[r"C:\x\a.txt"], None, Some("b.txt"))).is_ok());
        assert!(validate(&req(Op::Mkdir, &[r"C:\"], None, Some("New folder"))).is_ok());
    }

    #[test]
    fn rejects_everything_else() {
        assert!(validate(&req(Op::Copy, &[], Some(r"C:\x"), None)).is_err(), "no items");
        assert!(validate(&req(Op::Copy, &[r"C:\a"], None, None)).is_err(), "no dest");
        assert!(validate(&req(Op::Copy, &[r"a.txt"], Some(r"C:\x"), None)).is_err(), "relative");
        assert!(validate(&req(Op::Copy, &[r"\a.txt"], Some(r"C:\x"), None)).is_err(), "no drive");
        assert!(validate(&req(Op::Delete, &[r"C:\x\..\Windows"], None, None)).is_err(), "dot-dot");
        assert!(validate(&req(Op::Delete, &[r"C:\"], None, None)).is_err(), "drive root");
        assert!(validate(&req(Op::Recycle, &[r"C:\a"], Some(r"C:\b"), None)).is_err(), "stray dest");
        assert!(validate(&req(Op::Rename, &[r"C:\a", r"C:\b"], None, Some("c"))).is_err(), "two renames");
        assert!(validate(&req(Op::Rename, &[r"C:\a"], None, Some(r"..\evil"))).is_err(), "bad name");
        assert!(validate(&req(Op::Rename, &[r"C:\a"], None, None)).is_err(), "no name");
        assert!(validate(&req(Op::Move, &[r"C:\a"], Some(r"C:\b"), Some("x"))).is_err(), "stray name");
    }

    #[test]
    fn json_is_strict() {
        let ok: Request = serde_json::from_str(r#"{"op":"rename","items":["C:\\a"],"name":"b"}"#).unwrap();
        assert_eq!(ok.op, Op::Rename);
        assert!(serde_json::from_str::<Request>(r#"{"op":"exec","items":["C:\\a"]}"#).is_err(), "unknown op");
        assert!(serde_json::from_str::<Request>(r#"{"op":"copy","items":["C:\\a"],"dest":"C:\\b","cmd":"x"}"#).is_err(), "unknown field");
    }
}
