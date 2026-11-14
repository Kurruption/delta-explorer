//! Read-only photo metadata (EXIF) and audio tags, plus safe editing of the common audio tags.
use lofty::{config::WriteOptions, prelude::*, probe::Probe, tag::Tag};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    /// 0 = none.
    pub track: u32,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// "image" | "audio" | "" (nothing readable)
    pub kind: &'static str,
    /// Label/value rows for display.
    pub fields: Vec<(String, String)>,
    /// Set for audio files whose tags can be edited.
    pub tags: Option<AudioTags>,
}

const AUDIO: &[&str] = &["mp3", "flac", "m4a", "mp4", "aac", "ogg", "opus", "wav", "aiff", "aif", "wv", "ape", "mpc", "spx"];

fn ext(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn read(path: &Path) -> io::Result<Meta> {
    if AUDIO.contains(&ext(path).as_str()) { audio(path) } else { image(path) }
}

fn image(path: &Path) -> io::Result<Meta> {
    use exif::{In, Tag as T};
    let mut f = io::BufReader::new(fs::File::open(path)?);
    let Ok(x) = exif::Reader::new().read_from_container(&mut f) else { return Ok(Meta::default()) };
    let get = |t: T| x.get_field(t, In::PRIMARY).map(|f| f.display_value().with_unit(&x).to_string().trim_matches('"').trim().to_string()).filter(|v| !v.is_empty());
    let mut fields = Vec::new();
    let camera = [get(T::Make), get(T::Model)].into_iter().flatten().collect::<Vec<_>>().join(" ");
    if !camera.is_empty() { fields.push(("Camera".into(), camera)); }
    for (label, t) in [("Lens", T::LensModel), ("Date taken", T::DateTimeOriginal), ("Exposure", T::ExposureTime), ("Aperture", T::FNumber),
        ("ISO", T::PhotographicSensitivity), ("Focal length", T::FocalLength), ("Flash", T::Flash), ("Width", T::PixelXDimension), ("Height", T::PixelYDimension), ("Software", T::Software)] {
        if let Some(v) = get(t) { fields.push((label.into(), v)); }
    }
    let gps = x.get_field(T::GPSLatitude, In::PRIMARY).is_some();
    fields.push(("Location (GPS)".into(), if gps { "Yes, this photo records where it was taken" } else { "No" }.into()));
    Ok(Meta { kind: "image", fields, tags: None })
}

fn audio(path: &Path) -> io::Result<Meta> {
    let file = Probe::open(path).map_err(io::Error::other)?.read().map_err(io::Error::other)?;
    let p = file.properties();
    let mut fields = Vec::new();
    let secs = p.duration().as_secs();
    fields.push(("Duration".into(), format!("{}:{:02}", secs / 60, secs % 60)));
    if let Some(b) = p.audio_bitrate() { fields.push(("Bitrate".into(), format!("{b} kbps"))); }
    if let Some(r) = p.sample_rate() { fields.push(("Sample rate".into(), format!("{r} Hz"))); }
    if let Some(c) = p.channels() { fields.push(("Channels".into(), c.to_string())); }
    let t = file.primary_tag().or_else(|| file.first_tag());
    let s = |v: Option<std::borrow::Cow<str>>| v.map(|c| c.into_owned()).unwrap_or_default();
    let tags = t.map_or_else(AudioTags::default, |t| AudioTags { title: s(t.title()), artist: s(t.artist()), album: s(t.album()), genre: s(t.genre()), track: t.track().unwrap_or(0) });
    Ok(Meta { kind: "audio", fields, tags: Some(tags) })
}

/// Writes the tags without risking the file: edits a copy, keeps the original as a backup while the copy
/// is swapped in, and only removes the backup once that worked.
pub fn write_audio_tags(path: &Path, t: &AudioTags) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("bad path"))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    // Keeps the real extension last so the format is still recognised.
    let tmp = crate::ops::free_name(dir, &format!(".delta-tmp.{name}"));
    let bak = crate::ops::free_name(dir, &format!(".delta-bak.{name}"));
    fs::copy(path, &tmp)?;
    let edit = || -> io::Result<()> {
        let mut file = Probe::open(&tmp).map_err(io::Error::other)?.read().map_err(io::Error::other)?;
        let tag = match file.primary_tag_mut() {
            Some(t) => t,
            None => {
                let tt = file.primary_tag_type();
                file.insert_tag(Tag::new(tt));
                file.primary_tag_mut().ok_or_else(|| io::Error::other("this file can't hold tags"))?
            }
        };
        let set = |tag: &mut Tag, v: &str, set: fn(&mut Tag, String), rm: fn(&mut Tag)| if v.trim().is_empty() { rm(tag) } else { set(tag, v.trim().to_string()) };
        set(tag, &t.title, |x, v| x.set_title(v), |x| x.remove_title());
        set(tag, &t.artist, |x, v| x.set_artist(v), |x| x.remove_artist());
        set(tag, &t.album, |x, v| x.set_album(v), |x| x.remove_album());
        set(tag, &t.genre, |x, v| x.set_genre(v), |x| x.remove_genre());
        if t.track > 0 { tag.set_track(t.track) } else { tag.remove_track() }
        tag.save_to_path(&tmp, WriteOptions::default()).map_err(io::Error::other)
    };
    if let Err(e) = edit() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(path, &bak).inspect_err(|_| { let _ = fs::remove_file(&tmp); })?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::rename(&bak, path); // put the original back
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let _ = fs::remove_file(&bak);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valid 16-bit mono WAV with a few silent samples.
    fn wav() -> Vec<u8> {
        let data = vec![0u8; 800];
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&8000u32.to_le_bytes());
        v.extend_from_slice(&16000u32.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(&data);
        v
    }

    #[test]
    fn edits_audio_tags_safely() {
        let d = std::env::temp_dir().join("DeltaAgent-power").join(format!("meta-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let p = d.join("song.wav");
        fs::write(&p, wav()).unwrap();
        assert_eq!(read(&p).unwrap().tags, Some(AudioTags::default()));
        let t = AudioTags { title: "Täst".into(), artist: "Delta".into(), album: "A".into(), genre: "Rock".into(), track: 3 };
        write_audio_tags(&p, &t).unwrap();
        let m = read(&p).unwrap();
        assert_eq!(m.kind, "audio");
        assert_eq!(m.tags, Some(t));
        // Only the edited file is left: no temp or backup copies.
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        // Not audio and no EXIF: nothing to show, no error.
        fs::write(d.join("x.jpg"), b"not a jpeg").unwrap();
        assert_eq!(read(&d.join("x.jpg")).unwrap().kind, "");
        fs::remove_dir_all(&d).unwrap();
    }
}
