//! The desktop shell (ADR 016, ADR 032).
//!
//! Runs nooklet's own server as a child process, keeps the one list of graphs this Mac knows, and
//! points the window at the graph that is open.
//!
//! Decisions worth knowing:
//!
//! - **If a nooklet server is already listening, use it.** The obvious alternative — always spawn
//!   our own — would put two writers on the same SQLite file whenever someone already runs
//!   `nooklet serve` against the default data directory, which is the normal setup for anyone
//!   using the MCP endpoint from an editor. Sharing the running one is both safer and what the
//!   user actually wants.
//! - **The bundled server always runs** (ADR 032), whichever graph is open. It used to be started
//!   only when This Mac was the active graph, a decision made once per launch, so every switch
//!   between This Mac and a server restarted the app (B-785). Idle, it costs a Node process.
//! - **The window loads the graph's own HTTP origin**, not bundled assets. Same-origin is what keeps
//!   the token handshake, the OPFS replica and the sync socket working exactly as in a browser;
//!   see ADR 016 for why bundling the frontend would drag CORS into the auth path.
//! - **The shell owns the graph list** (`graph_list.rs`, proposal 005): This Mac's graphs from disk
//!   and server graphs from `desktop.json`, with each server graph's token in the system keychain
//!   (`token_store.rs`). The in-app graph menu reads it from `__NOOKLET_DESKTOP__` and changes it
//!   through `ShellRequest`s; adding a server is checked here, from Rust (`connect.rs`), because
//!   from the page it would be a cross-origin request the server refuses (B-704).
//! - **One window per opened server graph** (`open_window`). The only way to hand the page its
//!   token before any of its scripts run is the initialization script, and that is fixed when the
//!   window is built. So opening a server graph builds a fresh window whose script carries that one
//!   graph's token, scoped to its origin and path (`shell_script`), and closes the old one.
//!   Navigations among This Mac's graphs stay in the same window.
//! - **The launcher page is told what happened to the server we started** (`server_status`,
//!   B-430). Opened from Finder, the child's stderr goes nowhere, so a server that refused to start
//!   ("database schema version 6 is newer than this build supports") used to look exactly like no
//!   server at all. The child's stderr is piped, its tail kept, and its exit noticed; the launcher
//!   (`../launcher/`) turns that into words. Each window starts on the launcher ("Connecting…"),
//!   which opens the graph the moment it answers, or says it could not be reached.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
// Two lines, not one `{…}`: `tools/probes/desktop-harness/wire.py` anchors on the second.
use tauri::webview::DownloadEvent;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

mod connect;
mod graph_list;
mod mac_delete;
mod token_store;

use graph_list::{list_local_graphs, slug_for_label, DesktopConfig, GraphKey, PageGraph};
use token_store::TokenStore;

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

// ---------------------------------------------------------------------------------------------
// The graph list on disk (`desktop.json`).

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(app.path().app_config_dir()?.join("desktop.json"))
}

/// Reads the list. A file in an older shape is migrated once: the new shape is written and the old
/// file kept beside it as `desktop.json.v1.bak` (never overwritten, so a second migration cannot
/// replace the original). Missing or unreadable means an empty list, never a failed launch.
fn read_config(app: &tauri::AppHandle) -> DesktopConfig {
    let Ok(path) = config_path(app) else {
        return DesktopConfig::default();
    };
    let text = std::fs::read_to_string(&path).ok();
    let loaded = graph_list::load(text.as_deref());
    if loaded.migrated {
        let backup = path.with_file_name("desktop.json.v1.bak");
        if !backup.exists() {
            let _ = std::fs::copy(&path, &backup);
        }
        if let Err(err) = write_config(app, &loaded.config) {
            eprintln!("nooklet: could not write the migrated graph list: {err}");
        }
    }
    loaded.config
}

fn write_config(app: &tauri::AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let path = config_path(app).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    // Write-then-rename: a crash mid-write must not leave half a list.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Makes a graph on This Mac with the bundled server's own CLI (`nooklet graph create`, the same
/// thing `POST /graphs` does). The running server opens it lazily, on its first request.
fn create_local_graph(resource_dir: &Path, data_dir: &Path, id: &str, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    run_graph_cli(resource_dir, data_dir, &["create", id, "--label", label], "graph create failed").map(drop)
}

/// `nooklet graph <args> --data <data_dir>` with the bundled server's own CLI. Its stdout when it
/// worked, else the last line it wrote to stderr (the CLI's own reason).
fn run_graph_cli(resource_dir: &Path, data_dir: &Path, args: &[&str], fallback: &str) -> Result<String, String> {
    let sidecar = resource_dir.join("sidecar");
    let output = Command::new(sidecar.join(format!("node{EXE}")))
        .arg(sidecar.join("server.mjs"))
        .arg("graph")
        .args(args)
        .arg("--data")
        .arg(data_dir)
        .env("NOOKLET_SQLITE_VEC_PATH", sidecar.join(format!("vec0.{VEC_EXT}")))
        .env("ESBUILD_BINARY_PATH", sidecar.join(format!("esbuild{EXE}")))
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run the bundled server: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(fallback).to_string())
    }
}

/// B-786: retires a This-Mac graph when no server is running to do it (`mac_delete.rs`): the CLI's
/// `graph retire`, which itself refuses while a server holds the data folder (`serve.pid`). Returns
/// the retired folder's name, read from the CLI's own "nooklet graph unretire <name>" line.
fn retire_with_cli(resource_dir: &Path, data_dir: &Path, id: &str) -> Result<String, String> {
    let out = run_graph_cli(resource_dir, data_dir, &["retire", id], "graph retire failed")?;
    retired_name_from_cli(&out)
        .ok_or_else(|| "The graph was retired, but nooklet could not tell where to. Look in graphs-retired/ in nooklet's data folder.".into())
}

