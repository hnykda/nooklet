//! B-786: deleting a graph on This Mac, from the graph menu.
//!
//! On This Mac the graph's folder (`<data>/graphs/<id>/`) IS the graph: no server elsewhere keeps a
//! copy. So deleting is built to be refused when in doubt and recoverable when it happens:
//!
//! 1. **Refused before anything is touched** (`check_deletable`): an id that is not a graph id; the
//!    graph `default` (This Mac's main graph: the CLI, the MCP endpoint, the launcher's "Open a
//!    graph on this Mac" and the server's bare-address redirect all open it, and the server itself
//!    asks `--force` for it); the graph on screen; the last graph on this Mac.
//! 2. **The folder is checked** (`graph_folder`): a real directory directly inside `graphs/`, not a
//!    symbolic link, and still inside `graphs/` once resolved. The page names a graph by id only.
//! 3. **The bundled server lets go first.** It holds a graph's SQLite file, mirror, indexer and
//!    sockets open once anything asked for it (ADR 025's lazy registry); moving the folder under it
//!    would leave it writing to the moved file. So the shell does not move the folder itself: it
//!    asks the server to RETIRE the graph (B-713, `DELETE /graphs/<id>` with this data folder's
//!    root token), which closes all of that and then moves the folder to
//!    `graphs-retired/<id>-<time>/`. With no server running, `nooklet graph retire` does the same
//!    move (it refuses while a server holds the data folder).
//! 4. **Then the Trash**, not `rm -rf`: the retired folder is moved to the macOS Trash
//!    (`NSFileManager trashItemAtURL`, through the `trash` crate), where it can be dragged back
//!    until the Trash is emptied. If that fails, the graph stays in `graphs-retired/` (nothing is
//!    deleted) and the error says where.

use std::path::{Path, PathBuf};

use crate::connect::Http;
use crate::graph_list::{is_valid_graph_id, GraphKey, LocalGraph};

/// The checks that need no disk access, in the order a person would want to hear them.
pub fn check_deletable(id: &str, showing: Option<&GraphKey>, local: &[LocalGraph]) -> Result<(), String> {
    if !is_valid_graph_id(id) {
        return Err("That isn't a graph on this Mac.".into());
    }
    if id == "default" {
        return Err("This Mac's main graph can't be deleted from the app: nooklet's command line, its MCP endpoint and the launcher all open it.".into());
    }
    if !local.iter().any(|g| g.id == id) {
        return Err("That graph is not on this Mac any more.".into());
    }
    if showing == Some(&GraphKey::Mac(id.to_string())) {
        return Err("This graph is open. Open another graph first, then delete this one.".into());
    }
    if local.len() <= 1 {
        return Err("This is the only graph on this Mac. Create another one first, so there is something to open.".into());
    }
    Ok(())
}

/// `parent/name`, if it is a real directory directly inside `parent`: not a symbolic link, and its
/// resolved path's parent is `parent`'s resolved path.
fn checked_child(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let path = parent.join(name);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| format!("There is no folder for “{name}” in nooklet's data folder."))?;
    if meta.file_type().is_symlink() {
        return Err(format!("“{name}” is a symbolic link in nooklet's data folder; nooklet won't delete through one."));
    }
    if !meta.is_dir() {
        return Err(format!("“{name}” in nooklet's data folder is not a folder."));
    }
    let real_parent = parent.canonicalize().map_err(|e| e.to_string())?;
    let real = path.canonicalize().map_err(|e| e.to_string())?;
    if real.parent() != Some(real_parent.as_path()) {
        return Err(format!("“{name}” is not inside nooklet's data folder."));
    }
    Ok(real)
}

/// `<data>/graphs/<id>`, checked (`checked_child`).
pub fn graph_folder(data_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_graph_id(id) {
        return Err("That isn't a graph on this Mac.".into());
    }
    checked_child(&data_dir.join("graphs"), id)
}

/// Whether `name` is what retiring `id` names its folder: `<id>-<YYYYMMDDTHHMMSSZ>[-<n>]`
/// (`packages/server/src/graphs/retire.ts#RETIRED_NAME`). Nothing else, so the server's answer can
/// never point the Trash at another folder.
pub fn is_retired_name_for(name: &str, id: &str) -> bool {
    let Some(rest) = name.strip_prefix(id).and_then(|r| r.strip_prefix('-')) else {
        return false;
    };
    let (stamp, n) = match rest.split_once('-') {
        Some((stamp, n)) => (stamp, Some(n)),
        None => (rest, None),
    };
    let b = stamp.as_bytes();
    let stamp_ok = b.len() == 16
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z';
    stamp_ok && n.is_none_or(|n| !n.is_empty() && n.len() <= 6 && n.bytes().all(|c| c.is_ascii_digit()))
}

