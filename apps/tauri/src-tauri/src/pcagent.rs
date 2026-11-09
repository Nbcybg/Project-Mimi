//! The PC agent of the desktop app: what packages/desktop/remote.cjs does with packages/pc-agent.
//!
//! The PC agent is what lets the agents of a Mimi server work on this computer (files in the
//! folders the person allowed, commands if they allowed those, a browser). It is a Node program
//! (TypeScript, run by Node 24), so this shell starts it as a child process:
//!   * the token goes to its stdin, never to the environment (other programs of this OS account
//!     could read that); its stdin stays open, because closing it stops the agent;
//!   * it asks before it changes anything: it prints a `@@mimi-consent@@{json}` line, this shell
//!     shows a dialog and answers with a `consent-response` line on its stdin;
//!   * if it stops by itself it is started again (2 s, doubling up to 60 s).
//!
//! What it may touch is chosen in the tray menu and kept in pc-agent.json: off until the person
//! turns it on (a warning dialog says what that allows), the folders it may use (inside the home
//! folder, never the home itself), and the "run commands" switch (also off, also warned).
//!
//! The session (core address + token) comes from the page: shell.js reports it with `pc_session`
//! when the UI has one, and an empty token (signed out) stops the agent.
//!
//! Node: MIMI_NODE, else agent/node/node.exe next to this program (the installer puts it there
//! with the agent: npm run installer), else node.exe beside it, else PATH.
//! The agent's code: MIMI_PC_AGENT_ENTRY, else agent/pc-agent/src/main.ts next to this program,
//! else packages/pc-agent/src/main.ts of the source tree above it (a development run).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItem};
use tauri::{AppHandle, Manager, Url, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const CONFIG_FILE: &str = "pc-agent.json";
const CONSENT_PREFIX: &str = "@@mimi-consent@@";
/// First folder names under the home that stay out of reach (keychains, app data, SSH keys).
const FORBIDDEN_FIRST: [&str; 5] = ["Library", ".ssh", ".gnupg", "AppData", ".mimi"];

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    enabled: bool,
    shell: bool,
    folders: Vec<String>,
    apps: Vec<String>,
}

impl Config {
    fn default_for(home: &Path) -> Self {
        Config { enabled: false, shell: false, folders: vec![home.join("Mimi-Workspace").to_string_lossy().into_owned()], apps: vec![] }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, shell: false, folders: vec![], apps: vec![] }
    }
}

#[derive(Clone, PartialEq)]
struct Session {
    core: String,
    token: String,
}

struct Items {
    status: MenuItem<Wry>,
    enabled: CheckMenuItem<Wry>,
    shell: CheckMenuItem<Wry>,
}

struct Inner {
    /// Bumped by every start and stop: a supervisor thread of an older generation ends itself.
    generation: u64,
    running: bool,
    child: Option<Child>,
    /// Closing it asks the agent to leave (it closes its browser on the way).
    stdin: Option<Arc<Mutex<Option<ChildStdin>>>>,
    session: Option<Session>,
    config: Config,
    status: String,
}

pub struct PcAgent {
    inner: Mutex<Inner>,
    file: PathBuf,
    home: PathBuf,
    items: Mutex<Option<Items>>,
    /// One consent dialog at a time.
    consent: Mutex<()>,
}

// ---------- checks ----------

fn norm(path: &Path) -> Vec<String> {
    path.components()
        .map(|part| {
            let text = part.as_os_str().to_string_lossy().into_owned();
            if cfg!(windows) { text.to_lowercase() } else { text }
        })
        .collect()
}

/// Why this folder may not be given to the agent (None = fine). Same rules as remote-lib.cjs.
pub fn folder_problem(dir: &str, home: &Path) -> Option<String> {
    let path = Path::new(dir);
    if !path.is_absolute() {
        return Some("ต้องเป็นโฟลเดอร์แบบเต็ม (absolute path)".into());
    }
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let home_real = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let (real, home_parts) = (norm(&strip_verbatim(&real)), norm(&strip_verbatim(&home_real)));
    if real == home_parts {
        return Some("เลือกโฟลเดอร์ย่อยในโฮม ไม่ใช่โฮมทั้งหมด".into());
    }
    if real.len() <= home_parts.len() || real[..home_parts.len()] != home_parts[..] {
        return Some("ต้องอยู่ในโฮมของผู้ใช้เครื่องนี้".into());
    }
    let first = &real[home_parts.len()];
    if FORBIDDEN_FIRST.iter().any(|name| {
        let name = if cfg!(windows) { name.to_lowercase() } else { (*name).to_owned() };
        &name == first
    }) {
        return Some(format!("\"{first}\" เป็นโฟลเดอร์ของระบบ ใช้ไม่ได้"));
    }
    None
}

