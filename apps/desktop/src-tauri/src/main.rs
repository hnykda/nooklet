//! The desktop shell (ADR 016).
//!
//! Runs nooklet's own server as a child process and points the window at it, so the app is
//! self-contained: launching it is enough, nothing has to be started first.
//!
//! Three decisions worth knowing:
//!
//! - **If a nooklet server is already listening, use it.** The obvious alternative — always spawn
//!   our own — would put two writers on the same SQLite file whenever someone already runs
//!   `nooklet serve` against the default data directory, which is the normal setup for anyone
//!   using the MCP endpoint from an editor. Sharing the running one is both safer and what the
//!   user actually wants.
//! - **The window loads the server's HTTP origin**, not bundled assets. Same-origin is what keeps
//!   the token handshake, the OPFS replica and the sync socket working exactly as in a browser;
//!   see ADR 016 for why bundling the frontend would drag CORS into the auth path.
//! - **The launcher page is told what happened to the server we started** (`server_status`,
//!   B-430). Opened from Finder, the child's stderr goes nowhere, so a server that refused to start
//!   ("database schema version 6 is newer than this build supports") used to look exactly like no
//!   server at all, and the page advised running `pnpm nooklet serve` — wrong for a self-contained
//!   app, and silent about the actual reason. The child's stderr is now piped, its tail kept, and
//!   its exit noticed; the launcher (`../launcher/`) turns that into words.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Where the app serves from. Matches the CLI's default, so an already-running `nooklet serve`
/// is found rather than duplicated.
const DEFAULT_PORT: u16 = 6100;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// How often startup is checked: fast while it is expected, slower once it is overdue.
const STARTUP_POLL: Duration = Duration::from_millis(150);
const OVERDUE_POLL: Duration = Duration::from_secs(1);
/// How much of the child's stderr the launcher can show. The reason for an exit is its last line
/// or two; a Node stack trace for an unhandled error runs to about twenty.
const STDERR_TAIL_LINES: usize = 40;
const STDERR_LINE_MAX_CHARS: usize = 2000;
/// After the child exits, how long to wait for its last stderr bytes. The pipe reaches EOF when
/// every holder of its write end is gone, and a grandchild (esbuild's service process) can hold it
/// a moment longer than the child itself.
const STDERR_DRAIN_WAIT: Duration = Duration::from_secs(1);

/// What the launcher page is told about the server (`server_status`). The JSON shape is a contract
/// with `../launcher/status.js`; `../test/server-status.json` pins it from both sides.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ServerStatus {
    /// A nooklet server was already answering at launch, so nothing was spawned. If the launcher
    /// cannot reach it now, it was stopped — the one case where "start a server" is the advice.
    External,
    /// Our child is running and has not answered yet.
    Starting,
    /// Our child answers `/healthz`.
    Ready,
    /// The bundled server could not even be launched (a damaged bundle, a missing sidecar).
    SpawnFailed { error: String },
    /// Our child exited before it ever answered.
    Exited {
        /// `None` when a signal ended it.
        code: Option<i32>,
        reason: ExitReason,
        stderr: String,
    },
    /// Still running, still not answering, after `STARTUP_TIMEOUT`.
    TimedOut { stderr: String },
}

/// Why the child exited, as far as its stderr says — only the cases the launcher words differently.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ExitReason {
    /// The graph was written by a newer nooklet (`db.ts#openDb`). The fix is updating the app.
    SchemaTooNew,
    /// Something that is not nooklet holds the port (`nooklet_is_listening` said no, so we spawned).
    PortInUse,
    Other,
}

/// Read from the server's own messages, verified by running `nooklet serve` on 2026-09-13:
/// `nooklet: database schema version 99 is newer than this build supports (6); upgrade nooklet`,
/// and Node's unhandled `Error: listen EADDRINUSE: address already in use 127.0.0.1:6417`.
fn exit_reason(stderr: &str) -> ExitReason {
    if stderr.contains("is newer than this build supports") {
        ExitReason::SchemaTooNew
    } else if stderr.contains("EADDRINUSE") {
        ExitReason::PortInUse
    } else {
        ExitReason::Other
    }
}

