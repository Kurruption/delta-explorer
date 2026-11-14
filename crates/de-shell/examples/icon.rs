// Dumps a file's shell icon as PNG: cargo run -p de-shell --example icon -- <file> <size> <out.png>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let png = de_shell::thumb::image(std::path::Path::new(&a[1]), a[2].parse().unwrap(), de_shell::thumb::Kind::Icon).unwrap();
    std::fs::write(&a[3], png).unwrap();
}