/// `<data>/graphs-retired/<name>`, checked like `graph_folder`, and only a name retiring `id` gives.
pub fn retired_folder(data_dir: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
    if !is_retired_name_for(name, id) {
        return Err(format!("The server retired “{id}” under an unexpected name; it is in graphs-retired/, nothing was deleted."));
    }
    checked_child(&data_dir.join("graphs-retired"), name)
}

/// Retires `id` on the running server on this Mac (`DELETE /graphs/<id>`, B-713), with the root
/// token of `data_dir` (`<data>/root.token`, which that server made). Returns the retired folder's
/// name. A token the server refuses, or a graph it does not know, means it serves another data
/// folder (a `nooklet serve --data …` someone started): then nothing is touched.
pub fn retire_on_server(http: &dyn Http, port: u16, data_dir: &Path, id: &str) -> Result<String, String> {
    let root = std::fs::read_to_string(data_dir.join("root.token")).map(|t| t.trim().to_string()).unwrap_or_default();
    if root.is_empty() {
        return Err("nooklet's data folder has no root token, so the server on this Mac can't be asked to let go of the graph. Nothing was deleted.".into());
    }
    let (status, body) = http
        .call("DELETE", &format!("http://127.0.0.1:{port}/graphs/{id}"), Some(&root))
        .map_err(|e| format!("Couldn't reach nooklet's server on this Mac: {e}. Nothing was deleted."))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
    match status {
        200..=299 => parsed
            .as_ref()
            .and_then(|v| v.get("retired")?.as_str().map(str::to_string))
            .ok_or_else(|| "The server's answer did not say where the graph went. Look in graphs-retired/ in nooklet's data folder.".into()),
        401 | 403 | 404 => Err(format!(
            "The nooklet server on port {port} is not serving this data folder (another `nooklet serve` is running). Stop it and try again. Nothing was deleted."
        )),
        _ => Err(parsed
            .as_ref()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("The server on this Mac answered {status}."))
            + " Nothing was deleted."),
    }
}

/// The whole deletion, with the two steps that act passed in so tests can stand in for the server
/// and the Trash (a test run must never put a developer's folders in their Trash):
/// `retire(id)` returns the retired folder's name, `trash(path)` moves a folder to the Trash.
pub fn delete_mac_graph(
    data_dir: &Path,
    id: &str,
    showing: Option<&GraphKey>,
    local: &[LocalGraph],
    retire: impl FnOnce(&str) -> Result<String, String>,
    trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    check_deletable(id, showing, local)?;
    graph_folder(data_dir, id)?;
    let name = retire(id)?;
    let retired = retired_folder(data_dir, id, &name)?;
    trash(&retired).map_err(|e| {
        format!("“{id}” is out of the list and in graphs-retired/{name} in nooklet's data folder (nothing was deleted), but could not go to the Trash: {e}")
    })
}