/// The last `STDERR_TAIL_LINES` lines the child wrote to stderr, and whether the pipe has closed.
#[derive(Default)]
struct StderrTail {
    state: Mutex<TailState>,
    closed: Condvar,
}

#[derive(Default)]
struct TailState {
    lines: VecDeque<String>,
    closed: bool,
}

impl StderrTail {
    fn push(&self, line: &[u8]) {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end_matches(['\n', '\r']);
        let text: String = if text.chars().count() > STDERR_LINE_MAX_CHARS {
            text.chars().take(STDERR_LINE_MAX_CHARS).chain("…".chars()).collect()
        } else {
            text.to_string()
        };
        let mut state = self.state.lock().unwrap();
        if state.lines.len() == STDERR_TAIL_LINES {
            state.lines.pop_front();
        }
        state.lines.push_back(text);
    }

    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.closed.notify_all();
    }

    /// Wait up to `timeout` for the pipe to close, so an exit is reported with its last words.
    fn wait_closed(&self, timeout: Duration) {
        let state = self.state.lock().unwrap();
        let _ = self.closed.wait_timeout_while(state, timeout, |s| !s.closed);
    }

    fn text(&self) -> String {
        let state = self.state.lock().unwrap();
        state.lines.iter().map(String::as_str).collect::<Vec<_>>().join("\n")
    }
}

/// Copy the child's stderr into `tail`, and on to our own stderr so a terminal launch still shows
/// it. Runs until EOF. It must keep reading: a child whose stderr pipe fills blocks on its next
/// write, which would be a hang this whole change exists to make visible, not to cause.
fn pump_stderr(reader: impl Read, tail: &StderrTail) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let _ = std::io::stderr().write_all(&line);
                tail.push(&line);
            }
        }
    }
    tail.close();
}

/// Spawn `command` with stderr piped into `tail`.
fn spawn_capturing(mut command: Command, tail: Arc<StderrTail>) -> std::io::Result<Child> {
    let mut child = command.stderr(Stdio::piped()).spawn()?;
    match child.stderr.take() {
        Some(stderr) => {
            std::thread::spawn(move || pump_stderr(stderr, &tail));
        }
        None => tail.close(),
    }
    Ok(child)
}

/// Watch a freshly spawned server until it answers or exits, writing each change to `status`.
/// Keeps watching past `timeout` (as `TimedOut`): a slow start that finally fails should still be
/// reported as the failure it is. Returns when the child answers, exits, or has been taken away
/// (the app quitting).
fn watch_startup(
    child: &Mutex<Option<Child>>,
    tail: &StderrTail,
    status: &Mutex<ServerStatus>,
    is_listening: impl Fn() -> bool,
    timeout: Duration,
) {
    let started = Instant::now();
    loop {
        let exited = {
            let mut guard = child.lock().unwrap();
            let Some(c) = guard.as_mut() else { return };
            match c.try_wait() {
                Ok(Some(exit)) => Some(exit.code()),
                Ok(None) => None,
                // Cannot ask about it any more: report it as gone rather than "starting" forever.
                Err(_) => Some(None),
            }
        };
        if let Some(code) = exited {
            tail.wait_closed(STDERR_DRAIN_WAIT);
            let stderr = tail.text();
            let reason = exit_reason(&stderr);
            eprintln!("nooklet: the bundled server exited before answering (code {code:?})");
            *status.lock().unwrap() = ServerStatus::Exited { code, reason, stderr };
            return;
        }
        if is_listening() {
            *status.lock().unwrap() = ServerStatus::Ready;
            return;
        }
        let overdue = started.elapsed() >= timeout;
        if overdue {
            let mut s = status.lock().unwrap();
            if *s == ServerStatus::Starting {
                eprintln!("nooklet: server did not come up within {timeout:?}");
            }
            *s = ServerStatus::TimedOut { stderr: tail.text() };
        }
        std::thread::sleep(if overdue { OVERDUE_POLL } else { STARTUP_POLL });
    }
}

/// The spawned server, kept so it can be stopped when the app quits (a child process that
/// outlives its window is a file lock nobody can see), plus what the launcher is told about it.
struct ServerProcess {
    child: Mutex<Option<Child>>,
    status: Mutex<ServerStatus>,
    stderr: Arc<StderrTail>,
}

