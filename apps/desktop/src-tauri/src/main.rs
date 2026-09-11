// The desktop shell (ADR 016). Deliberately almost empty: the window loads the local nooklet
// server's own origin, so the client running inside it is the same one a browser gets, with the
// same token handshake, the same OPFS replica and the same sync socket. Anything clever added
// here would be a second implementation of something the web client already does.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running nooklet");
}
