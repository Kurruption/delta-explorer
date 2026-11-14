//! Scenario simulations: real-world things people do in a file manager, run against a scratch folder.
use de_core::{filter, list_dir, ops, page, sort, transfer::*, SortKey};
use std::{fs, io, path::{Path, PathBuf}};

#[derive(Default)]
struct S { bytes: u64, items: u64, cancel_at: Option<u64> }
impl Sink for S {
    fn bytes(&mut self, n: u64) { self.bytes += n; }
    fn item(&mut self, _: &Path) { self.items += 1; }
    fn cancelled(&self) -> bool { self.cancel_at.is_some_and(|c| self.items >= c) }
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("de-sim-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}
fn w(p: &Path, s: &str) { fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, s).unwrap(); }
fn names(d: &Path) -> Vec<String> { list_dir(d).unwrap().into_iter().map(|e| e.name).collect() }

#[test] fn s01_paste_twice_numbers_copies() {
    let d = scratch("01"); w(&d.join("report.docx"), "r");
    for _ in 0..3 { copy_items(&[d.join("report.docx")], &d, &mut S::default(), &std_copy, &mut vec![]).unwrap(); }
    assert_eq!(names(&d), ["report (2).docx", "report (3).docx", "report (4).docx", "report.docx"]);
}
#[test] fn s02_copy_folder_into_itself_refused() {
    let d = scratch("02"); fs::create_dir_all(d.join("a/b")).unwrap();
    let e = copy_items(&[d.join("a")], &d.join("a/b"), &mut S::default(), &std_copy, &mut vec![]).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
}
#[test] fn s03_move_into_itself_different_case_refused() {
    let d = scratch("03"); fs::create_dir_all(d.join("Photos/2024")).unwrap();
    let upper = PathBuf::from(d.to_string_lossy().to_uppercase()).join("PHOTOS");
    assert!(move_items(&[upper], &d.join("Photos/2024"), &mut S::default(), &std_copy, &mut vec![]).is_err());
    assert!(d.join("Photos/2024").exists());
}
#[test] fn s04_move_to_same_folder_is_noop() {
    let d = scratch("04"); w(&d.join("x.txt"), "x");
    let mut out = vec![];
    move_items(&[d.join("x.txt")], &d, &mut S::default(), &std_copy, &mut out).unwrap();
    assert!(out.is_empty() && d.join("x.txt").exists());
}
#[test] fn s05_move_clash_keeps_both_and_reports_partial() {
    let d = scratch("05"); w(&d.join("src/a.txt"), "a"); w(&d.join("src/b.txt"), "b"); w(&d.join("dst/b.txt"), "old");
    let mut out = vec![];
    let r = move_items(&[d.join("src/a.txt"), d.join("src/b.txt")], &d.join("dst"), &mut S::default(), &std_copy, &mut out);
    assert!(r.is_err());
    assert_eq!(out.len(), 1, "a.txt moved and is reported so undo can put it back");
    assert_eq!(fs::read_to_string(d.join("dst/b.txt")).unwrap(), "old", "never overwrites");
    assert!(d.join("src/b.txt").exists());
}
#[test] fn s06_move_locked_file_fails_cleanly() {
    let d = scratch("06"); w(&d.join("src/locked.txt"), "x"); fs::create_dir(d.join("dst")).unwrap();
    // Open without FILE_SHARE_DELETE: rename fails with a sharing violation, like a file open in Word.
    use std::os::windows::fs::OpenOptionsExt;
    let _h = fs::OpenOptions::new().read(true).share_mode(1).open(d.join("src/locked.txt")).unwrap();
    let r = move_items(&[d.join("src/locked.txt")], &d.join("dst"), &mut S::default(), &std_copy, &mut vec![]);
    assert!(r.is_err());
    assert!(!d.join("dst/locked.txt").exists(), "no duplicate left behind");
}
#[test] fn s07_cancel_copy_reports_partial_for_undo() {
    let d = scratch("07"); for i in 0..5 { w(&d.join(format!("big/{i}.bin")), "data"); } fs::create_dir(d.join("dst")).unwrap();
    let mut out = vec![];
    let e = copy_items(&[d.join("big")], &d.join("dst"), &mut S { cancel_at: Some(2), ..S::default() }, &std_copy, &mut out).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::Interrupted);
    assert_eq!(out, [d.join("dst/big")]);
}
#[test] fn s08_copy_empty_folder() {
    let d = scratch("08"); fs::create_dir_all(d.join("empty")).unwrap(); fs::create_dir(d.join("dst")).unwrap();
    copy_items(&[d.join("empty")], &d.join("dst"), &mut S::default(), &std_copy, &mut vec![]).unwrap();
    assert!(d.join("dst/empty").is_dir());
}
#[test] fn s09_copy_missing_source_errors_with_path() {
    let d = scratch("09");
    let e = copy_items(&[d.join("gone.txt")], &d, &mut S::default(), &std_copy, &mut vec![]).unwrap_err();
    assert!(e.to_string().contains("gone.txt"), "{e}");
}
#[test] fn s10_copy_to_missing_destination() {
    let d = scratch("10"); w(&d.join("a.txt"), "a");
    assert_eq!(copy_items(&[d.join("a.txt")], &d.join("nope"), &mut S::default(), &std_copy, &mut vec![]).unwrap_err().kind(), io::ErrorKind::NotFound);
}
#[test] fn s11_unicode_and_spaces_names() {
    let d = scratch("11"); w(&d.join("Résumé – final 🎉.pdf"), "x"); fs::create_dir(d.join("dst")).unwrap();
    copy_items(&[d.join("Résumé – final 🎉.pdf")], &d.join("dst"), &mut S::default(), &std_copy, &mut vec![]).unwrap();
    assert!(d.join("dst/Résumé – final 🎉.pdf").exists());
    assert_eq!(ops::free_name(&d.join("dst"), "Résumé – final 🎉.pdf"), d.join("dst/Résumé – final 🎉 (2).pdf"));
}
#[test] fn s12_dotfile_and_no_extension_names() {
    let d = scratch("12"); w(&d.join(".gitignore"), ""); w(&d.join("Makefile"), "");
    assert_eq!(ops::free_name(&d, ".gitignore"), d.join(".gitignore (2)"));
    assert_eq!(ops::free_name(&d, "Makefile"), d.join("Makefile (2)"));
}
#[test] fn s13_reserved_and_bad_names_refused() {
    let d = scratch("13");
    for n in ["CON", "nul.txt", "COM3", "a?b", "trailing.", "x/y"] { assert!(ops::create_dir(&d, n).is_err(), "{n}"); }
    assert!(ops::create_dir(&d, "Console").is_ok());
}
#[test] fn s14_rename_case_only_and_clash() {
    let d = scratch("14"); w(&d.join("photo.JPG"), "1"); w(&d.join("other.jpg"), "2");
    ops::rename(&d.join("photo.JPG"), "photo.jpg").unwrap();
    assert!(names(&d).contains(&"photo.jpg".to_string()));
    let to = ops::rename(&d.join("photo.jpg"), "OTHER.jpg").unwrap();
    assert_eq!(to.file_name().unwrap(), "OTHER (1).jpg", "taken name (ignoring case) gets the next free number");
}
#[test] fn s15_rename_missing_file() {
    let d = scratch("15");
    assert!(ops::rename(&d.join("ghost.txt"), "new.txt").is_err());
}
#[test] fn s16_zip_then_extract_twice() {
    let d = scratch("16"); w(&d.join("proj/src/main.rs"), "fn main(){}"); w(&d.join("proj/README"), "hi");
    let z = zip_items(&[d.join("proj")], &d.join("proj.zip"), &mut S::default()).unwrap();
    let a = extract(&z, &mut S::default()).unwrap();
    let b = extract(&z, &mut S::default()).unwrap();
    assert_eq!((a.clone(), b.clone()), (d.join("proj (2)"), d.join("proj (3)")));
    assert!(a.join("src/main.rs").exists(), "no proj/proj nesting");
}
#[test] fn s17_zip_of_loose_files_extracts_into_folder() {
    let d = scratch("17"); w(&d.join("a.txt"), "a"); w(&d.join("b.txt"), "b");
    let z = zip_items(&[d.join("a.txt"), d.join("b.txt")], &d.join("Archive.zip"), &mut S::default()).unwrap();
    let x = extract(&z, &mut S::default()).unwrap();
    assert_eq!(x, d.join("Archive"));
    assert!(x.join("a.txt").exists() && x.join("b.txt").exists());
}
#[test] fn s18_zip_refuses_existing_target() {
    let d = scratch("18"); w(&d.join("a.txt"), "a"); w(&d.join("a.zip"), "not a zip");
    assert!(zip_items(&[d.join("a.txt")], &d.join("a.zip"), &mut S::default()).is_err());
    assert_eq!(fs::read_to_string(d.join("a.zip")).unwrap(), "not a zip", "existing file untouched");
}
#[test] fn s19_extract_corrupt_zip_leaves_nothing() {
    let d = scratch("19"); w(&d.join("bad.zip"), "garbage");
    assert!(extract(&d.join("bad.zip"), &mut S::default()).is_err());
    assert!(!d.join("bad").exists());
}
#[test] fn s20_extract_zip_slip_refused() {
    let d = scratch("20");
    let f = fs::File::create(d.join("evil.zip")).unwrap();
    let mut z = zip::ZipWriter::new(f);
    z.start_file("../escape.txt", zip::write::SimpleFileOptions::default()).unwrap();
    io::Write::write_all(&mut z, b"x").unwrap();
    z.finish().unwrap();
    assert!(extract(&d.join("evil.zip"), &mut S::default()).is_err());
    assert!(!d.join("escape.txt").exists() && !d.join("evil").exists());
}
#[test] fn s21_cancel_zip_removes_half_file() {
    let d = scratch("21"); for i in 0..4 { w(&d.join(format!("f/{i}.txt")), "x"); }
    assert!(zip_items(&[d.join("f")], &d.join("f.zip"), &mut S { cancel_at: Some(1), ..S::default() }).is_err());
    assert!(!d.join("f.zip").exists());
}
#[test] fn s22_search_nested_case_insensitive_and_limit() {
    let d = scratch("22"); for i in 0..30 { w(&d.join(format!("a/b/c/Invoice-{i}.pdf")), "x"); } w(&d.join("other.txt"), "");
    assert_eq!(search(&d, "invoice", false, 1000, &|| false).len(), 30);
    assert_eq!(search(&d, "INVOICE", false, 10, &|| false).len(), 10);
    assert!(search(&d, "zzz", false, 10, &|| false).is_empty());
}
#[test] fn s23_search_skips_hidden_unless_asked() {
    let d = scratch("23"); w(&d.join("secret.txt"), "");
    std::process::Command::new("attrib").args(["+h", &d.join("secret.txt").to_string_lossy()]).status().unwrap();
    assert!(search(&d, "secret", false, 10, &|| false).is_empty());
    assert_eq!(search(&d, "secret", true, 10, &|| false).len(), 1);
}
#[test] fn s24_search_cancel_stops() {
    let d = scratch("24"); for i in 0..20 { w(&d.join(format!("d{i}/x.txt")), ""); }
    assert!(search(&d, "x", false, 1000, &|| true).is_empty());
}
#[test] fn s25_search_finds_folders_too() {
    let d = scratch("25"); fs::create_dir_all(d.join("Projects/Delta")).unwrap();
    let h = search(&d, "delta", false, 10, &|| false);
    assert!(h.len() == 1 && h[0].is_dir);
}
#[test] fn s26_list_sort_variants() {
    let d = scratch("26"); w(&d.join("b.TXT"), "22"); w(&d.join("a.png"), "1"); w(&d.join("c.txt"), "333"); fs::create_dir(d.join("Z")).unwrap();
    let mut l = list_dir(&d).unwrap();
    sort(&mut l, SortKey::Kind, false);
    assert_eq!(l.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Z", "a.png", "b.TXT", "c.txt"]);
    sort(&mut l, SortKey::Size, true);
    assert_eq!(l[0].name, "Z", "folders stay on top when descending");
    assert_eq!(l[1].name, "c.txt");
}
#[test] fn s27_filter_and_paging_edges() {
    let d = scratch("27"); for i in 0..450 { w(&d.join(format!("f{i:03}.txt")), ""); }
    let l = list_dir(&d).unwrap();
    assert_eq!(page(&l, 400, 200).entries.len(), 50);
    assert_eq!(page(&l, usize::MAX, 200).entries.len(), 0);
    assert_eq!(filter(&l, "F44", false).len(), 10);
}
#[test] fn s28_list_missing_folder_errors() {
    assert!(list_dir(Path::new(r"C:\definitely\not\here")).is_err());
}
#[test] fn s29_list_junction_shows_as_folder() {
    let d = scratch("29"); fs::create_dir(d.join("real")).unwrap();
    let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &d.join("link").to_string_lossy(), &d.join("real").to_string_lossy()]).output().unwrap().status.success();
    if !ok { return; }
    let l = list_dir(&d).unwrap();
    assert!(l.iter().find(|e| e.name == "link").unwrap().is_dir);
    // Search must not loop through a junction pointing at its parent.
    let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &d.join("real/loop").to_string_lossy(), &d.to_string_lossy()]).output().unwrap().status.success();
    if ok { assert!(search(&d, "real", false, 1000, &|| false).len() <= 2); }
}
#[test] fn s30_measure_counts() {
    let d = scratch("30"); w(&d.join("a/1"), "12345"); w(&d.join("a/b/2"), "123");
    assert_eq!(measure(&[d.join("a")]), (8, 2));
    assert_eq!(measure(&[d.join("missing")]), (0, 0));
}
#[test] fn s31_copy_many_progress_adds_up() {
    let d = scratch("31"); for i in 0..50 { w(&d.join(format!("s/{i}.txt")), "abcd"); } fs::create_dir(d.join("t")).unwrap();
    let mut s = S::default();
    copy_items(&[d.join("s")], &d.join("t"), &mut s, &std_copy, &mut vec![]).unwrap();
    assert_eq!((s.bytes, s.items), (200, 50));
}
#[test] fn s32_long_path_copy() {
    let d = scratch("32");
    let mut deep = d.clone();
    for i in 0..12 { deep = deep.join(format!("a-rather-long-folder-name-{i:02}")); }
    let long = PathBuf::from(format!(r"\\?\{}", deep.display()));
    if fs::create_dir_all(&long).is_err() { return; }
    fs::write(long.join("f.txt"), "x").unwrap();
    assert!(long.to_string_lossy().len() > 260);
    let n = list_dir(&long).unwrap();
    assert_eq!(n.len(), 1);
}

