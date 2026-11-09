//! The desktop-only part of the shell: what packages/desktop/main.cjs does around the window.
//!
//!   * a tray icon with the same menu (open chat / Agent / Hub / settings / hide when clicking
//!     elsewhere / always on top / quit); a click on the icon shows or hides the window;
//!   * closing the window hides it (the chat stays as it is); only "Quit" ends the app;
//!   * one instance: starting Mimi again shows the window that is already running;
//!   * the window remembers its size, place and the two tray switches (window-state.json);
//!   * "start with the computer" for the UI's settings switch (MimiShell.openAtLogin);
//!   * links that leave the app open in the system browser, never inside the window.
//!
//! Not ported yet: the built-in browser window and the Workspace window.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const STATE_FILE: &str = "window-state.json";
const VIEWS: [&str; 4] = ["chat", "agents", "hub", "settings"];
/// Same default as the Electron window: made for a phone-shaped chat, in the corner above the tray.
const DEFAULT_WIDTH: f64 = 430.0;
const DEFAULT_HEIGHT: f64 = 860.0;
const MARGIN: f64 = 12.0;

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Prefs {
    bounds: Option<Bounds>,
    maximized: bool,
    hide_on_blur: bool,
    on_top: bool,
}

/// What is remembered, and where. Managed by the app.
pub struct Shared {
    prefs: Mutex<Prefs>,
    file: PathBuf,
    last_write: Mutex<Instant>,
}

impl Shared {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join(STATE_FILE);
        let prefs = std::fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        Shared { prefs: Mutex::new(prefs), file, last_write: Mutex::new(Instant::now() - Duration::from_secs(10)) }
    }

    fn write(&self) {
        let prefs = self.prefs.lock().unwrap().clone();
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Not being able to remember a size is no reason to stop.
        let _ = serde_json::to_string(&prefs).map(|text| std::fs::write(&self.file, text));
        *self.last_write.lock().unwrap() = Instant::now();
    }

    /// Moving or resizing fires many events: write at most twice a second (the rest on hide/quit).
    fn write_soon(&self) {
        if self.last_write.lock().unwrap().elapsed() > Duration::from_millis(500) {
            self.write();
        }
    }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Shows the window, brings it forward and, if asked, switches the UI to one of its views.
pub fn show(app: &AppHandle, view: Option<&str>) {
    let Some(window) = main_window(app) else { return };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(view) = view.filter(|view| VIEWS.contains(view)) {
        // The same hook the Electron shell calls; harmless while the connect page is showing.
        let _ = window.eval(format!("window.Mimi && window.Mimi.setView && window.Mimi.setView('{view}')"));
    }
}

fn quit(app: &AppHandle) {
    if let Some(shared) = app.try_state::<Shared>() {
        shared.write();
    }
    crate::pcagent::stop(app);
    // Give the agent a moment to close its browser; stop() ends it for good after 4 s.
    std::thread::sleep(Duration::from_millis(600));
    app.exit(0);
}

fn remember(app: &AppHandle, window: &WebviewWindow) {
    let Some(shared) = app.try_state::<Shared>() else { return };
    if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
        return;
    }
    {
        let mut prefs = shared.prefs.lock().unwrap();
        prefs.maximized = window.is_maximized().unwrap_or(false);
        if !prefs.maximized && !window.is_fullscreen().unwrap_or(false) {
            if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                prefs.bounds = Some(Bounds { x: position.x, y: position.y, width: size.width, height: size.height });
            }
        }
    }
    shared.write_soon();
}

fn overlaps(area_x: i32, area_y: i32, area_w: u32, area_h: u32, b: &Bounds) -> bool {
    b.x < area_x + area_w as i32 && b.x + b.width as i32 > area_x && b.y < area_y + area_h as i32 && b.y + b.height as i32 > area_y
}

/// The remembered place if it is still on a screen; else the corner above the tray.
fn place(app: &AppHandle, window: &WebviewWindow) {
    let prefs = app.state::<Shared>().prefs.lock().unwrap().clone();
    let monitors = app.available_monitors().unwrap_or_default();
    if let Some(saved) = prefs.bounds.filter(|b| monitors.iter().any(|m| {
        let area = m.work_area();
        overlaps(area.position.x, area.position.y, area.size.width, area.size.height, b)
    })) {
        let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
        let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
    } else if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let margin = (MARGIN * scale) as i32;
        let height = ((DEFAULT_HEIGHT * scale) as i32).min(area.size.height as i32 - 2 * margin).max(1);
        let width = (DEFAULT_WIDTH * scale) as i32;
        let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
        // The size above is the inner one; the frame is a little more, so leave it room.
        let outer = window.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((width, height));
        let x = area.position.x + area.size.width as i32 - outer.0 - margin;
        let y = area.position.y + area.size.height as i32 - outer.1 - margin;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if prefs.maximized {
        let _ = window.maximize();
    }
    let _ = window.set_always_on_top(prefs.on_top);
}

