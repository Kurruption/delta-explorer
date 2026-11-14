//! More than one Delta window. "main" is the window from tauri.conf.json; extra ones are "w-<n>".
//! Launches from Explorer / Win+E open a tab in the window used most recently.
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicU32, Ordering}, Mutex},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct Wins {
    /// Label of the window that last had focus.
    pub last: Mutex<String>,
    /// What a new window should open with (its tabs), until it asks for it.
    inits: Mutex<HashMap<String, serde_json::Value>>,
    next: AtomicU32,
}

/// The window launches and the global shortcut should use.
pub fn target(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let last = app.state::<Wins>().last.lock().unwrap().clone();
    app.get_webview_window(&last).or_else(|| app.get_webview_window("main")).or_else(|| app.webview_windows().into_values().next())
}

/// Opens another Delta window. `init` is handed to it (e.g. a tab dragged out); `at_cursor` places it under the pointer.
#[tauri::command]
pub async fn new_window(app: AppHandle, from: tauri::WebviewWindow, init: Option<serde_json::Value>, at_cursor: bool) -> Result<String, String> {
    let wins = app.state::<Wins>();
    let label = format!("w-{}", wins.next.fetch_add(1, Ordering::Relaxed) + 1);
    if let Some(v) = init { wins.inits.lock().unwrap().insert(label.clone(), v); }
    let scale = from.scale_factor().unwrap_or(1.0);
    let (x, y) = match (at_cursor, app.cursor_position()) {
        (true, Ok(p)) => (p.x / scale - 160.0, p.y / scale - 16.0),
        _ => from.outer_position().map(|p| (p.x as f64 / scale + 32.0, p.y as f64 / scale + 32.0)).unwrap_or((120.0, 120.0)),
    };
    let size = from.inner_size().map(|s| (s.width as f64 / scale, s.height as f64 / scale)).unwrap_or((1200.0, 760.0));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Delta Explorer")
        .inner_size(size.0, size.1)
        .min_inner_size(720.0, 440.0)
        .position(x.max(0.0), y.max(0.0))
        .decorations(false)
        .transparent(true)
        .visible(false) // the page shows itself once painted, like the main window
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// A new window's start-up data (once).
#[tauri::command]
pub fn window_init(app: AppHandle, window: tauri::WebviewWindow) -> Option<serde_json::Value> {
    app.state::<Wins>().inits.lock().unwrap().remove(window.label())
}

/// Another Delta window under the mouse pointer (for dropping a dragged tab onto it), if any.
#[tauri::command]
pub fn window_at_cursor(app: AppHandle, window: tauri::WebviewWindow) -> Option<String> {
    let p = app.cursor_position().ok()?;
    app.webview_windows().into_iter().find_map(|(label, w)| {
        if label == window.label() || !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) { return None; }
        let (pos, size) = (w.outer_position().ok()?, w.outer_size().ok()?);
        let inside = p.x >= pos.x as f64 && p.y >= pos.y as f64 && p.x < (pos.x + size.width as i32) as f64 && p.y < (pos.y + size.height as i32) as f64;
        inside.then_some(label)
    })
}