/// `\\?\C:\x` (what canonicalize returns on Windows) -> `C:\x`.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

fn node_path() -> PathBuf {
    if let Some(path) = std::env::var_os("MIMI_NODE").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }
    let file = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        // The installer puts it in agent/node/ (tauri.installer.conf.json); node.exe beside the program also works.
        for beside in [dir.join("agent").join("node").join(file), dir.join(file)] {
            if beside.exists() {
                return beside;
            }
        }
    }
    PathBuf::from("node")
}

fn agent_entry() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MIMI_PC_AGENT_ENTRY").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for packaged in [dir.join("agent").join("pc-agent").join("src").join("main.ts"), dir.join("pc-agent").join("src").join("main.ts")] {
        if packaged.exists() {
            return Some(packaged);
        }
    }
    dir.ancestors().take(8).map(|up| up.join("packages").join("pc-agent").join("src").join("main.ts")).find(|path| path.exists())
}

/// What the person typed or the page reported -> the server's origin, or None.
fn core_origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

fn ws_url(core: &str) -> String {
    let (scheme, rest) = core.split_once("://").unwrap_or(("http", core));
    format!("{}://{}/ws", if scheme == "https" { "wss" } else { "ws" }, rest)
}

// ---------- state ----------

impl PcAgent {
    pub fn load(dir: PathBuf, home: PathBuf) -> Self {
        let file = dir.join(CONFIG_FILE);
        let mut config: Config = std::fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| Config::default_for(&home));
        config.folders.retain(|dir| folder_problem(dir, &home).is_none());
        if config.folders.is_empty() {
            config.folders = Config::default_for(&home).folders;
        }
        PcAgent {
            inner: Mutex::new(Inner { generation: 0, running: false, child: None, stdin: None, session: None, config, status: "ปิด".into() }),
            file,
            home,
            items: Mutex::new(None),
            consent: Mutex::new(()),
        }
    }

    fn save(&self) {
        let config = self.inner.lock().unwrap().config.clone();
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = serde_json::to_string_pretty(&config).map(|text| std::fs::write(&self.file, text));
    }

    /// Adds the PC agent entries to the tray menu and remembers the items to keep them current.
    pub fn menu_items(&self, app: &AppHandle) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>> {
        let (config, status) = {
            let inner = self.inner.lock().unwrap();
            (inner.config.clone(), inner.status.clone())
        };
        let status = MenuItem::with_id(app, "pc-status", format!("PC agent: {status}"), false, None::<&str>)?;
        let enabled = CheckMenuItem::with_id(app, "pc-enable", "ให้ Mimi ใช้เครื่องนี้ (PC agent)", true, config.enabled, None::<&str>)?;
        let shell = CheckMenuItem::with_id(app, "pc-shell", "อนุญาตให้รันคำสั่ง (shell)", true, config.shell, None::<&str>)?;
        let folders = MenuItem::with_id(app, "pc-folders", "โฟลเดอร์ที่ Mimi ใช้ได้…", true, None::<&str>)?;
        *self.items.lock().unwrap() = Some(Items { status: status.clone(), enabled: enabled.clone(), shell: shell.clone() });
        Ok(vec![Box::new(status), Box::new(enabled), Box::new(shell), Box::new(folders)])
    }
}

fn agent(app: &AppHandle) -> tauri::State<'_, PcAgent> {
    app.state::<PcAgent>()
}

fn set_status(app: &AppHandle, text: &str) {
    let agent = agent(app);
    agent.inner.lock().unwrap().status = text.to_owned();
    let items = agent.items.lock().unwrap();
    if let Some(items) = items.as_ref() {
        let _ = items.status.set_text(format!("PC agent: {text}"));
    }
}

fn sync_checks(app: &AppHandle) {
    let agent = agent(app);
    let config = agent.inner.lock().unwrap().config.clone();
    let items = agent.items.lock().unwrap();
    if let Some(items) = items.as_ref() {
        let _ = items.enabled.set_checked(config.enabled);
        let _ = items.shell.set_checked(config.shell);
    }
}

// ---------- running the agent ----------