/// Moves `path` to the Trash. On macOS through `NSFileManager trashItemAtURL`, not the `trash`
/// crate's default (asking Finder over AppleScript), which needs an Automation permission prompt;
/// the cost is that Finder's "Put Back" may not be offered, so the folder is dragged back instead.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::Mutex;

    fn local(ids: &[&str]) -> Vec<LocalGraph> {
        ids.iter().map(|id| LocalGraph { id: (*id).into(), label: (*id).into() }).collect()
    }

    fn mac(id: &str) -> GraphKey {
        GraphKey::Mac(id.into())
    }

    /// A data folder in the temp dir with `graphs/<id>/graph.sqlite` for each id.
    fn data_dir(ids: &[&str]) -> PathBuf {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).unwrap();
        let root = std::env::temp_dir().join(format!("nooklet-delete-{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        for id in ids {
            std::fs::create_dir_all(root.join("graphs").join(id)).unwrap();
            std::fs::write(root.join("graphs").join(id).join("graph.sqlite"), b"db").unwrap();
        }
        std::fs::create_dir_all(root.join("graphs-retired")).unwrap();
        root
    }

    /// What `GraphRegistry#retire` does on disk: move the folder to `graphs-retired/<id>-<time>`.
    fn fake_retire(data: &Path) -> impl FnOnce(&str) -> Result<String, String> + '_ {
        move |id| {
            let name = format!("{id}-20261005T010203Z");
            std::fs::rename(data.join("graphs").join(id), data.join("graphs-retired").join(&name)).unwrap();
            Ok(name)
        }
    }

    #[test]
    fn b786_the_open_graph_default_and_the_last_graph_are_refused() {
        let all = local(&["default", "garden", "otter"]);
        assert!(check_deletable("garden", Some(&mac("garden")), &all).unwrap_err().contains("is open"));
        assert!(check_deletable("default", Some(&mac("garden")), &all).unwrap_err().contains("main graph"));
        // The last graph on this Mac, whatever its id (a data folder without `default`).
        assert!(check_deletable("garden", None, &local(&["garden"])).unwrap_err().contains("only graph"));
        assert!(check_deletable("gone", None, &all).unwrap_err().contains("not on this Mac"));
        for bad in ["", "..", "../x", "Garden", "a/b", "graphs"] {
            assert!(check_deletable(bad, None, &all).is_err(), "{bad:?}");
        }
        assert_eq!(check_deletable("garden", Some(&mac("otter")), &all), Ok(()));
        assert_eq!(check_deletable("garden", Some(&GraphKey::Server("garden".into())), &all), Ok(()));
        assert_eq!(check_deletable("garden", None, &all), Ok(()));
    }

    #[test]
    fn b786_a_refusal_touches_nothing() {
        let data = data_dir(&["default", "garden"]);
        let retired = Cell::new(false);
        let trashed = Cell::new(false);
        let result = delete_mac_graph(
            &data,
            "garden",
            Some(&mac("garden")),
            &local(&["default", "garden"]),
            |_| {
                retired.set(true);
                Ok(String::new())
            },
            |_| {
                trashed.set(true);
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("is open"));
        assert!(!retired.get() && !trashed.get());
        assert!(data.join("graphs/garden/graph.sqlite").exists());
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn b786_a_graph_is_retired_by_the_server_then_its_retired_folder_goes_to_the_trash() {
        let data = data_dir(&["default", "garden"]);
        let trashed: Mutex<Vec<PathBuf>> = Mutex::default();
        delete_mac_graph(&data, "garden", Some(&mac("default")), &local(&["default", "garden"]), fake_retire(&data), |p| {
            trashed.lock().unwrap().push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        let real = data.canonicalize().unwrap();
        assert_eq!(*trashed.lock().unwrap(), vec![real.join("graphs-retired/garden-20261005T010203Z")]);
        assert!(!data.join("graphs/garden").exists());

        // The Trash refused: the graph stays retired (nothing deleted) and the error says where.
        let data2 = data_dir(&["default", "otter"]);
        let err = delete_mac_graph(&data2, "otter", None, &local(&["default", "otter"]), fake_retire(&data2), |_| Err("no Trash on this volume".into()))
            .unwrap_err();
        assert!(err.contains("graphs-retired/otter-20261005T010203Z") && err.contains("nothing was deleted"), "{err}");
        assert!(data2.join("graphs-retired/otter-20261005T010203Z/graph.sqlite").exists());
        std::fs::remove_dir_all(&data).unwrap();
        std::fs::remove_dir_all(&data2).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn b786_symlinks_and_paths_outside_graphs_are_refused() {
        let data = data_dir(&["default"]);
        let outside = data_dir(&["victim"]);
        // graphs/linked -> a folder elsewhere.
        std::os::unix::fs::symlink(outside.join("graphs/victim"), data.join("graphs/linked")).unwrap();
        assert!(graph_folder(&data, "linked").unwrap_err().contains("symbolic link"));
        let called = Cell::new(false);
        let err = delete_mac_graph(
            &data,
            "linked",
            None,
            &local(&["default", "linked"]),
            |_| {
                called.set(true);
                Ok(String::new())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");
        assert!(!called.get(), "the server is never asked");
        assert!(outside.join("graphs/victim/graph.sqlite").exists());

        // A file, not a folder; a folder that is not there; ids that are paths.
        std::fs::write(data.join("graphs/afile"), b"x").unwrap();
        assert!(graph_folder(&data, "afile").is_err());
        assert!(graph_folder(&data, "missing").is_err());
        for bad in ["..", "../graphs-retired", "default/..", "/etc"] {
            assert!(graph_folder(&data, bad).is_err(), "{bad}");
        }
        assert_eq!(graph_folder(&data, "default").unwrap(), data.canonicalize().unwrap().join("graphs/default"));

        // The retired folder: only `<id>-<time>`, not a symlink, inside graphs-retired/.
        std::os::unix::fs::symlink(outside.join("graphs/victim"), data.join("graphs-retired/linked-20261005T010203Z")).unwrap();
        assert!(retired_folder(&data, "linked", "linked-20261005T010203Z").unwrap_err().contains("symbolic link"));
        for bad in ["../graphs/default", "default", "linked-x", "other-20261005T010203Z", "linked-20261005T010203Z/.."] {
            assert!(retired_folder(&data, "linked", bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&data).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn retired_names_match_the_servers() {
        assert!(is_retired_name_for("garden-20261004T153012Z", "garden"));
        assert!(is_retired_name_for("garden-20261004T153012Z-2", "garden"));
        assert!(is_retired_name_for("my-garden-20261004T153012Z", "my-garden"));
        for bad in ["garden", "garden-", "garden-2026", "gardens-20261004T153012Z", "garden-20261004T153012Z-", "garden-20261004T153012Z-x", "garden-20261004T153012Z/.."] {
            assert!(!is_retired_name_for(bad, "garden"), "{bad}");
        }
    }

    /// The real Trash, end to end. Ignored by default: it puts a small folder in the Trash of
    /// whoever runs it. Run by hand with `cargo test -- --ignored the_real_trash`.
    #[test]
    #[ignore]
    fn the_real_trash_takes_a_folder() {
        let data = data_dir(&["nooklet-trash-probe"]);
        let folder = graph_folder(&data, "nooklet-trash-probe").unwrap();
        move_to_trash(&folder).unwrap();
        assert!(!folder.exists());
        std::fs::remove_dir_all(&data).unwrap();
    }

    /// Against a real `nooklet serve --data $NOOKLET_DELETE_PROBE_DATA --port $NOOKLET_DELETE_PROBE_PORT`
    /// that hosts `default` and a graph `garden` it has OPENED (one request to it first): the whole
    /// deletion, with the real HTTP client and a stand-in Trash. Ignored: it needs that server.
    /// The recipe is in `docs/progress/desktop-night-bugs.md`.
    #[test]
    #[ignore]
    fn b786_against_a_real_server() {
        let data = PathBuf::from(std::env::var("NOOKLET_DELETE_PROBE_DATA").expect("NOOKLET_DELETE_PROBE_DATA"));
        let port: u16 = std::env::var("NOOKLET_DELETE_PROBE_PORT").expect("NOOKLET_DELETE_PROBE_PORT").parse().unwrap();
        let http = crate::connect::Ureq::new();
        let trashed: Mutex<Vec<PathBuf>> = Mutex::default();
        delete_mac_graph(
            &data,
            "garden",
            Some(&mac("default")),
            &local(&["default", "garden"]),
            |id| retire_on_server(&http, port, &data, id),
            |p| {
                trashed.lock().unwrap().push(p.to_path_buf());
                Ok(())
            },
        )
        .unwrap();
        let trashed = trashed.lock().unwrap();
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].join("graph.sqlite").exists(), "the whole folder was retired: {:?}", trashed[0]);
        assert!(!data.join("graphs/garden").exists());
        // The server let go: it no longer serves the graph.
        let (status, _) = http.call("GET", &format!("http://127.0.0.1:{port}/g/garden/healthz"), None).unwrap();
        assert_eq!(status, 404);
    }

    struct Answer(Result<(u16, String), String>, Mutex<Vec<(String, String, Option<String>)>>);

    impl Http for Answer {
        fn post_json(&self, _: &str, _: Option<&str>, _: &str) -> Result<(u16, String), String> {
            unreachable!("deleting never POSTs")
        }
        fn call(&self, method: &str, url: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
            self.1.lock().unwrap().push((method.into(), url.into(), bearer.map(str::to_string)));
            self.0.clone()
        }
    }

    #[test]
    fn b786_retiring_asks_this_macs_server_with_the_data_folders_root_token() {
        let data = data_dir(&["default", "garden"]);
        std::fs::write(data.join("root.token"), "nkroot_test\n").unwrap();
        let ok = Answer(Ok((200, r#"{"id":"garden","retired":"garden-20261005T010203Z"}"#.into())), Mutex::default());
        assert_eq!(retire_on_server(&ok, 6100, &data, "garden"), Ok("garden-20261005T010203Z".into()));
        assert_eq!(
            ok.1.lock().unwrap()[0],
            ("DELETE".into(), "http://127.0.0.1:6100/graphs/garden".into(), Some("nkroot_test".into()))
        );
        for (answer, expected) in [
            (Ok((401, String::new())), "not serving this data folder"),
            (Ok((404, String::new())), "not serving this data folder"),
            (Ok((409, r#"{"error":{"message":"\"garden\" is already being retired"}}"#.into())), "already being retired"),
            (Err("Connection refused".into()), "Couldn't reach"),
        ] {
            let err = retire_on_server(&Answer(answer, Mutex::default()), 6100, &data, "garden").unwrap_err();
            assert!(err.contains(expected) && err.contains("Nothing was deleted"), "{err}");
        }
        std::fs::remove_file(data.join("root.token")).unwrap();
        let none = Answer(Ok((200, String::new())), Mutex::default());
        assert!(retire_on_server(&none, 6100, &data, "garden").unwrap_err().contains("no root token"));
        assert!(none.1.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&data).unwrap();
    }
}