// ---------------- testing pass (13 Nov): risks from the release review ----------------
use de_core::archive;

/// A zip whose one entry inflates far beyond its size ("zip bomb"): extracting must not fill the disk.
/// 300 MB of zeros compresses to ~300 KB; the guard refuses absurd ratios before writing anything.
#[test] fn s33_zip_bomb_is_refused() {
    let d = scratch("33");
    let bomb = d.join("bomb.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&bomb).unwrap());
        z.start_file("zeros.bin", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(9))).unwrap();
        let block = vec![0u8; 1 << 20];
        for _ in 0..300 { io::Write::write_all(&mut z, &block).unwrap(); }
        z.finish().unwrap();
    }
    assert!(fs::metadata(&bomb).unwrap().len() < 1_000_000, "test archive should be tiny");
    let r = archive::extract(&bomb, &mut S::default());
    assert!(r.as_ref().is_err_and(|e| e.to_string().contains("zip bomb")), "a 1000:1 archive should be refused, got {r:?}");
    assert_eq!(names(&d), ["bomb.zip"], "nothing left behind");
    // Ordinary text compresses ~10:1 and must still extract.
    let ok = d.join("text.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&ok).unwrap());
        z.start_file("log.txt", zip::write::SimpleFileOptions::default()).unwrap();
        for i in 0..200_000 { io::Write::write_all(&mut z, format!("line {i}: something happened
").as_bytes()).unwrap(); }
        z.finish().unwrap();
    }
    assert!(archive::extract(&ok, &mut S::default()).is_ok());
}

#[test] fn s34_encrypted_zip_refused_politely_and_cleanly() {
    let d = scratch("34");
    fs::create_dir_all(d.join("Secret")).unwrap(); w(&d.join("Secret/a.txt"), "hidden");
    let z = archive::create(&[d.join("Secret")], &d.join("Secret.zip"), archive::Format::Zip, 1, Some("pw"), &mut S::default()).unwrap();
    fs::remove_dir_all(d.join("Secret")).unwrap();
    let e = archive::extract(&z, &mut S::default()).unwrap_err();
    assert!(e.to_string().to_lowercase().contains("password"), "message should mention the password: {e}");
    assert_eq!(names(&d), ["Secret.zip"], "nothing left behind");
}

#[test] fn s35_corrupt_7z_and_tar_leave_nothing() {
    let d = scratch("35");
    for n in ["broken.7z", "broken.tar.gz", "broken.rar"] {
        fs::write(d.join(n), b"this is not really an archive at all").unwrap();
        assert!(archive::extract(&d.join(n), &mut S::default()).is_err(), "{n}");
    }
    assert_eq!(names(&d).len(), 3, "only the three broken files: {:?}", names(&d));
}