/// Starts the agent if it is on, a session exists and nothing runs yet.
pub fn start(app: &AppHandle) {
    let (config, session, generation) = {
        let agent = agent(app);
        let mut inner = agent.inner.lock().unwrap();
        if inner.running || !inner.config.enabled || inner.session.is_none() {
            return;
        }
        inner.generation += 1;
        inner.running = true;
        (inner.config.clone(), inner.session.clone().unwrap(), inner.generation)
    };
    let home = agent(app).home.clone();
    let folders: Vec<String> = config.folders.iter().filter(|dir| folder_problem(dir, &home).is_none()).cloned().collect();
    if folders.is_empty() {
        finish_run(app, generation, "ไม่มีโฟลเดอร์ที่ใช้ได้");
        return;
    }
    for dir in &folders {
        let _ = std::fs::create_dir_all(dir);
    }
    let app = app.clone();
    std::thread::spawn(move || supervise(app, generation, config, session, folders));
}

fn finish_run(app: &AppHandle, generation: u64, status: &str) {
    {
        let agent = agent(app);
        let mut inner = agent.inner.lock().unwrap();
        if inner.generation == generation {
            inner.running = false;
        }
    }
    set_status(app, status);
}

/// Stops the agent at once (the thread of the current run sees the new generation and ends).
pub fn stop(app: &AppHandle) {
    let child = {
        let agent = agent(app);
        let mut inner = agent.inner.lock().unwrap();
        inner.generation += 1;
        inner.running = false;
        // Closing stdin asks it to leave (it closes its browser on the way); the kill is the backstop.
        if let Some(stdin) = inner.stdin.take() {
            *stdin.lock().unwrap() = None;
        }
        inner.child.take()
    };
    if let Some(mut child) = child {
        std::thread::spawn(move || {
            for _ in 0..16 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            let _ = child.kill();
            let _ = child.wait();
        });
    }
    set_status(app, "ปิด");
}

fn current(app: &AppHandle, generation: u64) -> bool {
    agent(app).inner.lock().unwrap().generation == generation
}

fn supervise(app: AppHandle, generation: u64, config: Config, session: Session, folders: Vec<String>) {
    let mut retry = Duration::from_secs(2);
    loop {
        if !current(&app, generation) {
            return;
        }
        let Some(entry) = agent_entry() else {
            finish_run(&app, generation, "ไม่พบโค้ด PC agent (packages/pc-agent)");
            return;
        };
        set_status(&app, "กำลังเชื่อมต่อ…");
        let connected = Arc::new(AtomicBool::new(false));
        match spawn_agent(&entry, &config, &session, &folders) {
            Ok(mut child) => {
                let stdin = Arc::new(Mutex::new(child.stdin.take()));
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                {
                    let agent = agent(&app);
                    let mut inner = agent.inner.lock().unwrap();
                    if inner.generation != generation {
                        let _ = child.kill();
                        return;
                    }
                    inner.child = Some(child);
                    inner.stdin = Some(stdin.clone());
                }
                if let Some(pipe) = stdout {
                    let (app, stdin, connected) = (app.clone(), stdin.clone(), connected.clone());
                    std::thread::spawn(move || {
                        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                            on_line(&app, generation, &stdin, &connected, line.trim_end_matches('\r'));
                        }
                    });
                }
                if let Some(pipe) = stderr {
                    let (app, stdin, connected) = (app.clone(), stdin.clone(), connected.clone());
                    std::thread::spawn(move || {
                        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                            on_line(&app, generation, &stdin, &connected, line.trim_end_matches('\r'));
                        }
                    });
                }
                // Wait until it exits (or this run is replaced).
                loop {
                    std::thread::sleep(Duration::from_millis(300));
                    let agent = agent(&app);
                    let mut inner = agent.inner.lock().unwrap();
                    if inner.generation != generation {
                        return;
                    }
                    match inner.child.as_mut().map(|child| child.try_wait()) {
                        Some(Ok(Some(_))) | Some(Err(_)) | None => {
                            inner.child = None;
                            break;
                        }
                        Some(Ok(None)) => {}
                    }
                }
                if connected.load(Ordering::Relaxed) {
                    retry = Duration::from_secs(2);
                }
                set_status(&app, "หยุดไป กำลังเริ่มใหม่…");
            }
            Err(error) => set_status(&app, &format!("เริ่มไม่ได้: {error}")),
        }
        // Back off before the next start, leaving at once if this run was replaced.
        let mut waited = Duration::ZERO;
        while waited < retry {
            if !current(&app, generation) {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
            waited += Duration::from_millis(200);
        }
        retry = (retry * 2).min(Duration::from_secs(60));
    }
}

