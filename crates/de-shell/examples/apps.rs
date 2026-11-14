// Lists "Open with" apps for the extensions given: cargo run -p de-shell --example apps -- .txt .png
fn main() {
    for ext in std::env::args().skip(1) {
        println!("{ext}:");
        let file = format!(r"C:\x\a{ext}");
        for a in de_shell::open_with::apps_for(std::path::Path::new(&file)).unwrap() {
            println!("  {}{} | icon={}", a.name, if a.recommended { " (recommended)" } else { "" }, a.icon.is_some());
        }
    }
}
