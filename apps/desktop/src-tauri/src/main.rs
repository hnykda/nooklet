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

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Where the app serves from. Matches the CLI's default, so an already-running `nooklet serve`
/// is found rather than duplicated.
const PORT: u16 = 6100;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The spawned server, kept so it can be stopped when the app quits. A child process that
/// outlives its window is a file lock nobody can see.
struct ServerProcess(Mutex<Option<Child>>);

fn addr() -> SocketAddr {
    ([127, 0, 0, 1], PORT).into()
}

/// Is *nooklet* answering on the port — as opposed to something else entirely? A bare TCP connect
/// would happily accept any unrelated service and then navigate the window at it.
fn nooklet_is_listening() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    // `take` consumes the stream, so read through a borrow and shut down via the original handle.
    let _ = (&mut stream).take(8192).read_to_string(&mut body);
    let _ = stream.shutdown(Shutdown::Both);
    body.contains("\"nooklet\"")
}

/// Starts the bundled server. `resource_dir` holds the sidecar assembled by `build-sidecar.mjs`.
fn spawn_server(resource_dir: &PathBuf, data_dir: &PathBuf) -> std::io::Result<Child> {
    let sidecar = resource_dir.join("sidecar");
    std::fs::create_dir_all(data_dir)?;

    Command::new(sidecar.join("node"))
        .arg(sidecar.join("server.mjs"))
        .arg("serve")
        .arg("--data")
        .arg(data_dir)
        .arg("--port")
        .arg(PORT.to_string())
        .arg("--web")
        .arg(sidecar.join("web"))
        // sqlite-vec normally resolves its dylib out of node_modules, which does not exist in an
        // app bundle; without this, semantic and hybrid search quietly degrade to keyword only.
        .env("NOOKLET_SQLITE_VEC_PATH", sidecar.join("vec0.dylib"))
        // esbuild's JS API shells out to a per-platform binary to bundle user plugins.
        .env("ESBUILD_BINARY_PATH", sidecar.join("esbuild"))
        .env("NODE_ENV", "production")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
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
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir()?;
            // The graph lives outside the app bundle, in the user's data directory, so it survives
            // reinstalling and updating the app.
            let data_dir = app.path().app_data_dir()?.join("graph");

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