/// The destination vanishes mid-copy (USB pulled): copy stops with an error and the source is untouched.
#[test] fn s36_destination_vanishes_mid_copy() {
    let d = scratch("36");
    for i in 0..5 { w(&d.join(format!("src/f{i}.txt")), "data"); }
    fs::create_dir_all(d.join("dst")).unwrap();
    struct Pull { dst: PathBuf, n: u64 }
    impl Sink for Pull {
        fn bytes(&mut self, _: u64) {}
        fn item(&mut self, _: &Path) { self.n += 1; if self.n == 3 { let _ = fs::remove_dir_all(&self.dst); } }
        fn cancelled(&self) -> bool { false }
    }
    let mut made = vec![];
    let r = copy_items(&[d.join("src")], &d.join("dst"), &mut Pull { dst: d.join("dst"), n: 0 }, &std_copy, &mut made);
    assert!(r.is_err(), "copy into a vanished folder must fail");
    assert_eq!(fs::read_dir(d.join("src")).unwrap().count(), 5, "source untouched");
}

/// A move where one item fails: exactly the items that moved are reported, so Undo reverses only those.
#[test] fn s37_partial_move_reports_exactly_what_moved() {
    let d = scratch("37");
    w(&d.join("a.txt"), "a"); w(&d.join("b.txt"), "b"); w(&d.join("c.txt"), "c");
    fs::create_dir_all(d.join("dst")).unwrap();
    let mut moved = vec![];
    let items = [d.join("a.txt"), d.join("missing.txt"), d.join("c.txt")];
    let _ = move_items(&items, &d.join("dst"), &mut S::default(), &std_copy, &mut moved);
    for (from, to) in &moved { assert!(!from.exists() && to.exists(), "reported move really happened: {from:?}"); }
    for p in [d.join("a.txt"), d.join("c.txt")] {
        let was_moved = moved.iter().any(|(f, _)| f == &p);
        assert_eq!(was_moved, !p.exists(), "{p:?}: report matches the disk");
    }
}

