//! Mimi UI shell on Tauri 2 (spike).
//!
//! Does the same job as packages/desktop (ui-protocol.cjs + remote.cjs + connect.html):
//!   * serves packages/ui from the app bundle (frontendDist), never from the server;
//!   * knows which core to talk to: the one the person typed on the connect page (kept in the
//!     app's data folder), else MIMI_CORE_URL from the process env (desktop development);
//!   * opens the UI with `#core=<origin>[&token=<token>]` in the URL fragment and defines
//!     `window.MimiShell` before any page script runs, so packages/ui accepts the core;
//!   * with no core yet it shows its own connect page (custom scheme `mimiconnect`, no IPC);
//!   * rewrites `connect-src` of the UI's CSP to that core + its ws(s) address (a Tauri CSP in
//!     tauri.conf.json is static; the core is chosen at run time).
//!
//! The password is typed on the UI's own sign-in page; this shell never sees or stores it.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod pcagent;

use tauri::http::{header, HeaderValue, Response};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const CONNECT_SCHEME: &str = "mimiconnect";
const CORE_FILE: &str = "core.txt";
const CONNECT_PAGE: &str = include_str!("connect.html");
const SHELL_SCRIPT: &str = include_str!("shell.js");

/// Origin the app's own pages (packages/ui) are served from.
#[cfg(any(windows, target_os = "android"))]
const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(any(windows, target_os = "android")))]
const APP_ORIGIN: &str = "tauri://localhost";

#[cfg(any(windows, target_os = "android"))]
const CONNECT_URL: &str = "http://mimiconnect.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const CONNECT_URL: &str = "mimiconnect://localhost/";

type SharedCore = Arc<RwLock<Option<String>>>;