/// Called once the window exists (hidden): places it, hooks its events, adds the tray, shows it.
pub fn setup(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    place(app, window);

    let events_app = app.clone();
    let events_window = window.clone();
    window.on_window_event(move |event| match event {
        // Closing hides: nothing of the chat is lost, the tray icon brings it back.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            remember(&events_app, &events_window);
            if let Some(shared) = events_app.try_state::<Shared>() {
                shared.write();
            }
            let _ = events_window.hide();
        }
        WindowEvent::Focused(false) => {
            let hide = events_app.try_state::<Shared>().map(|s| s.prefs.lock().unwrap().hide_on_blur).unwrap_or(false);
            if hide {
                let _ = events_window.hide();
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember(&events_app, &events_window),
        _ => {}
    });

    let prefs = app.state::<Shared>().prefs.lock().unwrap().clone();
    let open = MenuItem::with_id(app, "open", "เปิดแชต", true, None::<&str>)?;
    let agents = MenuItem::with_id(app, "agents", "Agent", true, None::<&str>)?;
    let hub = MenuItem::with_id(app, "hub", "Hub", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "ตั้งค่า", true, None::<&str>)?;
    let hide_on_blur = CheckMenuItem::with_id(app, "hide-on-blur", "ซ่อนเมื่อคลิกที่อื่น", true, prefs.hide_on_blur, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "on-top", "อยู่บนสุดเสมอ", true, prefs.on_top, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "ออกจาก Mimi", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &agents, &hub, &settings, &separator])?;
    // The PC agent: status, on/off, "run commands", folders (pcagent.rs).
    for item in app.state::<crate::pcagent::PcAgent>().menu_items(app)? {
        menu.append(item.as_ref())?;
    }
    menu.append_items(&[&separator3, &hide_on_blur, &on_top, &separator2, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("mimi")
        .tooltip("Mimi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event({
            let hide_on_blur = hide_on_blur.clone();
            let on_top = on_top.clone();
            move |app, event| match event.id.as_ref() {
                "open" => show(app, Some("chat")),
                "agents" => show(app, Some("agents")),
                "hub" => show(app, Some("hub")),
                "settings" => show(app, Some("settings")),
                "hide-on-blur" => {
                    if let Some(shared) = app.try_state::<Shared>() {
                        shared.prefs.lock().unwrap().hide_on_blur = hide_on_blur.is_checked().unwrap_or(false);
                        shared.write();
                    }
                }
                "on-top" => {
                    let checked = on_top.is_checked().unwrap_or(false);
                    if let Some(shared) = app.try_state::<Shared>() {
                        shared.prefs.lock().unwrap().on_top = checked;
                        shared.write();
                    }
                    if let Some(window) = main_window(app) {
                        let _ = window.set_always_on_top(checked);
                    }
                }
                "pc-enable" | "pc-shell" | "pc-folders" => crate::pcagent::on_menu(app, event.id.as_ref()),
                "quit" => quit(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                match main_window(app) {
                    Some(window) if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) => {
                        let _ = window.hide();
                    }
                    _ => show(app, None),
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    window.show()?;
    Ok(())
}

/// A link that leaves the app: the UI's own pages and the connect page stay in the window.
fn is_app_page(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "mimiconnect" | "about" | "blob" | "data")
        || matches!(url.host_str(), Some("tauri.localhost") | Some("mimiconnect.localhost"))
}

/// Opens an http(s) link in the system browser; anything else is dropped.
pub fn open_outside(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// `on_navigation`: true = the window may go there.
pub fn allow_navigation(url: &Url) -> bool {
    if is_app_page(url) {
        return true;
    }
    open_outside(url);
    false
}

// ---------- system notifications ----------
// The web Notification API is refused inside this window (permission "denied"), so shell.js
// hands the UI's notifications to this command, which shows a native toast.

fn shorten(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(shorten(&title, 120)).body(shorten(&body, 400)).show();
}

// ---------- start with the computer (MimiShell.openAtLogin / setOpenAtLogin) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginState {
    supported: bool,
    open_at_login: bool,
}

fn login_state(app: &AppHandle) -> LoginState {
    LoginState { supported: true, open_at_login: app.autolaunch().is_enabled().unwrap_or(false) }
}

#[tauri::command]
pub fn open_at_login(app: AppHandle) -> LoginState {
    login_state(&app)
}

#[tauri::command]
pub fn set_open_at_login(app: AppHandle, open: bool) -> LoginState {
    let result = if open { app.autolaunch().enable() } else { app.autolaunch().disable() };
    let _ = result;
    login_state(&app)
}
