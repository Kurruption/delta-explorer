// Recycles a temp file, then lists the Recycle Bin: cargo run -p de-shell --example bin
fn main() {
    let f = std::env::temp_dir().join(format!("delta-bin-check-{}.txt", std::process::id()));
    std::fs::write(&f, b"x").unwrap();
    de_shell::recycle(std::slice::from_ref(&f)).unwrap();
    let items = de_shell::native::bin_list().unwrap();
    println!("{} items in bin", items.len());
    let mine: Vec<_> = items.iter().filter(|i| i.name == f.file_name().unwrap().to_string_lossy()).collect();
    println!("found ours: {}", mine.len());
    if let Some(i) = mine.first() { println!("{:?}", i); de_shell::native::bin_purge(&[i.id.clone()]).unwrap(); println!("purged"); }
}