/// The CLI's words, as printed on 2026-10-05: `retired "x": moved to …/graphs-retired/x-<time>` and
/// `Nothing was deleted. To bring it back: nooklet graph unretire x-<time> (add --as …)`.
fn retired_name_from_cli(stdout: &str) -> Option<String> {
    stdout.split_whitespace().skip_while(|w| *w != "unretire").nth(1).map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// What a page can ask of the shell.

/// What a page in the window can ask of the shell by navigating to an address under
/// `SHELL_REQUEST_HOST` (B-643). The window shows a SERVER's page and Tauri gives such a page no
/// IPC (no capability is defined; `desktop-remote-mode.md` proved an `invoke` from there is
/// rejected), but every navigation reaches `on_navigation`, whatever its origin: this is the one
/// door.
///
/// Every request must carry the window's `key` (`random_key`), which only that window's
/// main-frame documents get, from the initialization script. An iframe's navigations reach
/// `on_navigation` too, but an iframe never runs the script (it is main-frame only), so an
/// embedded page cannot make requests. Any page the main frame shows can, which is the same
/// exposure ADR 028 accepted: it can make an empty graph on This Mac, add a server it chooses
/// (with a token it chooses), rename a graph, or remove a server graph from the list (that graph's
/// data stays on its server; its unsynced changes stay in this Mac's copy until it is added again),
/// or list a server's graphs with a root token it already has. Deleting a This-Mac graph (B-786) is
/// narrower: only the bundled server's own page may ask (`delete_mac_graph`), never the open graph,
/// `default` or the last one, and the folder goes to the Trash.
#[derive(Debug, PartialEq)]
enum ShellRequest {
    NewLocalGraph { req: String, label: String },
    ConnectServer { req: String, address: String, credential: Credential },
    Rename { req: String, graph: GraphKey, label: String },
    Remove { req: String, graph: GraphKey },
    /// B-789: "Show in Finder" on an image. Only This Mac's graphs have their files here, so only
    /// a `mac:` graph is accepted; `asset` is an asset id (`[a-z0-9]`, no extension, no path), and
    /// the file is looked up in that graph's own `assets/` (`find_asset_file`), so the page names
    /// nothing on disk.
    RevealAsset { req: String, graph: String, asset: String },
    /// B-786: delete a graph on This Mac (`mac_delete.rs`). Its own kind, not `remove` with a `mac:`
    /// key, so a page and a shell from different versions can never turn "forget a server" into
    /// "delete a folder". `graph` is the id of a `mac:` key; every other check is the shell's.
    DeleteMacGraph { req: String, graph: String },
    /// B-787: list the graphs on the server at `address`, with its root token. The token is used for
    /// that one request (`connect::list_server_graphs`) and never stored.
    ListServerGraphs { req: String, address: String, root_token: String },
}

#[derive(Debug, PartialEq)]
enum Credential {
    Token(String),
    Code { code: String, device: String },
}

impl ShellRequest {
    fn req(&self) -> &str {
        match self {
            ShellRequest::NewLocalGraph { req, .. }
            | ShellRequest::ConnectServer { req, .. }
            | ShellRequest::Rename { req, .. }
            | ShellRequest::Remove { req, .. }
            | ShellRequest::RevealAsset { req, .. }
            | ShellRequest::DeleteMacGraph { req, .. }
            | ShellRequest::ListServerGraphs { req, .. } => req,
        }
    }
}

/// `.invalid` is reserved never to resolve (RFC 2606): if this shell is not there to intercept the
/// address (a browser, an older app), the navigation fails instead of reaching anyone.
const SHELL_REQUEST_HOST: &str = "nooklet-desktop.invalid";
const MAX_URL_CHARS: usize = 2048;

fn parse_shell_request(url: &tauri::Url, key: &str) -> Option<ShellRequest> {
    if url.host_str() != Some(SHELL_REQUEST_HOST) {
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if param("key").as_deref() != Some(key) {
        return None;
    }
    let req = param("req").filter(|r| !r.is_empty() && r.len() <= 40 && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))?;
    match url.path() {
        "/new-local-graph" => {
            let label = graph_list::clean_label(&param("label")?);
            (!label.is_empty()).then_some(ShellRequest::NewLocalGraph { req, label })
        }
        "/connect-server" => {
            let address = param("address").filter(|a| a.len() <= MAX_URL_CHARS)?;
            let credential = match (param("token"), param("code")) {
                (Some(token), None) => connect::token_is_plausible(&token).then_some(Credential::Token(token))?,
                (None, Some(code)) => {
                    let device = graph_list::clean_label(&param("device").unwrap_or_default());
                    let device = if device.is_empty() { "Mac".to_string() } else { device };
                    connect::pairing_code_is_valid(&code).then_some(Credential::Code { code, device })?
                }
                _ => return None,
            };
            Some(ShellRequest::ConnectServer { req, address, credential })
        }
        "/rename" => {
            let graph = GraphKey::parse(&param("graph")?)?;
            let label = graph_list::clean_label(&param("label")?);
            (!label.is_empty()).then_some(ShellRequest::Rename { req, graph, label })
        }
        "/remove" => Some(ShellRequest::Remove { req, graph: GraphKey::parse(&param("graph")?)? }),
        "/reveal-asset" => {
            let GraphKey::Mac(graph) = GraphKey::parse(&param("graph")?)? else {
                return None;
            };
            let asset = param("asset").filter(|a| is_asset_id(a))?;
            Some(ShellRequest::RevealAsset { req, graph, asset })
        }
        "/delete-mac-graph" => {
            let GraphKey::Mac(graph) = GraphKey::parse(&param("graph")?)? else {
                return None;
            };
            Some(ShellRequest::DeleteMacGraph { req, graph })
        }
        "/list-server-graphs" => {
            let address = param("address").filter(|a| a.len() <= MAX_URL_CHARS)?;
            let root_token = param("token").filter(|t| connect::token_is_plausible(t))?;
            Some(ShellRequest::ListServerGraphs { req, address, root_token })
        }
        _ => None,
    }
}

/// An asset id as the server makes them (ADR 004: lowercase base-36), with room to spare. Nothing
/// that could be a path: no `.`, no `/`.
fn is_asset_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// B-789: the file of asset `asset` in a This-Mac graph: `<data>/graphs/<graph>/assets/<asset>.<ext>`
/// (the server's layout, `packages/server/src/assets/store.ts`). Found by listing the folder
/// rather than trusting an extension from the page; a symlink is not followed, as the importer
/// does not follow one either.
fn find_asset_file(data_dir: &Path, graph: &str, asset: &str) -> Option<PathBuf> {
    if !graph_list::is_valid_graph_id(graph) || !is_asset_id(asset) {
        return None;
    }
    let dir = data_dir.join("graphs").join(graph).join("assets");
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name();
        let name = name.to_str()?;
        let (stem, _ext) = name.rsplit_once('.')?;
        let file = entry.file_type().ok()?.is_file();
        (stem == asset && file).then(|| entry.path())
    })
}

/// Selects `path` in a Finder window (`open -R`), or opens its folder elsewhere.
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(format!("/select,{}", path.display())).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path.parent().unwrap_or(path)).status();
    match status {
        Ok(s) if s.success() || cfg!(target_os = "windows") => Ok(()),
        Ok(s) => Err(format!("Couldn't show the file ({s}).")),
        Err(err) => Err(format!("Couldn't show the file ({err}).")),
    }
}

/// 128 random bits as hex: the window's request key.
fn random_key() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // No randomness at all is not something to limp on with a guessable key.
        panic!("nooklet: the system random source is unavailable");
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------
// The window.

/// What the shell keeps for the life of the app.
struct Shell {
    resource_dir: PathBuf,
    data_dir: PathBuf,
    tokens: Box<dyn TokenStore>,
    http: Box<dyn connect::Http + Send + Sync>,
    /// Serializes every read-modify-write of `desktop.json`. Never held while waiting on the main
    /// thread, and the main thread only ever `try_lock`s it.
    lock: Mutex<()>,
    /// Serializes window swaps (`open_window`).
    swap: Mutex<()>,
    /// The window currently showing (`main-<n>`).
    window_label: Mutex<String>,
    window_seq: AtomicU32,
    /// Bumped on every change to the list; a window built before it shows a stale menu, so its
    /// next navigation to a graph rebuilds it (`needs_new_window`).
    list_version: AtomicU64,
    /// One request at a time: a double click must not make two graphs.
    busy: AtomicBool,
}

/// Fixed for one window: what its initialization script was built with.
#[derive(Clone)]
struct WindowFacts {
    key: String,
    /// The server graph this window was built to open, if any. Its script carries that graph's
    /// token when the keychain has one; when it has none, the page asks on the add form, and a
    /// token entered there opens a new window (`handle_shell_request`), so this window must NOT
    /// rebuild itself for the graph it was built for — that would loop, rebuilding forever.
    server_for: Option<String>,
    list_version: u64,
    local_ids: Vec<String>,
}