fn spawn_agent(entry: &Path, config: &Config, session: &Session, folders: &[String]) -> std::io::Result<Child> {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "user".into());
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "pc".into());
    let mut command = Command::new(node_path());
    command
        .arg(entry)
        .env_clear()
        // Only what a shell needs, plus where to connect (the token goes through stdin).
        .env("PATH", var("PATH"))
        .env("USER", &user)
        .env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()))
        .env("MIMI_TOKEN_STDIN", "1")
        .env("MIMI_CONSENT_STDIO", "1")
        .env("MIMI_PC_SHELL", if config.shell { "1" } else { "0" })
        .env("MIMI_CORE_URL", ws_url(&session.core))
        .env("ALLOWED_DIRS", folders.join(";"))
        .env("MIMI_ALLOWED_APPS", config.apps.join(";"))
        .env("MIMI_PC_NAME", format!("{user}@{host}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cfg!(windows) {
        for name in ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
            command.env(name, var(name));
        }
        command.env("HOME", var("USERPROFILE"));
    } else {
        command.env("HOME", var("HOME"));
        if let Some(tmp) = std::env::var_os("TMPDIR") {
            command.env("TMPDIR", tmp);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{}", session.token)?;
        stdin.flush()?;
    }
    Ok(child)
}

/// One line of the agent's output: a consent request, or a status message.
fn on_line(app: &AppHandle, generation: u64, stdin: &Arc<Mutex<Option<ChildStdin>>>, connected: &Arc<AtomicBool>, line: &str) {
    if !current(app, generation) {
        return;
    }
    if let Some(json) = line.strip_prefix(CONSENT_PREFIX) {
        if let Ok(request) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(id) = request.get("id").and_then(|v| v.as_str()) {
                let (app, stdin, id) = (app.clone(), stdin.clone(), id.to_owned());
                std::thread::spawn(move || ask_consent(&app, &stdin, id, &request));
            }
        }
        return; // a malformed line can only be a bug; no action is safer than a guess
    }
    if line.is_empty() {
        return;
    }
    if line.contains("connected to ") {
        connected.store(true, Ordering::Relaxed);
        set_status(app, "เชื่อมต่อแล้ว");
    } else if line.contains("rejected the token") {
        set_status(app, "เซิร์ฟเวอร์ไม่รับ");
    } else if line.contains("disconnected") {
        set_status(app, "หลุด กำลังต่อใหม่…");
    }
}

/// The agent asks, through a dialog, before it changes anything on this computer.
fn ask_consent(app: &AppHandle, stdin: &Arc<Mutex<Option<ChildStdin>>>, id: String, request: &serde_json::Value) {
    let text = |key: &str| request.get(key).and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let tool = text("tool");
    let summary = text("summary");
    let risk = {
        let risk = text("risk");
        if risk.is_empty() { "write".to_owned() } else { risk }
    };
    let message = format!(
        "{}\n\nเครื่องมือ: {tool} ({risk})\nคำขอนี้มาจาก Mimi บนเซิร์ฟเวอร์ และจะทำบนเครื่องนี้เท่านั้น อ่านรายละเอียดก่อนกดอนุญาต",
        if summary.is_empty() { format!("Mimi ขอใช้ {tool} บนเครื่องนี้") } else { summary }
    );
    let allow = {
        let agent = agent(app);
        let _one_at_a_time = agent.consent.lock().unwrap();
        app.dialog()
            .message(message)
            .title("Mimi ขออนุญาตบนเครื่องนี้")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("อนุญาต".into(), "ไม่อนุญาต".into()))
            .blocking_show()
    };
    if let Some(stdin) = stdin.lock().unwrap().as_mut() {
        let _ = writeln!(stdin, "{}", serde_json::json!({ "type": "consent-response", "id": id, "allow": allow }));
        let _ = stdin.flush();
    }
}

// ---------- the page's side (shell.js) ----------

