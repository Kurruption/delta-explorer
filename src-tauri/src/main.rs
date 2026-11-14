// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // "Try as administrator" helper: no window, no single-instance handoff; one operation, then exit.
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "--elevated-op") {
        std::process::exit(delta_explorer_lib::elevated_main(args.get(2).map(|a| a.as_os_str())));
    }
    delta_explorer_lib::run()
}