/// Whether a navigation to `graph` needs a new window rather than this one: a server graph this
/// window was not built for (its script cannot carry that graph's token), a This-Mac graph its list has not heard of (made by
/// the CLI or an import since), or any graph once the list has changed.
fn needs_new_window(facts: &WindowFacts, graph: &GraphKey, list_version: u64, on_disk: impl Fn(&str) -> bool) -> bool {
    if facts.list_version != list_version {
        return true;
    }
    match graph {
        GraphKey::Server(id) => facts.server_for.as_deref() != Some(id.as_str()),
        GraphKey::Mac(id) => !facts.local_ids.iter().any(|l| l == id) && on_disk(id),
    }
}

/// Where the launcher page goes once the graph answers (`__NOOKLET_DESKTOP__.connect`).
#[derive(Serialize)]
struct ConnectTarget<'a> {
    url: &'a str,
    place: &'static str,
    label: &'a str,
}

/// The token a window hands its page, and exactly where.
struct ScopedToken<'a> {
    /// The graph's address, `https://host[:port][/proxy]/g/<id>`.
    address: &'a str,
    token: &'a str,
}

/// Runs before any page script in every main-frame document the window loads — the launcher and
/// every graph's client alike, whatever their origin. It is how a page learns it is inside this
/// shell, and it is the only channel from the shell to a page before that page's own code runs.
///
/// **The token's scope.** At most one token is in the script: the server graph this window was
/// built to open. It is exposed as `__NOOKLET_DESKTOP__.graphToken` only when the document's
/// `location.origin` is that graph's origin AND `location.pathname` is the graph's path or below
/// it (`/g/work`, `/g/work/…`, never `/g/workshop`); in every other document it is `null`. The
/// check runs before any page script, so a page cannot fake its location to it. The script is
/// main-frame only (`initialization_script`, not `_for_all_frames`), so no iframe gets anything.
/// Other server graphs' tokens are never in this window at all: opening one builds a new window
/// (`open_window`). What this does not stop: the main frame of this window being navigated to some
/// other origin still receives the script's text in its web content process, though not the value;
/// a nooklet page opens external links in the browser (`on_new_window`), so the window only shows
/// nooklet pages in practice.
///
/// `graphs` is the menu's list (`PageGraph`), `connect` the launcher's target, `key` the request
/// key (`ShellRequest`), `downloads: true` that `<a download>` is saved (B-736), `reveal: true` that
/// this shell answers `reveal-asset` (B-789: an older one never would), and `deleteMac` /
/// `listServerGraphs` that it answers `delete-mac-graph` (B-786) and `list-server-graphs` (B-787). A
/// server graph's page comes from that server and may be newer than this shell; without the flag it
/// would send a request nothing answers.
fn shell_script(port: u16, key: &str, graphs: &[PageGraph], connect: Option<&ConnectTarget>, token: Option<&ScopedToken>) -> String {
    let scoped = token.and_then(|t| {
        let url = tauri::Url::parse(t.address).ok()?;
        Some(serde_json::json!({
            "origin": url.origin().ascii_serialization(),
            "path": url.path().trim_end_matches('/'),
            "token": t.token,
        }))
    });
    let json = |v: serde_json::Value| serde_json::to_string(&v).unwrap_or_else(|_| "null".into());
    format!(
        "(function(){{var t={scoped};var here=t!==null&&location.origin===t.origin&&(location.pathname===t.path||location.pathname.indexOf(t.path+\"/\")===0);Object.defineProperty(window,\"__NOOKLET_DESKTOP__\",{{value:Object.freeze({{platform:{os},port:{port},downloads:true,reveal:true,deleteMac:true,listServerGraphs:true,key:{key},graphs:Object.freeze({graphs}),connect:{connect},graphToken:here?t.token:null}})}});}})();",
        scoped = json(scoped.unwrap_or(serde_json::Value::Null)),
        os = json(serde_json::Value::from(std::env::consts::OS)),
        key = json(serde_json::Value::from(key)),
        graphs = serde_json::to_string(graphs).unwrap_or_else(|_| "[]".into()),
        connect = connect.map(|c| serde_json::to_string(c).unwrap_or_else(|_| "null".into())).unwrap_or_else(|| "null".into()),
    )
}

fn current_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let label = app.state::<Shell>().window_label.lock().unwrap().clone();
    app.get_webview_window(&label)
}

/// Opens `graph` (landing on `land`, default its address) in a new window built for it, then closes
/// the previous one. Also records it as the graph to open at the next launch.
fn open_window(app: &tauri::AppHandle, graph: GraphKey, land: Option<String>) -> Result<(), String> {
    let shell = app.state::<Shell>();
    // One swap at a time. Held while the window is built, which waits on the main thread, so the
    // main thread must never wait on it: `on_navigation` does not take it.
    let _swap = shell.swap.lock().unwrap();
    let (script, facts) = {
        let _guard = shell.lock.lock().unwrap();
        let mut config = read_config(app);
        let local = list_local_graphs(&shell.data_dir);
        // A server graph removed meanwhile opens This Mac instead.
        let graph = match &graph {
            GraphKey::Server(id) if config.server(id).is_none() => GraphKey::Mac("default".into()),
            _ => graph,
        };
        let rows = config.page_graphs(&local, port());
        let (address, label, place) = match &graph {
            GraphKey::Mac(id) => {
                let label = rows.iter().find(|g| g.key == graph.to_key()).map(|r| r.label.clone()).unwrap_or_else(|| id.clone());
                (format!("http://127.0.0.1:{}/g/{id}", port()), label, "mac")
            }
            GraphKey::Server(id) => {
                let entry = config.server(id).expect("checked above");
                (entry.address.clone(), entry.label.clone(), "server")
            }
        };
        let token = match &graph {
            GraphKey::Server(_) => shell.tokens.get(&address).unwrap_or_else(|err| {
                eprintln!("nooklet: {err}");
                None
            }),
            GraphKey::Mac(_) => None,
        };
        if config.set_open(&graph) {
            if let Err(err) = write_config(app, &config) {
                eprintln!("nooklet: could not remember the open graph: {err}");
            }
        }
        let land = land.unwrap_or_else(|| address.clone());
        let facts = WindowFacts {
            key: random_key(),
            server_for: match &graph {
                GraphKey::Server(id) => Some(id.clone()),
                GraphKey::Mac(_) => None,
            },
            list_version: shell.list_version.load(Ordering::SeqCst),
            local_ids: local.iter().map(|g| g.id.clone()).collect(),
        };
        let script = shell_script(
            port(),
            &facts.key,
            &rows,
            Some(&ConnectTarget { url: &land, place, label: &label }),
            token.as_deref().map(|token| ScopedToken { address: &address, token }).as_ref(),
        );
        (script, facts)
    };
    let old = current_window(app);
    let label = format!("main-{}", shell.window_seq.fetch_add(1, Ordering::SeqCst));
    build_window(app, &label, script, facts, old.as_ref()).map_err(|e| e.to_string())?;
    *shell.window_label.lock().unwrap() = label;
    if let Some(old) = old {
        let _ = old.destroy();
    }
    Ok(())
}

