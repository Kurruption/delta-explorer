// Times sending files to the Recycle Bin: cargo run --release -p de-shell --example deltime
fn main() {
    let d = std::env::temp_dir().join(format!("delta-deltime-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    for n in [1usize, 1, 10] {
        let files: Vec<_> = (0..n).map(|i| { let f = d.join(format!("f{n}-{i}-{}.txt", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); std::fs::write(&f, b"x").unwrap(); f }).collect();
        let t = std::time::Instant::now();
        de_shell::recycle(&files).unwrap();
        println!("recycle {n} file(s): {:?}", t.elapsed());
        let ids: Vec<String> = de_shell::native::bin_list().unwrap().into_iter().filter(|i| i.original.contains("delta-deltime")).map(|i| i.id).collect();
        de_shell::native::bin_purge(&ids).unwrap();
    }
    let t = std::time::Instant::now();
    let n = de_shell::native::bin_list().unwrap().len();
    println!("bin_list ({n} items): {:?}", t.elapsed());
    std::fs::remove_dir_all(&d).unwrap();
}