/// Asked by the launcher page while it waits. Reachable only from the app's own local pages:
/// Tauri refuses custom commands from a remote origin (the server's `http://127.0.0.1` page)
/// without an explicit capability, and this app defines none.
#[tauri::command]
fn server_status(server: tauri::State<'_, ServerProcess>) -> ServerStatus {
    server.status.lock().unwrap().clone()
}

/// `NOOKLET_PORT` moves the app off 6100 — the only way to run a second copy (a test build) beside
/// the one in daily use without the two sharing one server, one graph and one precached client.
/// Read per call rather than cached: it is a handful of lookups per launch.
fn port() -> u16 {
    std::env::var("NOOKLET_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn addr() -> SocketAddr {
    ([127, 0, 0, 1], port()).into()
}

/// Is *nooklet* answering on the port — as opposed to something else entirely? A bare TCP connect
/// would happily accept any unrelated service and then navigate the window at it.
fn nooklet_is_listening() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", port());
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    // `take` consumes the stream, so read through a borrow and shut down via the original handle.
    let _ = (&mut stream).take(8192).read_to_string(&mut body);
    let _ = stream.shutdown(Shutdown::Both);
    body.contains("\"nooklet\"")
}

/// Executable suffix and loadable-extension suffix for the platform this was built for. Both are
/// decided at compile time: the bundle only ever contains one platform's binaries.
#[cfg(windows)]
const EXE: &str = ".exe";
#[cfg(not(windows))]
const EXE: &str = "";

#[cfg(target_os = "macos")]
const VEC_EXT: &str = "dylib";
#[cfg(target_os = "windows")]
const VEC_EXT: &str = "dll";
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const VEC_EXT: &str = "so";

/// Starts the bundled server. `resource_dir` holds the sidecar assembled by `build-sidecar.mjs`.
fn spawn_server(
    resource_dir: &PathBuf,
    data_dir: &PathBuf,
    tail: Arc<StderrTail>,
) -> std::io::Result<Child> {
    let sidecar = resource_dir.join("sidecar");
    std::fs::create_dir_all(data_dir)?;

    let mut command = Command::new(sidecar.join(format!("node{EXE}")));
    command
        .arg(sidecar.join("server.mjs"))
        .arg("serve")
        .arg("--data")
        .arg(data_dir)
        .arg("--port")
        .arg(port().to_string())
        .arg("--web")
        .arg(sidecar.join("web"))
        // sqlite-vec normally resolves its dylib out of node_modules, which does not exist in an
        // app bundle; without this, semantic and hybrid search quietly degrade to keyword only.
        .env("NOOKLET_SQLITE_VEC_PATH", sidecar.join(format!("vec0.{VEC_EXT}")))
        // esbuild's JS API shells out to a per-platform binary to bundle user plugins.
        .env("ESBUILD_BINARY_PATH", sidecar.join(format!("esbuild{EXE}")))
        .env("NODE_ENV", "production")
        .stdout(Stdio::inherit());
    spawn_capturing(command, tail)
}

/// Where the graph lives.
///
/// The SAME place the CLI defaults to — `$NOOKLET_DATA`, else `~/.nooklet/default` — rather than
/// the platform app-data directory. Using a private location made the app open its own empty
/// graph while `nooklet import` had put everything in the CLI's default, and there was no hint
/// that two graphs even existed: the app just looked like it had lost your notes. One tool, one
/// graph, unless you deliberately point them apart.
fn graph_dir(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = std::env::var("NOOKLET_DATA") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    Ok(app.path().home_dir()?.join(".nooklet").join("default"))
}

/// Runs before any page script in every document the window loads — the launcher and the server's
/// client alike, whatever their origin. It is how a page learns it is inside this shell; the
/// launcher (`../dist/index.html`) reads which port to wait for from it, so `NOOKLET_PORT` moves
/// the launcher too.
///
/// A flag we inject rather than sniffing Tauri's own globals: `__TAURI_INTERNALS__` is an
/// implementation detail of Tauri's IPC, not a statement about this app.
fn shell_script() -> String {
    format!(
        "Object.defineProperty(window,\"__NOOKLET_DESKTOP__\",{{value:Object.freeze({{platform:{:?},port:{}}})}});",
        std::env::consts::OS,
        port()
    )
}