/// One window: the launcher first (`WebviewUrl::default()`), which opens the graph.
fn build_window(
    app: &tauri::AppHandle,
    label: &str,
    script: String,
    facts: WindowFacts,
    like: Option<&tauri::WebviewWindow>,
) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("nooklet")
        .inner_size(1100.0, 800.0)
        .min_inner_size(480.0, 400.0)
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .hidden_title(true)
        .initialization_script(script);
    // The new window takes the old one's place, so a switch reads as the page changing.
    if let Some(old) = like {
        let scale = old.scale_factor().unwrap_or(1.0);
        if let (Ok(pos), Ok(size)) = (old.outer_position(), old.inner_size()) {
            builder = builder
                .position(f64::from(pos.x) / scale, f64::from(pos.y) / scale)
                .inner_size(f64::from(size.width) / scale, f64::from(size.height) / scale);
        }
        if old.is_fullscreen().unwrap_or(false) {
            builder = builder.fullscreen(true);
        } else if old.is_maximized().unwrap_or(false) {
            builder = builder.maximized(true);
        }
    }
    let nav_app = app.clone();
    let download_app = app.clone();
    builder
        .on_navigation(move |url| on_navigation(&nav_app, &facts, url))
        // A link that asks for a new window — every `target="_blank"` link in a note, the
        // help menu's, `window.open` — did NOTHING: WKWebView asks the UI delegate for a
        // window, and wry answers "none" unless a handler is set (B-534). The system
        // browser is where those links belong; the app keeps its one window.
        .on_new_window(|url, _features| {
            open_in_browser(url.as_str());
            NewWindowResponse::Deny
        })
        // B-736: without a download handler wry answers every `<a download>` (and every
        // response WebKit cannot show) with `Cancel`, so "Download" on an image did
        // nothing. Saved where a browser would save it: ~/Downloads, under the page's
        // suggested name, de-duplicated by wry. macOS reports no path on `Finished`, so
        // the chosen one is remembered from `Requested` to tell the page.
        .on_download({
            let pending: Arc<Mutex<std::collections::HashMap<String, PathBuf>>> = Default::default();
            move |_webview, event| {
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        pending.lock().unwrap().insert(url.to_string(), destination.clone());
                    }
                    DownloadEvent::Finished { url, success, .. } => {
                        let path = pending.lock().unwrap().remove(url.as_str());
                        let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
                        let shown = path.as_deref().map(display_path);
                        report_download(&download_app, url.as_str(), success, name.as_deref(), shown.as_deref());
                    }
                    _ => {}
                }
                true
            }
        })
        .build()
}

/// Every navigation of the window (main frame and iframes alike: wry does not say which).
fn on_navigation(app: &tauri::AppHandle, facts: &WindowFacts, url: &tauri::Url) -> bool {
    if url.host_str() == Some(SHELL_REQUEST_HOST) {
        if let Some(request) = parse_shell_request(url, &facts.key) {
            let shell = app.state::<Shell>();
            if !shell.busy.swap(true, Ordering::SeqCst) {
                let app = app.clone();
                // Off the navigation callback: a request may run a process or wait on a server.
                std::thread::spawn(move || {
                    handle_shell_request(&app, request);
                    app.state::<Shell>().busy.store(false, Ordering::SeqCst);
                });
            } else {
                reply(app, request.req(), Err("nooklet is still busy with the last request.".into()), None);
            }
        }
        // Never let it through, request or not: `.invalid` goes nowhere anyway.
        return false;
    }
    let shell = app.state::<Shell>();
    let config = read_config(app);
    let Some(graph) = config.graph_of_url(url, port()) else {
        return true;
    };
    let version = shell.list_version.load(Ordering::SeqCst);
    let data_dir = shell.data_dir.clone();
    let on_disk = |id: &str| data_dir.join("graphs").join(id).is_dir();
    if needs_new_window(facts, &graph, version, on_disk) {
        let app = app.clone();
        let land = url.to_string();
        std::thread::spawn(move || {
            if let Err(err) = open_window(&app, graph, Some(land)) {
                eprintln!("nooklet: could not open that graph: {err}");
            }
        });
        return false;
    }
    // A switch within this window (among This Mac's graphs): remembered for the next launch.
    // `try_lock`: this is the main thread, which must never wait on a thread that may itself be
    // waiting on the main thread; missing one such note costs only which graph opens next launch.
    if let Ok(_guard) = shell.lock.try_lock() {
        let mut config = read_config(app);
        if config.set_open(&graph) {
            let _ = write_config(app, &config);
        }
    }
    true
}

/// Answers a request (`apps/web/src/platform/desktop-shell.ts#DESKTOP_REPLY_EVENT`): its id, ok or
/// the reason it failed, and the list as it now is.
fn reply(app: &tauri::AppHandle, req: &str, result: Result<(), String>, graphs: Option<Vec<PageGraph>>) {
    if let Some(window) = current_window(app) {
        let detail = serde_json::json!({
            "req": req,
            "ok": result.is_ok(),
            "error": result.err(),
            "graphs": graphs,
        });
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent(\"nooklet:desktop-reply\",{{detail:{detail}}}))"));
    }
}

fn handle_shell_request(app: &tauri::AppHandle, request: ShellRequest) {
    let req = request.req().to_string();
    let shell = app.state::<Shell>();
    let result = match request {
        ShellRequest::NewLocalGraph { label, .. } => {
            let taken: Vec<String> = list_local_graphs(&shell.data_dir).into_iter().map(|g| g.id).collect();
            let id = slug_for_label(&label, &taken);
            create_local_graph(&shell.resource_dir, &shell.data_dir, &id, &label).and_then(|()| {
                shell.list_version.fetch_add(1, Ordering::SeqCst);
                open_window(app, GraphKey::Mac(id), None)
            })
        }
        ShellRequest::ConnectServer { address, credential, .. } => {
            connect_server(&*shell.tokens, &*shell.http, &address, credential).and_then(|(address, label)| {
                let id = {
                    let _guard = shell.lock.lock().unwrap();
                    let mut config = read_config(app);
                    let id = config.upsert_server(&address, label.as_deref());
                    write_config(app, &config)?;
                    id
                };
                shell.list_version.fetch_add(1, Ordering::SeqCst);
                open_window(app, GraphKey::Server(id), None)
            })
        }
        ShellRequest::Rename { graph, label, .. } => {
            let _guard = shell.lock.lock().unwrap();
            let mut config = read_config(app);
            let result = config.rename(&graph, &label).and_then(|()| write_config(app, &config));
            if result.is_ok() {
                shell.list_version.fetch_add(1, Ordering::SeqCst);
            }
            let rows = config.page_graphs(&list_local_graphs(&shell.data_dir), port());
            reply(app, &req, result, Some(rows));
            return;
        }
        ShellRequest::RevealAsset { graph, asset, .. } => {
            let result = find_asset_file(&shell.data_dir, &graph, &asset)
                .ok_or_else(|| "That picture's file isn't in this graph's folder on this Mac.".to_string())
                .and_then(|path| reveal_in_file_manager(&path));
            reply(app, &req, result, None);
            return;
        }
        ShellRequest::ListServerGraphs { address, root_token, .. } => {
            // The root token lives only in this stack frame: not in desktop.json, not in the
            // keychain, not in a log line (no error below quotes it).
            let listed = connect::list_server_graphs(&*shell.http, &address, &root_token);
            drop(root_token);
            reply_listing(app, &req, listed);
            return;
        }
        ShellRequest::DeleteMacGraph { graph, .. } => {
            let result = delete_mac_graph(app, &graph);
            if let Err(err) = &result {
                eprintln!("nooklet: {err}");
            }
            let config = read_config(app);
            let rows = config.page_graphs(&list_local_graphs(&shell.data_dir), port());
            reply(app, &req, result, Some(rows));
            return;
        }
        ShellRequest::Remove { graph, .. } => {
            let _guard = shell.lock.lock().unwrap();
            let mut config = read_config(app);
            let showing = current_window(app).and_then(|w| w.url().ok()).and_then(|u| config.graph_of_url(&u, port()));
            let result = remove_server(&*shell.tokens, &mut config, &graph, showing.as_ref())
                .and_then(|()| write_config(app, &config));
            if result.is_ok() {
                shell.list_version.fetch_add(1, Ordering::SeqCst);
            }
            let rows = config.page_graphs(&list_local_graphs(&shell.data_dir), port());
            reply(app, &req, result, Some(rows));
            return;
        }
    };
    // A request that opened a graph has no page left to answer when it worked.
    if let Err(err) = result {
        eprintln!("nooklet: {err}");
        reply(app, &req, Err(err), None);
    }
}