/// Percent-encode like encodeURIComponent (the UI reads the fragment with URLSearchParams).
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// What the person typed -> the core's origin (`https://host[:port]`), or why it is not usable.
/// A bare `192.168.0.5:8787` or `localhost:8787` is taken as http (a core on a LAN has no
/// certificate); any other bare host name as https.
fn normalize_core(input: &str) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("ใส่ที่อยู่เซิร์ฟเวอร์ก่อน".into());
    }
    let with_scheme = if text.contains("://") {
        text.to_owned()
    } else {
        let host = text.split(['/', '?', '#']).next().unwrap_or(text);
        let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
        let local = name == "localhost"
            || name.ends_with(".local")
            || name.parse::<std::net::Ipv4Addr>().is_ok()
            || name.starts_with('[');
        format!("{}://{}", if local { "http" } else { "https" }, text)
    };
    let url = Url::parse(&with_scheme).map_err(|_| "ที่อยู่ไม่ถูกต้อง ตัวอย่าง https://mimi.example.com หรือ http://192.168.1.10:8787".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("ใช้ได้เฉพาะ http:// หรือ https://".into());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("ที่อยู่ไม่ถูกต้อง (ห้ามใส่ชื่อผู้ใช้/รหัสผ่านในที่อยู่)".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// `https://host:1` -> ("https://host:1", "wss://host:1")
fn core_sources(core: &str) -> Option<(String, String)> {
    let url = Url::parse(core).ok()?;
    let host = url.host_str()?;
    let hostport = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let hostport = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { hostport };
    let socket = if url.scheme() == "https" { "wss" } else { "ws" };
    Some((url.origin().ascii_serialization(), format!("{socket}://{hostport}")))
}

/// Path of the UI's start page with the core (and, for development, token) in the fragment.
fn ui_path(core: &str, token: Option<&str>) -> String {
    let mut fragment = format!("core={}", encode(core));
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        fragment.push_str(&format!("&token={}", encode(token)));
    }
    format!("index.html#{fragment}")
}

fn ui_url(core: &str) -> String {
    format!("{APP_ORIGIN}/{}&fresh=1", ui_path(core, None))
}

fn core_file(dir: &std::path::Path) -> PathBuf {
    dir.join(CORE_FILE)
}

fn page(status: u16, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        .body(Cow::Owned(body))
        .expect("static response")
}

fn json(status: u16, body: String) -> Response<Cow<'static, [u8]>> {
    page(status, "application/json; charset=utf-8", body.into_bytes())
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| decode(value))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core: SharedCore = Arc::new(RwLock::new(None));
    let for_protocol = core.clone();
    let for_csp = core.clone();

    let builder = tauri::Builder::default();
    // Desktop: a second start shows the running window; "start with the computer"; commands the
    // UI's settings call through window.MimiShell (see shell.js).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show(app, None)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop::open_at_login, desktop::set_open_at_login, desktop::notify, pcagent::pc_session]);

    builder
        // The connect page: GET / shows the form, GET /set?core=... checks and keeps the address.
        .register_uri_scheme_protocol(CONNECT_SCHEME, move |ctx, request| {
            let uri = request.uri();
            match uri.path() {
                "/set" => {
                    let wanted = query_param(uri.query().unwrap_or(""), "core").unwrap_or_default();
                    match normalize_core(&wanted) {
                        Ok(origin) => {
                            let saved = ctx
                                .app_handle()
                                .path()
                                .app_data_dir()
                                .map_err(|e| e.to_string())
                                .and_then(|dir| {
                                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                                    std::fs::write(core_file(&dir), &origin).map_err(|e| e.to_string())
                                });
                            match saved {
                                Ok(()) => {
                                    *for_protocol.write().unwrap() = Some(origin.clone());
                                    json(200, format!("{{\"ok\":true,\"ui\":{}}}", serde_json_string(&ui_url(&origin))))
                                }
                                Err(e) => json(500, format!("{{\"ok\":false,\"error\":{}}}", serde_json_string(&format!("เก็บที่อยู่ไม่ได้: {e}")))),
                            }
                        }
                        Err(message) => json(400, format!("{{\"ok\":false,\"error\":{}}}", serde_json_string(&message))),
                    }
                }
                "/" | "" | "/index.html" => {
                    let current = for_protocol.read().unwrap().clone().unwrap_or_default();
                    let html = CONNECT_PAGE.replace("__CORE__", &escape_html(&current));
                    page(200, "text/html; charset=utf-8", html.into_bytes())
                }
                _ => page(404, "text/plain; charset=utf-8", b"not found".to_vec()),
            }
        })
        // The UI's CSP says 'self' for connect-src; add the core it was told to use (and no other).
        .setup(move |app| {
            let saved = app
                .path()
                .app_data_dir()
                .ok()
                .and_then(|dir| std::fs::read_to_string(core_file(&dir)).ok())
                .and_then(|text| normalize_core(&text).ok());
            let from_env = std::env::var("MIMI_CORE_URL").ok().filter(|v| !v.is_empty()).and_then(|v| normalize_core(&v).ok());
            let token = std::env::var("MIMI_TOKEN").ok().filter(|v| !v.is_empty());
            let chosen = saved.or(from_env.clone());
            *core.write().unwrap() = chosen.clone();

            let url = match &chosen {
                // The env token only goes with the env core (desktop development).
                Some(core) => WebviewUrl::App(ui_path(core, if Some(core) == from_env.as_ref() { token.as_deref() } else { None }).into()),
                None => WebviewUrl::External(CONNECT_URL.parse().expect("connect url")),
            };

            // Runs before the page's own scripts on every page (src/shell.js): defines MimiShell,
            // forgets an old sign-in after the person picked a server, explains a failed connection.
            let script = SHELL_SCRIPT.replace("__CONNECT__", CONNECT_URL);

            let builder = WebviewWindowBuilder::new(app, "main", url)
                .title("Mimi")
                .initialization_script(script)
                .on_web_resource_request(move |_request, response| {
                    let Some(core) = for_csp.read().unwrap().clone() else { return };
                    let Some((origin, socket)) = core_sources(&core) else { return };
                    let Some(value) = response.headers().get(header::CONTENT_SECURITY_POLICY).and_then(|v| v.to_str().ok()).map(str::to_owned) else {
                        return;
                    };
                    if !value.contains("https://api.github.com") {
                        return; // not the UI's policy
                    }
                    let widened = value.replace("connect-src 'self'", &format!("connect-src 'self' {origin} {socket}"));
                    if let Ok(header_value) = HeaderValue::from_str(&widened) {
                        response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, header_value);
                    }
                });
            // Desktop: hidden until it is placed (desktop::setup shows it); links that leave the
            // app open in the system browser.
            #[cfg(desktop)]
            let builder = builder
                .inner_size(430.0, 860.0)
                .min_inner_size(360.0, 560.0)
                .visible(false)
                .on_navigation(desktop::allow_navigation)
                .on_new_window(|url, _features| {
                    desktop::open_outside(&url);
                    tauri::webview::NewWindowResponse::Deny
                });
            #[cfg(desktop)]
            {
                app.manage(desktop::Shared::load(app.path().app_data_dir()?));
                app.manage(pcagent::PcAgent::load(app.path().app_data_dir()?, app.path().home_dir()?));
            }
            let window = builder.build()?;
            #[cfg(desktop)]
            desktop::setup(app.handle(), &window)?;
            #[cfg(not(desktop))]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Mimi Tauri shell");
}

/// A JSON string literal (the few strings above need no more than this).
fn serde_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