const REPO: &str = "https://github.com/hnykda/nooklet";

/// Menu item ids. The ones the CLIENT answers travel to it as a DOM event
/// (`apps/web/src/platform/desktop-shell.ts` names the same strings); the rest the shell handles.
const MENU_SETTINGS: &str = "settings";
const MENU_SHORTCUTS: &str = "shortcuts";
const MENU_RELOAD: &str = "reload";
const MENU_DOCS: &str = "docs";
const MENU_REPORT_BUG: &str = "report-bug";

/// The macOS menu bar (B-533). Tauri's default had nothing that reaches the app: no Settings…, no
/// Reload, an empty Help. A custom menu REPLACES that default, so everything else in it is carried
/// over item for item — above all Edit: on macOS those items are how Cmd+C/V/X/A/Z reach a text
/// field in a webview. The page should still see every key first — WebKit's
/// `WebViewImpl::performKeyEquivalent` hands a key equivalent to the page and resends only what it
/// leaves unhandled to the menu — so the client's own Cmd+Z undo and Cmd+, are not shadowed, and a
/// Cmd+, that reaches both only opens Settings twice (opening is idempotent). That ordering is
/// read from WebKit, not observed in this app: nothing here can send it keys (B-533).
#[cfg(target_os = "macos")]
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem as P, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let item = |id: &str, text: &str, keys: Option<&str>| MenuItem::with_id(app, id, text, true, keys);

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &P::about(app, None, Some(about))?,
            &P::separator(app)?,
            &item(MENU_SETTINGS, "Settings…", Some("CmdOrCtrl+,"))?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&P::close_window(app, None)?])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(MENU_RELOAD, "Reload", Some("CmdOrCtrl+R"))?,
            &P::separator(app)?,
            &P::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::separator(app)?, &P::close_window(app, None)?],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &item(MENU_SHORTCUTS, "Keyboard Shortcuts", None)?,
            &P::separator(app)?,
            &item(MENU_DOCS, "nooklet Documentation", None)?,
            &item(MENU_REPORT_BUG, "Report a Bug…", None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

fn on_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match id {
        // The client owns these; a page that is not the client (the launcher) just ignores it.
        MENU_SETTINGS | MENU_SHORTCUTS => {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent(\"nooklet:desktop-menu\",{{detail:{id:?}}}))"
            ));
        }
        MENU_RELOAD => {
            let _ = window.reload();
        }
        MENU_DOCS => open_in_browser(&format!("{REPO}#readme")),
        MENU_REPORT_BUG => open_in_browser(&format!("{REPO}/issues/new?template=bug_report.yml")),
        _ => {}
    }
}