/// "Connect to a server": checks the address, trades a pairing code for a token if that is what
/// was given, checks the token against the graph, and stores it. Returns the normalized address
/// and the graph's own label. Nothing is stored unless the server accepted the token.
fn connect_server(
    tokens: &dyn TokenStore,
    http: &dyn connect::Http,
    raw_address: &str,
    credential: Credential,
) -> Result<(String, Option<String>), String> {
    let address = graph_list::normalize_server_address(raw_address)?;
    let named_no_graph = graph_list::names_no_graph(raw_address);
    let token = match credential {
        Credential::Token(token) => token,
        Credential::Code { code, device } => connect::redeem_code(http, &address, &code, &device)?,
    };
    let label = connect::verify_token(http, &address, &token, named_no_graph)?;
    tokens.set(&address, &token)?;
    Ok((address, label))
}

/// B-786: deletes This-Mac graph `id` (`mac_delete.rs`): checked, retired by whichever of the
/// running server or the CLI holds the data folder, then moved to the Trash; its display name is
/// dropped from `desktop.json`.
///
/// Only a page of the bundled server itself may ask (the window is on `http://127.0.0.1:<port>`):
/// that is the client this app ships. A server graph's page is whatever that server serves, and the
/// typed "delete" confirmation is the page's; a page that skipped it could otherwise put a This-Mac
/// graph in the Trash. The page offers deletion only there (`DesktopGraphMenu.tsx`).
fn delete_mac_graph(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let _guard = shell.lock.lock().unwrap();
    let mut config = read_config(app);
    let here = current_window(app).and_then(|w| w.url().ok());
    if here.as_ref().map(|u| u.origin().ascii_serialization()) != Some(format!("http://127.0.0.1:{}", port())) {
        return Err("Open a graph on this Mac to delete one of its graphs.".into());
    }
    let showing = here.and_then(|u| config.graph_of_url(&u, port()));
    let local = list_local_graphs(&shell.data_dir);
    let retire = |id: &str| {
        if nooklet_is_listening() {
            mac_delete::retire_on_server(&*shell.http, port(), &shell.data_dir, id)
        } else {
            retire_with_cli(&shell.resource_dir, &shell.data_dir, id)
        }
    };
    let result = mac_delete::delete_mac_graph(&shell.data_dir, id, showing.as_ref(), &local, retire, mac_delete::move_to_trash);
    // Once retired the graph is out of `graphs/` whether or not the Trash took it: forget its name.
    if !shell.data_dir.join("graphs").join(id).exists() {
        config.mac_labels.remove(id);
        if config.open == Some(graph_list::OpenGraph::Mac { id: id.to_string() }) {
            config.open = None;
        }
        if let Err(err) = write_config(app, &config) {
            eprintln!("nooklet: {err}");
        }
        shell.list_version.fetch_add(1, Ordering::SeqCst);
    }
    result
}

/// B-787: answers `list-server-graphs` with the graphs the server hosts.
fn reply_listing(app: &tauri::AppHandle, req: &str, listed: Result<Vec<connect::ListedGraph>, String>) {
    if let Some(window) = current_window(app) {
        let (ok, error, graphs) = match listed {
            Ok(graphs) => (true, None, Some(graphs)),
            Err(err) => (false, Some(err), None),
        };
        let detail = serde_json::json!({ "req": req, "ok": ok, "error": error, "serverGraphs": graphs });
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent(\"nooklet:desktop-reply\",{{detail:{detail}}}))"));
    }
}

/// Takes a server graph off the list and forgets its token. Not the graph on screen (the menu
/// offers removal only for the others), and never one of This Mac's, which are folders on disk.
fn remove_server(
    tokens: &dyn TokenStore,
    config: &mut DesktopConfig,
    graph: &GraphKey,
    showing: Option<&GraphKey>,
) -> Result<(), String> {
    let GraphKey::Server(id) = graph else {
        return Err("A graph on this Mac is a folder in nooklet's data directory; it can't be removed from here.".into());
    };
    if showing == Some(graph) {
        return Err("This graph is open. Open another graph first.".into());
    }
    let address = config.remove_server(id).ok_or("That graph is not in the list any more.")?;
    if let Err(err) = tokens.delete(&address) {
        // The entry is gone either way; a stray keychain item is harmless and is replaced if the
        // graph is added again.
        eprintln!("nooklet: {err}");
    }
    Ok(())
}

/// B-736: tells the page how a download it started ended (`apps/web/src/platform/desktop-shell.ts#
/// DESKTOP_DOWNLOAD_EVENT`). `name` is the file actually written — wry picks `name (1).ext` when
/// the suggested one is taken — so the page can say where to look.
fn report_download(app: &tauri::AppHandle, url: &str, ok: bool, name: Option<&str>, path: Option<&str>) {
    if let Some(window) = current_window(app) {
        let detail = serde_json::json!({ "ok": ok, "url": url, "name": name, "path": path });
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent(\"nooklet:desktop-download\",{{detail:{detail}}}))"
        ));
    }
}