/// Speed: list, sort and page a folder of 50,000 files (release build: cargo test --release -- --ignored s38).
#[test] #[ignore] fn s38_big_folder_speed() {
    let d = scratch("38");
    for i in 0..50_000 { fs::write(d.join(format!("file {i:05}.txt")), b"").unwrap(); }
    let t = std::time::Instant::now();
    let mut es = list_dir(&d).unwrap();
    let listed = t.elapsed();
    sort(&mut es, SortKey::Name, false);
    let sorted = t.elapsed();
    let p = page(&es, 25_000, 200);
    eprintln!("50k files: list {listed:?}, +sort {sorted:?}, page {} rows", p.entries.len());
    assert_eq!(es.len(), 50_000);
    assert!(sorted.as_millis() < 3000, "listing + sorting 50k files took {sorted:?}");
    let _ = fs::remove_dir_all(&d);
}

/// Same size, same timestamp, different content: compare must not call them identical (sync would skip them).
#[test] fn s39_compare_catches_same_size_same_time_changes() {
    let d = scratch("39");
    w(&d.join("L/notes.md"), "new notes"); w(&d.join("R/notes.md"), "old notes");
    let t = fs::metadata(d.join("L/notes.md")).unwrap().modified().unwrap();
    fs::File::options().write(true).open(d.join("R/notes.md")).unwrap().set_modified(t).unwrap();
    let items = de_core::compare::compare_dirs(&d.join("L"), &d.join("R")).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, de_core::compare::Kind::Differs);
}
