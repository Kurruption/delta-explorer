//! Batch rename: builds new names from a recipe (pure), finds clashes and bad names, and applies the
//! renames in two phases (everything to a temporary name first) so swaps like a <-> b work.
use crate::ops::validate_name;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum At { #[default] Start, End }

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Case { #[default] Keep, Lower, Upper, Title }

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DateOf { #[default] None, Modified, Created }

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtMode { #[default] Keep, Change, Remove }

/// Every operation at once; empty/default fields do nothing. They run in this order on the name without
/// its extension: find & replace, replace characters, change case, prefix/suffix, number, date; then the extension.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recipe {
    pub find: String,
    pub replace: String,
    pub regex: bool,
    pub match_case: bool,
    /// Characters to swap for `strip_with` ("" removes them); `strip_spaces` adds the space.
    pub strip: String,
    pub strip_spaces: bool,
    pub strip_with: String,
    pub case: Case,
    pub prefix: String,
    pub suffix: String,
    pub number: bool,
    pub start: i64,
    pub step: i64,
    pub pad: usize,
    pub number_at: At,
    pub date: DateOf,
    /// YYYY YY MM DD hh mm ss
    pub date_format: String,
    pub date_at: At,
    /// Between the name and an inserted number or date.
    pub sep: String,
    pub ext_mode: ExtMode,
    pub ext: String,
}

pub struct Item {
    pub name: String,
    pub is_dir: bool,
    /// Seconds since the Unix epoch.
    pub modified: u64,
    pub created: u64,
}

/// "a.tar.gz" -> ("a.tar", ".gz"); folders and dot-files (".gitignore") have no extension.
fn split_ext(name: &str, is_dir: bool) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut start = true;
    for c in s.chars() {
        if start { out.extend(c.to_uppercase()) } else { out.extend(c.to_lowercase()) }
        start = c.is_whitespace() || matches!(c, '_' | '-' | '.' | '(' | '[');
    }
    out
}

/// Local date/time of `secs` (offset in minutes east of UTC), formatted with YYYY YY MM DD hh mm ss.
pub fn format_date(secs: u64, tz_minutes: i64, fmt: &str) -> String {
    let t = secs as i64 + tz_minutes * 60;
    let (days, rem) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let tokens = [
        ("YYYY", format!("{y:04}")), ("YY", format!("{:02}", y % 100)), ("MM", format!("{m:02}")), ("DD", format!("{d:02}")),
        ("hh", format!("{:02}", rem / 3600)), ("mm", format!("{:02}", rem / 60 % 60)), ("ss", format!("{:02}", rem % 60)),
    ];
    let mut out = String::new();
    let mut rest = fmt;
    'outer: while let Some(c) = rest.chars().next() {
        for (k, v) in &tokens {
            if let Some(r) = rest.strip_prefix(k) { out.push_str(v); rest = r; continue 'outer; }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// The new name for each item, in order. Fails only when the find pattern is not a valid regex.
pub fn build(items: &[Item], r: &Recipe, tz_minutes: i64) -> Result<Vec<String>, String> {
    let find = if r.find.is_empty() {
        None
    } else {
        let pat = if r.regex { r.find.clone() } else { regex::escape(&r.find) };
        Some(regex::RegexBuilder::new(&pat).case_insensitive(!r.match_case).build().map_err(|e| format!("Pattern: {e}"))?)
    };
    let strip: HashSet<char> = r.strip.chars().chain(r.strip_spaces.then_some(' ')).collect();
    Ok(items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            let (stem, ext) = split_ext(&it.name, it.is_dir);
            let mut s = match &find {
                Some(re) if r.regex => re.replace_all(stem, r.replace.as_str()).into_owned(),
                Some(re) => re.replace_all(stem, regex::NoExpand(&r.replace)).into_owned(),
                None => stem.to_string(),
            };
            if !strip.is_empty() {
                s = s.chars().map(|c| if strip.contains(&c) { r.strip_with.clone() } else { c.to_string() }).collect();
            }
            s = match r.case { Case::Keep => s, Case::Lower => s.to_lowercase(), Case::Upper => s.to_uppercase(), Case::Title => title(&s) };
            s = format!("{}{s}{}", r.prefix, r.suffix);
            let mut put = |extra: String, at: At| s = if at == At::Start { format!("{extra}{}{s}", r.sep) } else { format!("{s}{}{extra}", r.sep) };
            if r.number {
                let n = r.start + i as i64 * r.step;
                put(format!("{n:0w$}", w = r.pad), r.number_at);
            }
            if r.date != DateOf::None {
                let t = if r.date == DateOf::Created { it.created } else { it.modified };
                put(format_date(t, tz_minutes, &r.date_format), r.date_at);
            }
            let ext = match r.ext_mode {
                ExtMode::Keep => ext.to_string(),
                ExtMode::Remove => String::new(),
                ExtMode::Change => {
                    let e = r.ext.trim().trim_start_matches('.');
                    if e.is_empty() { String::new() } else { format!(".{e}") }
                }
            };
            format!("{s}{ext}")
        })
        .collect())
}

fn key(p: &Path) -> String { p.to_string_lossy().to_lowercase() }

/// Why each rename can't happen (None = fine or unchanged): a bad name, two items getting the same
/// name, or a name already used by something outside the batch. `exists` is injected for tests.
pub fn check(paths: &[PathBuf], names: &[String], exists: &dyn Fn(&Path) -> bool) -> Vec<Option<String>> {
    let sources: HashSet<String> = paths.iter().map(|p| key(p)).collect();
    let targets: Vec<PathBuf> = paths.iter().zip(names).map(|(p, n)| p.with_file_name(n)).collect();
    let mut count: HashMap<String, usize> = HashMap::new();
    for t in &targets { *count.entry(key(t)).or_default() += 1; }
    paths
        .iter()
        .zip(names)
        .zip(&targets)
        .map(|((p, n), t)| {
            if p.file_name().is_some_and(|o| o.to_string_lossy() == n.as_str()) { return None; }
            if let Err(e) = validate_name(n) {
                return Some(if n.is_empty() { "Name is empty".into() } else { e.to_string() });
            }
            if count[&key(t)] > 1 { return Some("Another item would get this name".into()); }
            if !sources.contains(&key(t)) && exists(t) { return Some("Something with this name already exists".into()); }
            None
        })
        .collect()
}

#[derive(Debug, Default, Serialize)]
pub struct Outcome {
    /// (old path, new path) of every rename that happened.
    pub done: Vec<(PathBuf, PathBuf)>,
    /// (old path, why) of every rename that didn't; those items keep their old names where possible.
    pub failed: Vec<(PathBuf, String)>,
}

/// Renames `(path, new name)` pairs. Refuses the whole batch if any name is bad or clashes (see `check`).
/// Phase 1 moves every item to a temporary name in its folder, phase 2 to its final name; an item whose
/// phase 2 fails is put back under its old name.
pub fn apply(pairs: &[(PathBuf, String)]) -> Result<Outcome, String> {
    let (paths, names): (Vec<PathBuf>, Vec<String>) = pairs.iter().cloned().unzip();
    if let Some((i, why)) = check(&paths, &names, &|p| fs::symlink_metadata(p).is_ok()).into_iter().enumerate().find_map(|(i, w)| w.map(|w| (i, w))) {
        return Err(format!("{}: {why}", names[i]));
    }
    let mut out = Outcome::default();
    let mut parked = Vec::new();
    let tag = std::process::id();
    for (i, (p, n)) in pairs.iter().enumerate() {
        if p.file_name().is_some_and(|o| o.to_string_lossy() == n.as_str()) { continue; }
        let tmp = (0..).map(|k| p.with_file_name(format!(".delta-rename-{tag}-{i}-{k}"))).find(|t| fs::symlink_metadata(t).is_err()).unwrap();
        match fs::rename(p, &tmp) {
            Ok(()) => parked.push((p, tmp, p.with_file_name(n))),
            Err(e) => out.failed.push((p.clone(), e.to_string())),
        }
    }
    for (from, tmp, to) in parked {
        // Something may have appeared under the new name meanwhile; never replace it.
        let r = if fs::symlink_metadata(&to).is_ok() { Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "something with this name appeared meanwhile")) } else { fs::rename(&tmp, &to) };
        match r {
            Ok(()) => out.done.push((from.clone(), to)),
            Err(e) => {
                let why = match fs::rename(&tmp, from) {
                    Ok(()) => e.to_string(),
                    Err(e2) => format!("{e}; it was left as {} ({e2})", tmp.display()),
                };
                out.failed.push((from.clone(), why));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(names: &[&str]) -> Vec<Item> {
        names.iter().map(|n| Item { name: n.to_string(), is_dir: !n.contains('.'), modified: 1_700_000_000, created: 0 }).collect()
    }
    fn run(names: &[&str], r: Recipe) -> Vec<String> { build(&items(names), &r, 0).unwrap() }

    #[test]
    fn builds_names() {
        let r = Recipe { find: "IMG".into(), replace: "photo".into(), ..Default::default() };
        assert_eq!(run(&["img_1.JPG", "IMG.img"], r), ["photo_1.JPG", "photo.img"], "plain, case-insensitive, stem only");
        let r = Recipe { find: r"(\d+)".into(), replace: "#$1".into(), regex: true, match_case: true, ..Default::default() };
        assert_eq!(run(&["a12.txt"], r), ["a#12.txt"]);
        let r = Recipe { find: "a".into(), replace: "$1".into(), ..Default::default() };
        assert_eq!(run(&["a.txt"], r), ["$1.txt"], "plain replacement is literal");
        assert!(build(&items(&["x"]), &Recipe { find: "(".into(), regex: true, ..Default::default() }, 0).is_err());

        let r = Recipe { prefix: "p-".into(), suffix: "-s".into(), case: Case::Upper, ..Default::default() };
        assert_eq!(run(&["ab.txt", "dir"], r), ["p-AB-s.txt", "p-DIR-s"]);
        assert_eq!(run(&["hello big_world.md"], Recipe { case: Case::Title, ..Default::default() }), ["Hello Big_World.md"]);

        let r = Recipe { number: true, start: 9, step: 2, pad: 3, number_at: At::End, sep: " ".into(), ..Default::default() };
        assert_eq!(run(&["a.txt", "b.txt"], r), ["a 009.txt", "b 011.txt"]);
        let r = Recipe { date: DateOf::Modified, date_format: "YYYY-MM-DD hh.mm.ss".into(), sep: "_".into(), ..Default::default() };
        assert_eq!(run(&["a.txt"], r), ["2023-11-14 22.13.20_a.txt"]);
        assert_eq!(format_date(1_700_000_000, 120, "YY/MM/DD hh"), "23/11/15 00");
        assert_eq!(format_date(951_782_400, 0, "YYYY-MM-DD"), "2000-02-29");

        let r = Recipe { strip: "-".into(), strip_spaces: true, strip_with: "_".into(), ..Default::default() };
        assert_eq!(run(&["a b-c.txt"], r), ["a_b_c.txt"]);
        assert_eq!(run(&["a.jpeg", ".gitignore"], Recipe { ext_mode: ExtMode::Change, ext: ".JPG".into(), ..Default::default() }), ["a.JPG", ".gitignore.JPG"]);
        assert_eq!(run(&["a.tar.gz"], Recipe { ext_mode: ExtMode::Remove, ..Default::default() }), ["a.tar"]);
    }

    #[test]
    fn checks_names() {
        let d = PathBuf::from(r"C:\x");
        let paths = vec![d.join("a.txt"), d.join("b.txt"), d.join("c.txt"), d.join("d.txt"), d.join("e.txt")];
        let names: Vec<String> = ["b.txt", "A.TXT", "same.txt", "SAME.txt", "con.txt"].map(String::from).to_vec();
        let taken = |p: &Path| p.ends_with("other.txt") || p.ends_with("b.txt");
        let r = check(&paths, &names, &taken);
        assert_eq!(r[0], None, "a -> b is fine: b is in the batch and moves away");
        assert_eq!(r[1], None, "b -> A.TXT (a moves away)");
        assert!(r[2].is_some() && r[3].is_some(), "duplicates, case-insensitive");
        assert!(r[4].is_some(), "reserved");
        assert!(check(&[d.join("a.txt")], &["other.txt".into()], &taken)[0].is_some(), "clash outside the batch");
        assert!(check(&[d.join("a.txt")], &["".into()], &taken)[0].is_some());
        assert_eq!(check(&[d.join("a.txt")], &["a.txt".into()], &|_| true)[0], None, "unchanged");
    }

    #[test]
    fn applies_in_two_phases() {
        let d = std::env::temp_dir().join(format!("de-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.txt"), "A").unwrap();
        fs::write(d.join("b.txt"), "B").unwrap();
        fs::write(d.join("c.txt"), "C").unwrap();
        // swap a <-> b, case-only rename of c
        let o = apply(&[(d.join("a.txt"), "b.txt".into()), (d.join("b.txt"), "a.txt".into()), (d.join("c.txt"), "C.txt".into())]).unwrap();
        assert_eq!(o.done.len(), 3);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "B");
        assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "A");
        assert!(fs::read_dir(&d).unwrap().any(|e| e.unwrap().file_name() == "C.txt"));
        // refuses a clash outright, touching nothing
        assert!(apply(&[(d.join("a.txt"), "b.txt".into())]).is_err());
        // a missing item fails, the rest still happen
        let o = apply(&[(d.join("gone.txt"), "x.txt".into()), (d.join("a.txt"), "z.txt".into())]).unwrap();
        assert_eq!((o.done.len(), o.failed.len()), (1, 1));
        assert!(d.join("z.txt").exists());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 3, "no temporary names left behind");
        fs::remove_dir_all(&d).unwrap();
    }
}