/// B-744: the saved file's path as a person would type it, `~/Downloads/x.png` rather than the
/// full home path, for the page's "Saved to …" message.
fn display_path(path: &std::path::Path) -> String {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if let Ok(rest) = path.strip_prefix(&home) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

const REPO: &str = "https://github.com/hnykda/nooklet";

/// Menu item ids. The ones the CLIENT answers travel to it as a DOM event
/// (`apps/web/src/platform/desktop-shell.ts` names the same strings); the rest the shell handles.
const MENU_SETTINGS: &str = "settings";
const MENU_SHORTCUTS: &str = "shortcuts";
const MENU_RELOAD: &str = "reload";
const MENU_DOCS: &str = "docs";
const MENU_REPORT_BUG: &str = "report-bug";
/// Opens the in-app graph menu (proposal 005): the client answers it like Settings…. It used to be
/// "Switch Server…", which restarted the app into a separate picker page (B-784, B-785).
const MENU_GRAPHS: &str = "graphs";

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
            &item(MENU_GRAPHS, "Graphs…", None)?,
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

fn on_menu(app: &tauri::AppHandle, id: &str) {
    let Some(window) = current_window(app) else {
        return;
    };
    match id {
        // The client owns these; a page that is not the client (the launcher) just ignores it.
        MENU_SETTINGS | MENU_SHORTCUTS | MENU_GRAPHS => {
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
            app.manage(Shell {
                resource_dir: resource_dir.clone(),
                data_dir: data_dir.clone(),
                tokens: Box::new(token_store::Keychain),
                http: Box::new(connect::Ureq::new()),
                lock: Mutex::new(()),
                swap: Mutex::new(()),
                window_label: Mutex::new(String::new()),
                window_seq: AtomicU32::new(1),
                list_version: AtomicU64::new(0),
                busy: AtomicBool::new(false),
            });

            // ADR 032: the bundled server runs whichever graph is open, so opening This Mac never
            // needs a restart. Reuse one that is already running before starting a second one on
            // the same database.
            let server = app.state::<ServerProcess>();
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
                        *server.status.lock().unwrap() = ServerStatus::SpawnFailed { error: err.to_string() };
                    }
                }
            }

            // The graph last open, in a window that starts on the launcher ("Connecting…"), which
            // opens it the moment it answers — so the app shows something immediately rather than
            // a white rectangle, whether startup takes 200 ms or the graph never answers at all.
            let config = read_config(&handle);
            let first = config.launch_graph(&list_local_graphs(&data_dir));
            open_window(&handle, first, None)?;
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
    use token_store::MemoryStore;

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

    #[test]
    fn b744_a_saved_file_is_shown_under_the_home_shorthand() {
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME is set in tests"));
        assert_eq!(display_path(&home.join("Downloads/shed (1).png")), "~/Downloads/shed (1).png");
        assert_eq!(display_path(std::path::Path::new("/Volumes/x/a.png")), "/Volumes/x/a.png");
    }

    // Proposal 005 / ADR 032: requests, connecting, removing, the window's script.

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn request(path_and_query: &str) -> Option<ShellRequest> {
        parse_shell_request(&url(&format!("http://nooklet-desktop.invalid{path_and_query}")), KEY)
    }

    #[test]
    fn b780_requests_need_the_windows_key() {
        let token = format!("nk_{}", "ab".repeat(24));
        let ok = format!("/connect-server?key={KEY}&req=r1&address=https%3A%2F%2Fnotes.example.com%2Fg%2Fwork&token={token}");
        assert_eq!(
            request(&ok),
            Some(ShellRequest::ConnectServer {
                req: "r1".into(),
                address: "https://notes.example.com/g/work".into(),
                credential: Credential::Token(token.clone()),
            })
        );
        // Without the key, or with another window's, nothing: an iframe never has it.
        assert_eq!(request(&ok.replace(&format!("key={KEY}&"), "")), None);
        assert_eq!(request(&ok.replace(KEY, "ffffffffffffffffffffffffffffffff")), None);
        // Another host is not a request at all.
        assert_eq!(parse_shell_request(&url(&format!("https://evil.example{ok}")), KEY), None);
    }

    #[test]
    fn b780_each_request_kind_is_read_strictly() {
        assert_eq!(
            request(&format!("/new-local-graph?key={KEY}&req=a&label=Quiet%20Otter%0A")),
            Some(ShellRequest::NewLocalGraph { req: "a".into(), label: "Quiet Otter".into() })
        );
        assert_eq!(
            request(&format!("/connect-server?key={KEY}&req=a&address=https%3A%2F%2Fh.example&code=nkp_abcdefghijklmnopqrstuv&device=")),
            Some(ShellRequest::ConnectServer {
                req: "a".into(),
                address: "https://h.example".into(),
                credential: Credential::Code { code: "nkp_abcdefghijklmnopqrstuv".into(), device: "Mac".into() },
            })
        );
        assert_eq!(
            request(&format!("/rename?key={KEY}&req=a&graph=server%3As1&label=Work")),
            Some(ShellRequest::Rename { req: "a".into(), graph: GraphKey::Server("s1".into()), label: "Work".into() })
        );
        assert_eq!(
            request(&format!("/remove?key={KEY}&req=a&graph=mac%3Adefault")),
            Some(ShellRequest::Remove { req: "a".into(), graph: GraphKey::Mac("default".into()) })
        );
        let token = format!("nk_{}", "ab".repeat(24));
        for bad in [
            format!("/new-local-graph?key={KEY}&req=a&label=%20"),
            format!("/new-local-graph?key={KEY}&label=x"),
            format!("/new-local-graph?key={KEY}&req=a%20b&label=x"),
            format!("/connect-server?key={KEY}&req=a&address=https%3A%2F%2Fh.example"),
            format!("/connect-server?key={KEY}&req=a&address=https%3A%2F%2Fh.example&token=bad%0Atoken"),
            format!("/connect-server?key={KEY}&req=a&address=https%3A%2F%2Fh.example&token={token}&code=nkp_abcdefghijklmnopqrstuv"),
            format!("/connect-server?key={KEY}&req=a&address=https%3A%2F%2Fh.example&code=nkp_short"),
            format!("/rename?key={KEY}&req=a&graph=other%3Ax&label=x"),
            format!("/remove?key={KEY}&req=a"),
            format!("/add-server-graph?key={KEY}&req=a&url=https%3A%2F%2Fh.example"),
            format!("/open-local-graph?key={KEY}&req=a&id=default"),
            // B-789: only This Mac's graphs, and only an asset id — never a path.
            format!("/reveal-asset?key={KEY}&req=a&graph=server%3As1&asset=abc"),
            format!("/reveal-asset?key={KEY}&req=a&graph=mac%3Adefault&asset=..%2F..%2Fgraph.sqlite"),
            format!("/reveal-asset?key={KEY}&req=a&graph=mac%3Adefault&asset=abc.png"),
            format!("/reveal-asset?key={KEY}&req=a&graph=mac%3A..&asset=abc"),
            format!("/reveal-asset?key={KEY}&req=a&graph=mac%3Adefault"),
        ] {
            assert_eq!(request(&bad), None, "{bad}");
        }
    }

    #[test]
    fn b786_b787_the_new_requests_are_read_strictly() {
        assert_eq!(
            request(&format!("/delete-mac-graph?key={KEY}&req=a&graph=mac%3Agarden")),
            Some(ShellRequest::DeleteMacGraph { req: "a".into(), graph: "garden".into() })
        );
        let root = format!("nkroot_{}", "ab".repeat(24));
        assert_eq!(
            request(&format!("/list-server-graphs?key={KEY}&req=a&address=https%3A%2F%2Fh.example&token={root}")),
            Some(ShellRequest::ListServerGraphs { req: "a".into(), address: "https://h.example".into(), root_token: root.clone() })
        );
        for bad in [
            // Deleting is for This Mac's graphs only, by a valid id; `remove` never deletes.
            format!("/delete-mac-graph?key={KEY}&req=a&graph=server%3As1"),
            format!("/delete-mac-graph?key={KEY}&req=a&graph=mac%3A..%2Fdefault"),
            format!("/delete-mac-graph?key={KEY}&req=a&graph=mac%3A"),
            format!("/delete-mac-graph?key={KEY}&req=a&graph=garden"),
            format!("/delete-mac-graph?key={KEY}&req=a"),
            format!("/delete-mac-graph?req=a&graph=mac%3Agarden"),
            format!("/list-server-graphs?key={KEY}&req=a&address=https%3A%2F%2Fh.example"),
            format!("/list-server-graphs?key={KEY}&req=a&address=https%3A%2F%2Fh.example&token=bad%0Atoken"),
            format!("/list-server-graphs?key={KEY}&req=a&token={root}"),
        ] {
            assert_eq!(request(&bad), None, "{bad}");
        }
    }

    #[test]
    fn b786_the_clis_retired_name_is_read_from_its_words() {
        let out = "retired \"garden\": moved to /data/graphs-retired/garden-20261005T084756Z\nNothing was deleted. To bring it back: nooklet graph unretire garden-20261005T084756Z (add --as <id> to restore it under another id).\n";
        assert_eq!(retired_name_from_cli(out).as_deref(), Some("garden-20261005T084756Z"));
        assert_eq!(retired_name_from_cli("something else"), None);
    }

    /// B-787: listing with a root token stores it nowhere. The listing is given the store, the HTTP
    /// double and a fresh config folder the way the shell has them, and afterwards neither the
    /// keychain stand-in nor any file holds the token.
    #[test]
    fn b787_the_root_token_is_never_written_to_disk_or_the_keychain() {
        struct Lists(Mutex<Vec<Option<String>>>);
        impl connect::Http for Lists {
            fn post_json(&self, _: &str, _: Option<&str>, _: &str) -> Result<(u16, String), String> {
                unreachable!("listing never POSTs")
            }
            fn call(&self, _: &str, _: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
                self.0.lock().unwrap().push(bearer.map(str::to_string));
                Ok((200, r#"{"graphs":[{"id":"work","label":"Work"}]}"#.into()))
            }
        }
        let root = format!("nkroot_{}", "cd".repeat(24));
        let tokens = MemoryStore::default();
        let http = Lists(Mutex::default());
        let request = request(&format!(
            "/list-server-graphs?key={KEY}&req=a&address=https%3A%2F%2Fnotes.example.com&token={root}"
        ))
        .unwrap();
        let ShellRequest::ListServerGraphs { address, root_token, .. } = request else { panic!() };
        // `handle_shell_request`'s branch: the listing, then the reply. No TokenStore, no config
        // write is reachable from it (`connect::list_server_graphs` takes neither).
        let listed = connect::list_server_graphs(&http, &address, &root_token).unwrap();
        assert_eq!(listed[0].address, "https://notes.example.com/g/work");
        assert_eq!(*http.0.lock().unwrap(), vec![Some(root.clone())], "sent once, as the bearer");
        assert_eq!(tokens.get("https://notes.example.com/g/work"), Ok(None));
        assert_eq!(tokens.get("https://notes.example.com/g/default"), Ok(None));
        // The reply carries the graphs, never the token.
        let detail = serde_json::json!({ "serverGraphs": listed }).to_string();
        assert!(!detail.contains(&root), "{detail}");
        // Connecting afterwards with the root token itself is refused before the keychain is
        // touched: the server rejects it as a device token, and nothing is stored on a refusal.
        let server = FakeServer { accepts: Some("nk_the_device_token"), ..Default::default() };
        assert!(connect_server(&tokens, &server, "https://notes.example.com/g/work", Credential::Token(root.clone())).is_err());
        assert_eq!(tokens.get("https://notes.example.com/g/work"), Ok(None));
    }

    #[test]
    fn b789_reveal_asset_is_read_strictly_and_finds_only_that_graphs_file() {
        assert_eq!(
            request(&format!("/reveal-asset?key={KEY}&req=a&graph=mac%3Adefault&asset=1k7f3q9xz2havc")),
            Some(ShellRequest::RevealAsset { req: "a".into(), graph: "default".into(), asset: "1k7f3q9xz2havc".into() })
        );
        let root = std::env::temp_dir().join(format!("nooklet-reveal-{}", random_key()));
        let assets = root.join("graphs").join("garden").join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("1k7f3q9xz2havc.png"), b"png").unwrap();
        std::fs::write(assets.join("1k7f3q9xz2havd.jpg"), b"jpg").unwrap();
        std::fs::create_dir_all(root.join("graphs").join("other").join("assets")).unwrap();
        assert_eq!(find_asset_file(&root, "garden", "1k7f3q9xz2havc"), Some(assets.join("1k7f3q9xz2havc.png")));
        assert_eq!(find_asset_file(&root, "garden", "1k7f3q9xz2havd"), Some(assets.join("1k7f3q9xz2havd.jpg")));
        // Not in that graph, not an id, not a graph.
        assert_eq!(find_asset_file(&root, "other", "1k7f3q9xz2havc"), None);
        assert_eq!(find_asset_file(&root, "garden", "1k7f3q9xz2hav"), None);
        assert_eq!(find_asset_file(&root, "garden", "../garden/assets/1k7f3q9xz2havc"), None);
        assert_eq!(find_asset_file(&root, "..", "1k7f3q9xz2havc"), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", assets.join("1k7f3q9xz2have.png")).unwrap();
            assert_eq!(find_asset_file(&root, "garden", "1k7f3q9xz2have"), None, "a symlink is not followed");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[derive(Default)]
    struct FakeServer {
        accepts: Option<&'static str>,
        asked: Mutex<Vec<String>>,
    }

    impl connect::Http for FakeServer {
        fn post_json(&self, url: &str, bearer: Option<&str>, _body: &str) -> Result<(u16, String), String> {
            self.asked.lock().unwrap().push(url.to_string());
            if url.ends_with("/pairing.redeem") {
                return Ok((200, format!(r#"{{"token":"{}"}}"#, self.accepts.unwrap_or("nk_x"))));
            }
            match (self.accepts, bearer) {
                (Some(good), Some(given)) if good == given => Ok((200, r#"{"graph":{"label":"Work"}}"#.into())),
                (Some(_), _) => Ok((401, String::new())),
                (None, _) => Err("Connection refused".into()),
            }
        }
    }

    #[test]
    fn b782_connecting_stores_the_token_only_when_the_server_accepts_it() {
        let good = format!("nk_{}", "ab".repeat(24));
        let tokens = MemoryStore::default();
        let server = FakeServer { accepts: Some(Box::leak(good.clone().into_boxed_str())), ..Default::default() };

        let wrong = connect_server(&tokens, &server, "https://notes.example.com/g/work", Credential::Token("nk_wrongwrong".into()));
        assert!(wrong.unwrap_err().contains("rejected"));
        assert_eq!(tokens.get("https://notes.example.com/g/work"), Ok(None), "nothing stored on a refusal");

        let ok = connect_server(&tokens, &server, "https://notes.example.com/g/work/", Credential::Token(good.clone()));
        assert_eq!(ok, Ok(("https://notes.example.com/g/work".into(), Some("Work".into()))));
        assert_eq!(tokens.get("https://notes.example.com/g/work"), Ok(Some(good.clone())));

        // A pairing code is redeemed first, then the token it gave is checked like a typed one.
        let tokens = MemoryStore::default();
        let paired = connect_server(
            &tokens,
            &server,
            "https://notes.example.com/g/work",
            Credential::Code { code: "nkp_abcdefghijklmnopqrstuv".into(), device: "Mac".into() },
        );
        assert!(paired.is_ok(), "{paired:?}");
        assert_eq!(
            *server.asked.lock().unwrap().iter().rev().take(2).rev().cloned().collect::<Vec<_>>(),
            [
                "https://notes.example.com/g/work/api/v1/pairing.redeem".to_string(),
                "https://notes.example.com/g/work/api/v1/graph.overview".to_string()
            ]
        );
        assert_eq!(tokens.get("https://notes.example.com/g/work"), Ok(Some(good)));

        let down = FakeServer::default();
        let err = connect_server(&tokens, &down, "http://192.168.1.5:6100", Credential::Token("nk_abcdefgh".into()));
        assert_eq!(err, Err("Couldn't reach 192.168.1.5:6100: Connection refused".into()));
        assert!(connect_server(&tokens, &down, "notes.example.com", Credential::Token("nk_abcdefgh".into()))
            .unwrap_err()
            .contains("http://"));
    }

    #[test]
    fn b781_removing_a_server_forgets_its_token_but_never_the_open_graph_or_this_macs() {
        let tokens = MemoryStore::default();
        let mut config = DesktopConfig::default();
        let a = config.upsert_server("https://a.example.com/g/default", None);
        let b = config.upsert_server("https://b.example.com/g/default", None);
        tokens.set("https://a.example.com/g/default", "nk_a").unwrap();
        tokens.set("https://b.example.com/g/default", "nk_b").unwrap();

        let open = GraphKey::Server(b.clone());
        assert!(remove_server(&tokens, &mut config, &open, Some(&open)).unwrap_err().contains("is open"));
        assert!(remove_server(&tokens, &mut config, &GraphKey::Mac("default".into()), None).is_err());
        remove_server(&tokens, &mut config, &GraphKey::Server(a.clone()), Some(&open)).unwrap();
        assert!(config.server(&a).is_none() && config.server(&b).is_some());
        assert_eq!(tokens.get("https://a.example.com/g/default"), Ok(None));
        assert_eq!(tokens.get("https://b.example.com/g/default"), Ok(Some("nk_b".into())));
        assert!(remove_server(&tokens, &mut config, &GraphKey::Server(a), None).is_err());
    }

    #[test]
    fn b785_only_a_new_token_or_a_changed_list_needs_a_new_window() {
        let facts = WindowFacts {
            key: KEY.into(),
            server_for: Some("s1".into()),
            list_version: 3,
            local_ids: vec!["default".into(), "quiet-otter".into()],
        };
        let never = |_: &str| false;
        let always = |_: &str| true;
        // The graph it was built for, token or not: never again (a window without a token for it
        // shows the add form; rebuilding would loop).
        assert!(!needs_new_window(&facts, &GraphKey::Server("s1".into()), 3, never));
        assert!(needs_new_window(&facts, &GraphKey::Server("s2".into()), 3, never));
        assert!(!needs_new_window(&facts, &GraphKey::Mac("quiet-otter".into()), 3, never));
        assert!(needs_new_window(&facts, &GraphKey::Mac("new-one".into()), 3, always), "made since, by the CLI");
        assert!(!needs_new_window(&facts, &GraphKey::Mac("typo".into()), 3, never), "not a graph: let the server say so");
        assert!(needs_new_window(&facts, &GraphKey::Mac("default".into()), 4, never), "the list changed");
    }

    /// Runs the window's initialization script in Node with a stand-in `location`, and returns what
    /// the page would see as `graphToken`. `None` when Node is not installed (it is wherever this
    /// repo builds, since the sidecar and the web client need it).
    fn token_seen_at(script: &str, href: &str) -> Option<serde_json::Value> {
        let harness = format!(
            "const u=new URL({href});globalThis.window=globalThis;globalThis.location={{origin:u.origin,pathname:u.pathname}};{script};process.stdout.write(JSON.stringify(window.__NOOKLET_DESKTOP__.graphToken))",
            href = serde_json::to_string(href).unwrap(),
        );
        let output = Command::new("node").arg("-e").arg(harness).output().ok()?;
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        Some(serde_json::from_slice(&output.stdout).unwrap())
    }

    #[test]
    fn b782_the_token_is_injected_only_into_its_graphs_own_documents() {
        let graphs = vec![PageGraph {
            key: "server:s1".into(),
            place: "server",
            id: "s1".into(),
            label: "Work".into(),
            address: "https://notes.example.com/g/work".into(),
        }];
        let token = ScopedToken { address: "https://notes.example.com/g/work", token: "nk_secret" };
        let target = ConnectTarget { url: "https://notes.example.com/g/work", place: "server", label: "Work" };
        let script = shell_script(6100, KEY, &graphs, Some(&target), Some(&token));
        assert_eq!(script.matches("nk_secret").count(), 1, "the one token, once");

        let Some(here) = token_seen_at(&script, "https://notes.example.com/g/work/journals") else {
            eprintln!("node not found: skipping the scoping check");
            return;
        };
        assert_eq!(here, serde_json::json!("nk_secret"));
        assert_eq!(token_seen_at(&script, "https://notes.example.com/g/work").unwrap(), serde_json::json!("nk_secret"));
        for elsewhere in [
            "https://notes.example.com/g/workshop/journals", // another graph that shares a prefix
            "https://notes.example.com/g/other",             // another graph on the same server
            "https://notes.example.com/",                    // the server, no graph
            "http://notes.example.com/g/work",               // another scheme: another origin
            "https://notes.example.com:8443/g/work",         // another port: another origin
            "https://evil.example/g/work",                   // another server, same path
            "http://127.0.0.1:6100/g/default",               // This Mac
            "tauri://localhost/index.html",                  // the launcher
        ] {
            assert_eq!(token_seen_at(&script, elsewhere).unwrap(), serde_json::Value::Null, "{elsewhere}");
        }

        // A window built for This Mac carries no token at all.
        let mac = shell_script(6100, KEY, &graphs, None, None);
        assert!(!mac.contains("nk_"));
        assert_eq!(token_seen_at(&mac, "https://notes.example.com/g/work").unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn b781_the_script_hands_the_page_the_list_the_key_and_the_launchers_target() {
        let graphs = vec![PageGraph {
            key: "mac:default".into(),
            place: "mac",
            id: "default".into(),
            label: "This \"Mac\" </script>".into(),
            address: "http://127.0.0.1:6100/g/default".into(),
        }];
        let target = ConnectTarget { url: "http://127.0.0.1:6100/g/default", place: "mac", label: "This Mac" };
        let script = shell_script(6100, KEY, &graphs, Some(&target), None);
        assert!(script.contains(&format!("key:\"{KEY}\"")), "{script}");
        assert!(script.contains("downloads:true"), "{script}");
        assert!(script.contains("reveal:true"), "{script}");
        assert!(script.contains("deleteMac:true,listServerGraphs:true"), "{script}");
        assert!(script.contains(r#""connect":"#) || script.contains(r#"connect:{"url":"http://127.0.0.1:6100/g/default","place":"mac","label":"This Mac"}"#), "{script}");
        assert!(script.contains(r#"\"Mac\""#), "labels are JSON-escaped: {script}");
        let harness = format!(
            "globalThis.window=globalThis;globalThis.location={{origin:'tauri://localhost',pathname:'/'}};{script};const d=window.__NOOKLET_DESKTOP__;process.stdout.write(JSON.stringify([d.key,d.port,d.graphs[0].label,d.connect.place,Object.isFrozen(d)]))"
        );
        if let Ok(output) = Command::new("node").arg("-e").arg(harness).output() {
            let seen: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(seen, serde_json::json!([KEY, 6100, "This \"Mac\" </script>", "mac", true]));
        }
        assert_eq!(random_key().len(), 32);
        assert_ne!(random_key(), random_key());
    }
}
