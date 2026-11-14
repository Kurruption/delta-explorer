//! File checksums (MD5, SHA-1, SHA-256) in one pass.
use crate::transfer::{cancelled, Sink};
use md5::Digest;
use serde::Serialize;
use std::{fs, io::Read, path::Path};

#[derive(Debug, Serialize, PartialEq)]
pub struct Sums {
    pub md5: String,
    pub sha1: String,
    pub sha256: String,
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

/// Reads the file once and feeds all three hashes; reports bytes and stops on cancel.
pub fn checksums(path: &Path, sink: &mut dyn Sink) -> std::io::Result<Sums> {
    let mut f = fs::File::open(path)?;
    let (mut a, mut b, mut c) = (md5::Md5::new(), sha1::Sha1::new(), sha2::Sha256::new());
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if sink.cancelled() { return Err(cancelled()); }
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        a.update(&buf[..n]);
        b.update(&buf[..n]);
        c.update(&buf[..n]);
        sink.bytes(n as u64);
    }
    Ok(Sums { md5: hex(&a.finalize()), sha1: hex(&b.finalize()), sha256: hex(&c.finalize()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct T;
    impl Sink for T {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) {}
        fn cancelled(&self) -> bool { false }
    }
    #[test]
    fn known_values() {
        let p = std::env::temp_dir().join(format!("de-hash-{}", std::process::id()));
        fs::write(&p, b"abc").unwrap();
        let s = checksums(&p, &mut T).unwrap();
        assert_eq!(s.md5, "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(s.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(s.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        fs::remove_file(p).unwrap();
    }
}
