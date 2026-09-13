//! The desktop shell (ADR 016).
//!
//! Runs nooklet's own server as a child process and points the window at it, so the app is
//! self-contained: launching it is enough, nothing has to be started first.
//!
//! Two decisions worth knowing:
//!
//! - **If a nooklet server is already listening, use it.** The obvious alternative — always spawn
//!   our own — would put two writers on the same SQLite file whenever someone already runs
//!   `nooklet serve` against the default data directory, which is the normal setup for anyone
//!   using the MCP endpoint from an editor. Sharing the running one is both safer and what the
//!   user actually wants.
//! - **The window loads the server's HTTP origin**, not bundled assets. Same-origin is what keeps
//!   the token handshake, the OPFS replica and the sync socket working exactly as in a browser;
//!   see ADR 016 for why bundling the frontend would drag CORS into the auth path.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Where the app serves from. Matches the CLI's default, so an already-running `nooklet serve`
/// is found rather than duplicated.
const DEFAULT_PORT: u16 = 6100;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The spawned server, kept so it can be stopped when the app quits. A child process that
/// outlives its window is a file lock nobody can see.
struct ServerProcess(Mutex<Option<Child>>);

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
fn spawn_server(resource_dir: &PathBuf, data_dir: &PathBuf) -> std::io::Result<Child> {
    let sidecar = resource_dir.join("sidecar");
    std::fs::create_dir_all(data_dir)?;

    Command::new(sidecar.join(format!("node{EXE}")))
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
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
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

fn wait_until_ready() -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if nooklet_is_listening() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir()?;
            let data_dir = graph_dir(&handle)?;

            // Reuse a server that is already running before starting a second one on the same
            // database.
            if !nooklet_is_listening() {
                match spawn_server(&resource_dir, &data_dir) {
                    Ok(child) => {
                        app.state::<ServerProcess>().0.lock().unwrap().replace(child);
                    }
                    Err(err) => eprintln!("nooklet: could not start the bundled server: {err}"),
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

            std::thread::spawn(move || {
                if !wait_until_ready() {
                    eprintln!("nooklet: server did not come up within {STARTUP_TIMEOUT:?}");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building nooklet")
        .run(|app, event| {
            // Stop the server we started. Without this the child keeps the database open after the
            // window closes, and the next launch finds a "already running" server it never started.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