/// Hands a link to the system browser. Only web and mail links: `open` asks nothing and would just
/// as happily run a `file://` `.command` or mount an `smb://` share, and a link in a note — text an
/// agent or another device can write — is not a reason to. That also leaves app links
/// (`zotero://…`, which the client renders on purpose) dead here; widening it is an open owner
/// decision in B-534, not an oversight.
fn open_in_browser(url: &str) {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return;
    };
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        eprintln!("nooklet: not opening {url}: only http, https and mailto links leave the app");
        return;
    }
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg(parsed.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let spawned = Command::new("explorer").arg(parsed.as_str()).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let spawned = Command::new("xdg-open").arg(parsed.as_str()).spawn();
    if let Err(err) = spawned {
        eprintln!("nooklet: could not open {url}: {err}");
    }
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .manage(ServerProcess {
            child: Mutex::new(None),
            status: Mutex::new(ServerStatus::Starting),
            stderr: Arc::new(StderrTail::default()),
        })
        .invoke_handler(tauri::generate_handler![server_status])
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir()?;
            let data_dir = graph_dir(&handle)?;
            let server = app.state::<ServerProcess>();

            // Reuse a server that is already running before starting a second one on the same
            // database.
            if nooklet_is_listening() {
                *server.status.lock().unwrap() = ServerStatus::External;
            } else {
                match spawn_server(&resource_dir, &data_dir, server.stderr.clone()) {
                    Ok(child) => {
                        server.child.lock().unwrap().replace(child);
                        let handle = handle.clone();
                        std::thread::spawn(move || {
                            let server = handle.state::<ServerProcess>();
                            watch_startup(
                                &server.child,
                                &server.stderr,
                                &server.status,
                                nooklet_is_listening,
                                STARTUP_TIMEOUT,
                            );
                        });
                    }
                    Err(err) => {
                        eprintln!("nooklet: could not start the bundled server: {err}");
                        *server.status.lock().unwrap() =
                            ServerStatus::SpawnFailed { error: err.to_string() };
                    }
                }
            }

            // The window opens on the launcher, which polls and redirects the moment the server
            // answers — so the app shows something immediately rather than a white rectangle,
            // whether startup takes 200 ms or the server never comes up at all.
            WebviewWindowBuilder::new(&handle, "main", WebviewUrl::default())
                .title("nooklet")
                .inner_size(1100.0, 800.0)
                .min_inner_size(480.0, 400.0)
                .title_bar_style(tauri::TitleBarStyle::Transparent)
                .hidden_title(true)
                .initialization_script(shell_script())
                // A link that asks for a new window — every `target="_blank"` link in a note, the
                // help menu's, `window.open` — did NOTHING: WKWebView asks the UI delegate for a
                // window, and wry answers "none" unless a handler is set (B-534). The system
                // browser is where those links belong; the app keeps its one window.
                .on_new_window(|url, _features| {
                    open_in_browser(url.as_str());
                    NewWindowResponse::Deny
                })
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building nooklet")
        .run(|app, event| {
            // Stop the server we started. Without this the child keeps the database open after the
            // window closes, and the next launch finds a "already running" server it never started.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<ServerProcess>().child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The contract with the launcher page, shared with `../test/launcher-status.test.mjs`.
    fn fixture(name: &str) -> serde_json::Value {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("../../test/server-status.json")).unwrap();
        all.get(name).unwrap_or_else(|| panic!("no fixture {name}")).clone()
    }

    fn json(status: &ServerStatus) -> serde_json::Value {
        serde_json::to_value(status).unwrap()
    }

    #[test]
    fn every_status_serializes_to_the_shape_the_launcher_reads() {
        let schema = "nooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet";
        let cases = [
            ("external", ServerStatus::External),
            ("starting", ServerStatus::Starting),
            ("ready", ServerStatus::Ready),
            (
                "spawn_failed",
                ServerStatus::SpawnFailed { error: "No such file or directory (os error 2)".into() },
            ),
            (
                "schema_too_new",
                ServerStatus::Exited {
                    code: Some(1),
                    reason: exit_reason(schema),
                    stderr: schema.into(),
                },
            ),
            (
                "port_in_use",
                ServerStatus::Exited {
                    code: Some(1),
                    reason: ExitReason::PortInUse,
                    stderr: "nooklet: listen EADDRINUSE: address already in use 127.0.0.1:6100".into(),
                },
            ),
            (
                "exited_other",
                ServerStatus::Exited {
                    code: Some(1),
                    reason: ExitReason::Other,
                    stderr: "nooklet: SQLITE_CANTOPEN: unable to open database file".into(),
                },
            ),
            (
                "killed",
                ServerStatus::Exited { code: None, reason: ExitReason::Other, stderr: String::new() },
            ),
            ("timed_out", ServerStatus::TimedOut { stderr: "nooklet: importing plugins…".into() }),
        ];
        for (name, status) in cases {
            assert_eq!(json(&status), fixture(name), "{name}");
        }
    }

    #[test]
    fn exit_reason_reads_the_servers_own_messages() {
        assert_eq!(
            exit_reason("nooklet: database schema version 99 is newer than this build supports (6); upgrade nooklet"),
            ExitReason::SchemaTooNew
        );
        // Node's unhandled 'error' event: the reason is in the middle of a stack trace.
        let eaddrinuse = "node:events:505\n    throw er; // Unhandled 'error' event\n    ^\n\nError: listen EADDRINUSE: address already in use 127.0.0.1:6100\n    at Server.setupListenHandle [as _listen2] (node:net:2328:16)";
        assert_eq!(exit_reason(eaddrinuse), ExitReason::PortInUse);
        assert_eq!(exit_reason("nooklet: SQLITE_CANTOPEN"), ExitReason::Other);
        assert_eq!(exit_reason(""), ExitReason::Other);
    }

    #[test]
    fn the_tail_keeps_the_last_lines_and_survives_bad_bytes() {
        let tail = StderrTail::default();
        for i in 0..(STDERR_TAIL_LINES + 5) {
            tail.push(format!("line {i}\n").as_bytes());
        }
        let text = tail.text();
        assert!(!text.contains("line 4\n"), "the oldest lines are dropped");
        assert!(text.starts_with("line 5\n"));
        assert!(text.ends_with(&format!("line {}", STDERR_TAIL_LINES + 4)));

        let tail = StderrTail::default();
        tail.push(b"graf \xC4\x8Dten\xFF\r\n");
        tail.push("x".repeat(STDERR_LINE_MAX_CHARS + 50).as_bytes());
        let text = tail.text();
        assert!(text.starts_with("graf čten\u{FFFD}\n"), "{text}");
        assert_eq!(text.lines().nth(1).unwrap().chars().count(), STDERR_LINE_MAX_CHARS + 1);
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    /// B-430 end to end, minus Tauri: a child that says what the real server said and exits is
    /// reported as that exit, with its words, not as a server that never answered.
    #[cfg(unix)]
    #[test]
    fn a_child_that_exits_during_startup_is_reported_with_its_stderr() {
        let tail = Arc::new(StderrTail::default());
        let child = spawn_capturing(
            sh("echo 'verify: OK' >&2; echo 'nooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet' >&2; exit 1"),
            tail.clone(),
        )
        .unwrap();
        let child = Mutex::new(Some(child));
        let status = Mutex::new(ServerStatus::Starting);
        watch_startup(&child, &tail, &status, || false, Duration::from_secs(20));
        assert_eq!(
            *status.lock().unwrap(),
            ServerStatus::Exited {
                code: Some(1),
                reason: ExitReason::SchemaTooNew,
                stderr: "verify: OK\nnooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet".into(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_answers_is_ready_and_one_that_is_slow_is_timed_out_then_exited() {
        // Answers on the third check.
        let tail = Arc::new(StderrTail::default());
        let child = Mutex::new(Some(spawn_capturing(sh("sleep 5"), tail.clone()).unwrap()));
        let status = Mutex::new(ServerStatus::Starting);
        let checks = AtomicUsize::new(0);
        watch_startup(
            &child,
            &tail,
            &status,
            || checks.fetch_add(1, Ordering::SeqCst) >= 2,
            Duration::from_secs(20),
        );
        assert_eq!(*status.lock().unwrap(), ServerStatus::Ready);
        let _ = child.lock().unwrap().as_mut().unwrap().kill();

        // Never answers: overdue at once, then its exit still arrives as the exit.
        let tail = Arc::new(StderrTail::default());
        let child = Mutex::new(Some(
            spawn_capturing(sh("echo 'still loading' >&2; sleep 2.5; exit 3"), tail.clone()).unwrap(),
        ));
        let status = Mutex::new(ServerStatus::Starting);
        let seen_timed_out = std::thread::scope(|scope| {
            let watcher = scope.spawn(|| watch_startup(&child, &tail, &status, || false, Duration::ZERO));
            let mut seen = false;
            while !watcher.is_finished() {
                if let ServerStatus::TimedOut { stderr } = &*status.lock().unwrap() {
                    seen |= stderr == "still loading";
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            seen
        });
        assert!(seen_timed_out, "reported as timed out, with its output, while still running");
        assert_eq!(
            *status.lock().unwrap(),
            ServerStatus::Exited { code: Some(3), reason: ExitReason::Other, stderr: "still loading".into() }
        );
    }

    #[test]
    fn the_watch_ends_when_the_app_has_taken_the_child_away() {
        let tail = StderrTail::default();
        let child: Mutex<Option<Child>> = Mutex::new(None);
        let status = Mutex::new(ServerStatus::Starting);
        watch_startup(&child, &tail, &status, || false, Duration::ZERO);
        assert_eq!(*status.lock().unwrap(), ServerStatus::Starting);
    }
}