/// The UI has a session (or no longer has one): the agent runs for it, or stops.
#[tauri::command]
pub fn pc_session(app: AppHandle, core: String, token: String) {
    let session = core_origin(&core).filter(|_| !token.is_empty()).map(|core| Session { core, token });
    let changed = {
        let agent = agent(&app);
        let mut inner = agent.inner.lock().unwrap();
        let changed = inner.session != session;
        inner.session = session.clone();
        changed
    };
    if !changed {
        return;
    }
    if session.is_none() {
        stop(&app);
    } else {
        stop(&app);
        start(&app);
    }
}

// ---------- the tray menu ----------

/// A tray item about the PC agent was clicked (the dialogs block, so this runs off the main thread).
pub fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_owned();
    std::thread::spawn(move || match id.as_str() {
        "pc-enable" => {
            let want = agent(&app).items.lock().unwrap().as_ref().and_then(|i| i.enabled.is_checked().ok()).unwrap_or(false);
            set_enabled(&app, want);
        }
        "pc-shell" => {
            let want = agent(&app).items.lock().unwrap().as_ref().and_then(|i| i.shell.is_checked().ok()).unwrap_or(false);
            set_shell(&app, want);
        }
        "pc-folders" => choose_folders(&app),
        _ => {}
    });
}

fn warn(app: &AppHandle, title: &str, message: String, ok: &str, cancel: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()))
        .blocking_show()
}

fn user_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "ผู้ใช้".into())
}

fn set_enabled(app: &AppHandle, enabled: bool) {
    let (was, folders) = {
        let agent = agent(app);
        let inner = agent.inner.lock().unwrap();
        (inner.config.enabled, inner.config.folders.clone())
    };
    if enabled && !was {
        let message = format!(
            "agent บนเซิร์ฟเวอร์จะสั่งงานบนเครื่องนี้ได้ในชื่อผู้ใช้ \"{}\": อ่าน/เขียนไฟล์ในโฟลเดอร์ที่อนุญาต และเปิดเบราว์เซอร์ของ agent (คำสั่งที่เสี่ยงยังต้องให้คุณกดอนุญาต)\n\nโฟลเดอร์ที่อนุญาต:\n{}",
            user_name(),
            folders.join("\n")
        );
        if !warn(app, "ให้ Mimi ใช้เครื่องนี้?", message, "เปิดใช้", "ยกเลิก") {
            sync_checks(app);
            return;
        }
    }
    agent(app).inner.lock().unwrap().config.enabled = enabled;
    agent(app).save();
    if enabled {
        start(app);
    } else {
        stop(app);
    }
    sync_checks(app);
}

fn set_shell(app: &AppHandle, enabled: bool) {
    if enabled {
        let message = format!(
            "คำสั่ง (shell), ปิด/หยุดโปรแกรม, ปิดเครื่อง และ MCP server บนเครื่องนี้ ทำงานด้วยสิทธิ์เต็มของผู้ใช้ \"{}\" ไม่ได้จำกัดอยู่ในโฟลเดอร์ที่อนุญาต (อ่านไฟล์อื่นในโฮมได้) ทุกคำสั่งยังต้องให้คุณกดอนุญาต",
            user_name()
        );
        if !warn(app, "ให้ Mimi รันคำสั่งบนเครื่องนี้?", message, "อนุญาต", "ยกเลิก") {
            sync_checks(app);
            return;
        }
    }
    agent(app).inner.lock().unwrap().config.shell = enabled;
    agent(app).save();
    restart_if_running(app);
    sync_checks(app);
}

fn restart_if_running(app: &AppHandle) {
    let running = agent(app).inner.lock().unwrap().running;
    if running {
        stop(app);
        start(app);
    }
}

fn choose_folders(app: &AppHandle) {
    let home = agent(app).home.clone();
    let Some(picked) = app.dialog().file().set_title("โฟลเดอร์ที่ Mimi ใช้ได้บนเครื่องนี้").set_directory(&home).blocking_pick_folders() else {
        return;
    };
    let paths: Vec<String> = picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| strip_verbatim(&p).to_string_lossy().into_owned()).collect();
    if paths.is_empty() {
        return;
    }
    let problems: Vec<String> = paths.iter().filter_map(|dir| folder_problem(dir, &home).map(|problem| format!("{dir}: {problem}"))).collect();
    if !problems.is_empty() {
        app.dialog().message(problems.join("\n")).title("ใช้โฟลเดอร์นี้ไม่ได้").kind(MessageDialogKind::Error).blocking_show();
        return;
    }
    agent(app).inner.lock().unwrap().config.folders = paths;
    agent(app).save();
    restart_if_running(app);
}
