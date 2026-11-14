//! In-memory server for tests: a map of path -> folder or file bytes.
use crate::{hidden, invalid, join, name, parent, Entry, RemoteProvider};
use std::{collections::BTreeMap, fs, io, path::Path};

#[derive(Default, Clone)]
pub struct Fake {
    /// None = folder.
    pub items: BTreeMap<String, Option<Vec<u8>>>,
}

impl Fake {
    pub fn dir(&mut self, p: &str) {
        let mut cur = String::new();
        for seg in p.split('/').filter(|s| !s.is_empty()) {
            cur = join(if cur.is_empty() { "/" } else { &cur }, seg);
            self.items.entry(cur.clone()).or_insert(None);
        }
    }
    pub fn file(&mut self, p: &str, data: &[u8]) {
        self.dir(&parent(p));
        self.items.insert(p.to_string(), Some(data.to_vec()));
    }
    fn exists_dir(&self, p: &str) -> bool { p == "/" || matches!(self.items.get(p), Some(None)) }
}

fn nf(p: &str) -> io::Error { io::Error::new(io::ErrorKind::NotFound, format!("{p}: not found")) }

impl RemoteProvider for Fake {
    fn list(&mut self, dir: &str) -> io::Result<Vec<Entry>> {
        if !self.exists_dir(dir) { return Err(nf(dir)); }
        Ok(self.items.iter()
            .filter(|(k, _)| parent(k) == dir && k.as_str() != "/")
            .map(|(k, v)| {
                let n = name(k).to_string();
                Entry { hidden: hidden(&n), name: n, is_dir: v.is_none(), size: v.as_ref().map_or(0, |d| d.len() as u64), modified: 0, ..Default::default() }
            })
            .collect())
    }
    fn download(&mut self, path: &str, to: &Path, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        let data = self.items.get(path).cloned().flatten().ok_or_else(|| nf(path))?;
        fs::write(to, &data)?;
        if progress(data.len() as u64) { Ok(()) } else { Err(de_core::transfer::cancelled()) }
    }
    fn upload(&mut self, from: &Path, path: &str, progress: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
        if !self.exists_dir(&parent(path)) { return Err(nf(&parent(path))); }
        let data = fs::read(from)?;
        if !progress(data.len() as u64) { return Err(de_core::transfer::cancelled()); }
        self.items.insert(path.to_string(), Some(data));
        Ok(())
    }
    fn mkdir(&mut self, path: &str) -> io::Result<()> {
        if self.items.contains_key(path) { return Err(io::ErrorKind::AlreadyExists.into()); }
        if !self.exists_dir(&parent(path)) { return Err(nf(&parent(path))); }
        self.items.insert(path.to_string(), None);
        Ok(())
    }
    fn rename(&mut self, from: &str, to: &str) -> io::Result<()> {
        if self.items.contains_key(to) { return Err(io::ErrorKind::AlreadyExists.into()); }
        let moved: Vec<String> = self.items.keys().filter(|k| *k == from || k.starts_with(&format!("{from}/"))).cloned().collect();
        if moved.is_empty() { return Err(nf(from)); }
        for k in moved {
            let v = self.items.remove(&k).unwrap();
            self.items.insert(format!("{to}{}", &k[from.len()..]), v);
        }
        Ok(())
    }
    fn delete(&mut self, path: &str, is_dir: bool) -> io::Result<()> {
        match self.items.get(path) {
            None => Err(nf(path)),
            Some(v) if v.is_none() != is_dir => Err(invalid("wrong kind")),
            Some(None) if self.items.keys().any(|k| parent(k) == path && k != path) => Err(invalid("folder not empty")),
            _ => { self.items.remove(path); Ok(()) }
        }
    }
}
