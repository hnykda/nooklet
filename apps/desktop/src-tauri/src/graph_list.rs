//! The desktop app's one list of graphs (proposal 005, ADR 032).
//!
//! Two kinds of graph, and nothing else:
//!
//! - **On this Mac**: a graph on the bundled server, i.e. a directory `<data>/graphs/<id>/`. Not
//!   stored here: `list_local_graphs` reads them from disk (each `graph.json`, the same file the
//!   server's `GET /graphs` lists), so a graph made by the CLI or an agent appears without this app
//!   keeping a second list that could drift. Only a display-name override is kept (`mac_labels`).
//! - **On a server**: an address (`https://host[/proxy]/g/<id>`) and a label. Its device token is in
//!   the system keychain (`token_store.rs`), never in this file.
//!
//! `desktop.json` used to hold a different shape (`remote_graphs` + `active_graph_id` +
//! `active_local_graph`, and before that a single `remote_url`). `load` reads either, and says when
//! it migrated so the caller can write the new shape once (keeping the old file as a backup).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// A graph on a server. `address` is the graph's own address, normalized by `graph_address`
/// (a bare server address is its `/g/default`), and is also the keychain account for its token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerGraph {
    pub id: String,
    pub address: String,
    pub label: String,
}

/// Which graph the app opens at launch: the one last open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenGraph {
    Mac { id: String },
    Server { id: String },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DesktopConfig {
    #[serde(default)]
    pub servers: Vec<ServerGraph>,
    /// Display names for This Mac's graphs, overriding the label in their `graph.json`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mac_labels: BTreeMap<String, String>,
    #[serde(default)]
    pub open: Option<OpenGraph>,
}

/// The key the page and the shell name a graph by: `mac:<id>` or `server:<id>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum GraphKey {
    Mac(String),
    Server(String),
}

impl GraphKey {
    pub fn parse(raw: &str) -> Option<GraphKey> {
        if let Some(id) = raw.strip_prefix("mac:") {
            return is_valid_graph_id(id).then(|| GraphKey::Mac(id.to_string()));
        }
        let id = raw.strip_prefix("server:")?;
        (!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .then(|| GraphKey::Server(id.to_string()))
    }

    pub fn to_key(&self) -> String {
        match self {
            GraphKey::Mac(id) => format!("mac:{id}"),
            GraphKey::Server(id) => format!("server:{id}"),
        }
    }
}

/// One of This Mac's own graphs, as read from its `graph.json`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LocalGraph {
    pub id: String,
    pub label: String,
}

/// A row of the in-app graph menu, as the page receives it (`__NOOKLET_DESKTOP__.graphs`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PageGraph {
    pub key: String,
    pub place: &'static str,
    pub id: String,
    pub label: String,
    pub address: String,
}

#[derive(Deserialize)]
struct GraphMetaFile {
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<f64>,
}

/// `packages/server/src/graphs/paths.ts#isValidGraphId`, the same rule: a URL segment and a
/// directory name, lowercase so two graphs can never collide on a case-insensitive disk.
pub fn is_valid_graph_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && id != "graphs"
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// Every graph in `<data_dir>/graphs/`, oldest first (the server's own order). A directory with a
/// database but no `graph.json` is listed under its id, as the server adopts it (B-607); one with
/// neither is not a graph. Never fails: a missing or unreadable directory is an empty list.
pub fn list_local_graphs(data_dir: &Path) -> Vec<LocalGraph> {
    let Ok(entries) = std::fs::read_dir(data_dir.join("graphs")) else {
        return Vec::new();
    };
    let mut graphs: Vec<(f64, LocalGraph)> = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_string();
            if !is_valid_graph_id(&id) || !entry.path().is_dir() {
                return None;
            }
            let meta = std::fs::read_to_string(entry.path().join("graph.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<GraphMetaFile>(&text).ok());
            if meta.is_none() && !entry.path().join("graph.sqlite").exists() {
                return None;
            }
            let created = meta.as_ref().and_then(|m| m.created_at).unwrap_or(0.0);
            let label = meta.and_then(|m| m.label).filter(|l| !l.trim().is_empty()).unwrap_or_else(|| id.clone());
            Some((created, LocalGraph { id, label }))
        })
        .collect();
    graphs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.id.cmp(&b.1.id)));
    graphs.into_iter().map(|(_, g)| g).collect()
}

/// A graph id for a new This-Mac graph named `label` ("Quiet Otter" -> `quiet-otter`), not equal to
/// any id in `taken` nor "default" (`-2`, `-3`, … appended). The label itself is kept as the
/// graph's display name; the id only has to be a valid, unique URL segment.
pub fn slug_for_label(label: &str, taken: &[String]) -> String {
    let mut slug = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.truncate(56);
    let slug = slug.trim_matches('-').to_string();
    let base = if slug.is_empty() || !is_valid_graph_id(&slug) { "graph".to_string() } else { slug };
    let free = |s: &str| s != "default" && !taken.iter().any(|t| t == s);
    if free(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|s| free(s)).expect("an unused number exists")
}

/// An address someone typed, as a graph address: `http(s)://`, a host, no `user:pass@` (which
/// would let `https://my-server@evil.example` read as "my-server"), no query or fragment, trailing
/// slashes dropped, and a bare server address meaning its default graph (`graph_address`). The page
/// checks the same things first (`apps/web/src/data/connect-graph.ts#parseServerUrl`) so the usual
/// mistakes are reported before a round trip; this is the gate.
pub fn normalize_server_address(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter the server's address.".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Include http:// or https:// — e.g. https://nooklet.example.com.".into());
    }
    if trimmed.len() > 2048 || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("That doesn't look like a server address.".into());
    }
    let url = tauri::Url::parse(trimmed).map_err(|_| "That doesn't look like a server address.".to_string())?;
    if url.host_str().map_or(true, str::is_empty) {
        return Err("That address has no server name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A server address can't contain a user name.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("A server address can't contain ? or #.".into());
    }
    Ok(graph_address(trimmed))
}

/// Whether a typed address named no graph (`https://h` rather than `https://h/g/work`): a token
/// refused there may be for another graph, which changes what the error should suggest.
pub fn names_no_graph(raw: &str) -> bool {
    tauri::Url::parse(raw.trim()).map(|u| u.path().trim_end_matches('/').is_empty()).unwrap_or(false)
}

/// The graph an address opens, spelled one way: a bare server address is its default graph (the
/// server's own bare-origin redirect, `apps/web/src/data/connect-graph.ts#graphBaseUrl`), so
/// `https://h` and `https://h/g/default` are one graph (B-618). An unparseable address is itself.
pub fn graph_address(url: &str) -> String {
    match tauri::Url::parse(url.trim()) {
        Ok(parsed) => {
            let path = parsed.path().trim_end_matches('/');
            let path = if path.is_empty() { "/g/default" } else { path };
            format!("{}{}", parsed.origin().ascii_serialization(), path)
        }
        Err(_) => url.trim().trim_end_matches('/').to_string(),
    }
}

/// A stable, opaque id for a server graph, from its address (FNV-1a, so it never changes with the
/// Rust version, unlike `DefaultHasher`). Collisions only matter within one person's list, where
/// `upsert_server` also compares addresses.
pub fn server_id(address: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in address.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("s{hash:016x}")
}

/// What a server graph is called before its server has told us: its graph id, or the host for a
/// server's default graph.
pub fn default_server_label(address: &str) -> String {
    match tauri::Url::parse(address) {
        Ok(url) => {
            let slug = url.path().rsplit_once("/g/").map(|(_, s)| s.to_string());
            match slug {
                Some(s) if !s.is_empty() && s != "default" => s,
                _ => url.host_str().map(|h| match url.port() {
                    Some(p) => format!("{h}:{p}"),
                    None => h.to_string(),
                }).unwrap_or_else(|| address.to_string()),
            }
        }
        Err(_) => address.to_string(),
    }
}

/// A label from a page or a server: control characters dropped, trimmed, at most 80 characters.
pub fn clean_label(raw: &str) -> String {
    let label: String = raw.chars().filter(|c| !c.is_control()).take(80).collect();
    label.trim().to_string()
}

impl DesktopConfig {
    pub fn server(&self, id: &str) -> Option<&ServerGraph> {
        self.servers.iter().find(|s| s.id == id)
    }

    /// `address`'s entry (already normalized), added if no entry opens the same graph, otherwise
    /// relabelled with `label` when one is given. Returns its id.
    pub fn upsert_server(&mut self, address: &str, label: Option<&str>) -> String {
        if let Some(existing) = self.servers.iter_mut().find(|s| s.address == address) {
            if let Some(label) = label.map(clean_label).filter(|l| !l.is_empty()) {
                existing.label = label;
            }
            return existing.id.clone();
        }
        let mut id = server_id(address);
        while self.servers.iter().any(|s| s.id == id) {
            id.push('x');
        }
        let label = label.map(clean_label).filter(|l| !l.is_empty()).unwrap_or_else(|| default_server_label(address));
        self.servers.push(ServerGraph { id: id.clone(), address: address.to_string(), label });
        id
    }

    /// Forgets a server graph. Returns its address (for its keychain token), `None` if unknown.
    pub fn remove_server(&mut self, id: &str) -> Option<String> {
        let index = self.servers.iter().position(|s| s.id == id)?;
        let removed = self.servers.remove(index);
        if self.open == Some(OpenGraph::Server { id: id.to_string() }) {
            self.open = None;
        }
        Some(removed.address)
    }

    pub fn rename(&mut self, key: &GraphKey, label: &str) -> Result<(), String> {
        let label = clean_label(label);
        if label.is_empty() {
            return Err("A graph needs a name.".into());
        }
        match key {
            GraphKey::Mac(id) => {
                self.mac_labels.insert(id.clone(), label);
            }
            GraphKey::Server(id) => {
                let entry = self.servers.iter_mut().find(|s| &s.id == id).ok_or("That graph is not in the list any more.")?;
                entry.label = label;
            }
        }
        Ok(())
    }

    /// The graph to open at launch: the one last open, if it is still there, else This Mac's
    /// default graph.
    pub fn launch_graph(&self, local: &[LocalGraph]) -> GraphKey {
        match &self.open {
            Some(OpenGraph::Server { id }) if self.server(id).is_some() => GraphKey::Server(id.clone()),
            Some(OpenGraph::Mac { id }) if local.iter().any(|g| &g.id == id) => GraphKey::Mac(id.clone()),
            _ => GraphKey::Mac("default".into()),
        }
    }

    pub fn set_open(&mut self, key: &GraphKey) -> bool {
        let open = match key {
            GraphKey::Mac(id) => OpenGraph::Mac { id: id.clone() },
            GraphKey::Server(id) => OpenGraph::Server { id: id.clone() },
        };
        let changed = self.open.as_ref() != Some(&open);
        self.open = Some(open);
        changed
    }

    /// The menu's rows: This Mac's graphs (its default graph is called "This Mac"), then the
    /// servers' graphs, ordered by address so one server's graphs sit together.
    pub fn page_graphs(&self, local: &[LocalGraph], port: u16) -> Vec<PageGraph> {
        let mut rows: Vec<PageGraph> = local
            .iter()
            .map(|g| PageGraph {
                key: GraphKey::Mac(g.id.clone()).to_key(),
                place: "mac",
                id: g.id.clone(),
                label: self.mac_labels.get(&g.id).cloned().unwrap_or_else(|| {
                    if g.id == "default" { "This Mac".to_string() } else { g.label.clone() }
                }),
                address: format!("http://127.0.0.1:{port}/g/{}", g.id),
            })
            .collect();
        let mut servers: Vec<&ServerGraph> = self.servers.iter().collect();
        servers.sort_by(|a, b| a.address.cmp(&b.address));
        rows.extend(servers.into_iter().map(|s| PageGraph {
            key: GraphKey::Server(s.id.clone()).to_key(),
            place: "server",
            id: s.id.clone(),
            label: s.label.clone(),
            address: s.address.clone(),
        }));
        rows
    }

    /// Which listed graph `url` is a page of: a server graph whose address it is or is under, or a
    /// This-Mac graph (`/g/<id>` on the bundled server's origin). `None` for anything else.
    pub fn graph_of_url(&self, url: &tauri::Url, port: u16) -> Option<GraphKey> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let origin = url.origin().ascii_serialization();
        if origin == format!("http://127.0.0.1:{port}") {
            let id = url.path().strip_prefix("/g/")?.split('/').next()?;
            return is_valid_graph_id(id).then(|| GraphKey::Mac(id.to_string()));
        }
        let path = url.path();
        self.servers
            .iter()
            .filter(|s| {
                let Ok(address) = tauri::Url::parse(&s.address) else { return false };
                let base = address.path().trim_end_matches('/');
                address.origin().ascii_serialization() == origin
                    && (path == base || path.starts_with(&format!("{base}/")))
            })
            // The longest address wins, for a proxy path that is a prefix of another.
            .max_by_key(|s| s.address.len())
            .map(|s| GraphKey::Server(s.id.clone()))
    }
}

/// The result of reading `desktop.json`.
pub struct Loaded {
    pub config: DesktopConfig,
    /// The file was in an older shape: write the new one (once), keeping the old as a backup.
    pub migrated: bool,
}

/// Missing, unreadable, or unparseable all mean an empty list: this must never fail startup over
/// a config file.
pub fn load(text: Option<&str>) -> Loaded {
    let Some(text) = text else {
        return Loaded { config: DesktopConfig::default(), migrated: false };
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Loaded { config: DesktopConfig::default(), migrated: false };
    };
    let Some(object) = value.as_object() else {
        return Loaded { config: DesktopConfig::default(), migrated: false };
    };
    let old = ["remote_url", "remote_graphs", "active_graph_id", "active_local_graph"];
    if object.contains_key("servers") || !old.iter().any(|k| object.contains_key(*k)) {
        return Loaded { config: serde_json::from_value(value).unwrap_or_default(), migrated: false };
    }
    Loaded { config: migrate_v1(object), migrated: true }
}

/// The shapes before proposal 005. `remote_url` (pre-ADR-025): one address, active if set.
/// `remote_graphs` + `active_graph_id` + `active_local_graph` (ADR 025, B-643): a list of
/// addresses with opaque ids, one of them active or This Mac's `active_local_graph`.
///
/// Every address is kept, whatever it is (dead test servers on 127.0.0.1 included: the owner
/// removes them from the menu, rather than this guessing which ones still matter); two spellings of
/// one graph become one entry. No token is moved: there was none in this file.
fn migrate_v1(object: &serde_json::Map<String, serde_json::Value>) -> DesktopConfig {
    let mut config = DesktopConfig::default();
    let mut active: Option<String> = None;
    if let Some(url) = object.get("remote_url").and_then(|v| v.as_str()) {
        if let Ok(address) = normalize_server_address(url) {
            active = Some(config.upsert_server(&address, None));
        }
    }
    let wanted = object.get("active_graph_id").and_then(|v| v.as_str());
    if let Some(list) = object.get("remote_graphs").and_then(|v| v.as_array()) {
        for entry in list {
            let Some(url) = entry.get("url").and_then(|v| v.as_str()) else { continue };
            let Ok(address) = normalize_server_address(url) else { continue };
            let id = config.upsert_server(&address, None);
            if wanted.is_some() && entry.get("id").and_then(|v| v.as_str()) == wanted {
                active = Some(id);
            }
        }
    }
    config.open = match active {
        Some(id) => Some(OpenGraph::Server { id }),
        None => object
            .get("active_local_graph")
            .and_then(|v| v.as_str())
            .filter(|id| is_valid_graph_id(id))
            .map(|id| OpenGraph::Mac { id: id.to_string() }),
    };
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn graph_ids_follow_the_servers_rule() {
        for ok in ["default", "quiet-otter", "a", "x2", &"a".repeat(64)] {
            assert!(is_valid_graph_id(ok), "{ok}");
        }
        for bad in ["", "-a", "a-", "Quiet", "a b", "graphs", "ü", &"a".repeat(65), "../x"] {
            assert!(!is_valid_graph_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_label_becomes_a_unique_valid_id() {
        assert_eq!(slug_for_label("Quiet Otter", &[]), "quiet-otter");
        assert_eq!(slug_for_label("  Paper   Lantern 2 ", &[]), "paper-lantern-2");
        assert_eq!(slug_for_label("Quiet Otter", &["quiet-otter".into()]), "quiet-otter-2");
        assert_eq!(slug_for_label("Default", &[]), "default-2");
        assert_eq!(slug_for_label("Čaj ☕", &[]), "aj");
        assert_eq!(slug_for_label("☕☕", &[]), "graph");
        let long = slug_for_label(&"word ".repeat(40), &[]);
        assert!(is_valid_graph_id(&long) && long.len() <= 56, "{long}");
    }

    #[test]
    fn local_graphs_are_listed_from_the_data_dir_oldest_first() {
        let dir = std::env::temp_dir().join(format!("nooklet-local-graphs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_local_graphs(&dir).is_empty(), "a data dir that does not exist yet");
        let graph = |id: &str, meta: Option<&str>, db: bool| {
            let d = dir.join("graphs").join(id);
            std::fs::create_dir_all(&d).unwrap();
            if let Some(meta) = meta {
                std::fs::write(d.join("graph.json"), meta).unwrap();
            }
            if db {
                std::fs::write(d.join("graph.sqlite"), b"").unwrap();
            }
        };
        graph("quiet-otter", Some(r#"{"id":"quiet-otter","label":"Quiet Otter","createdAt":300}"#), true);
        graph("default", Some(r#"{"id":"default","label":"default","createdAt":100}"#), true);
        graph("adopted", None, true); // B-607: a database with no graph.json yet
        graph("empty-dir", None, false); // neither: not a graph
        graph("Bad Name", Some(r#"{"label":"x"}"#), true);
        graph("corrupt", Some("{not json"), true);
        let listed = list_local_graphs(&dir);
        let ids: Vec<&str> = listed.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["adopted", "corrupt", "default", "quiet-otter"]);
        assert_eq!(listed[3].label, "Quiet Otter");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn addresses_are_normalized_and_bad_ones_refused() {
        assert_eq!(normalize_server_address(" https://notes.example.com/ ").unwrap(), "https://notes.example.com/g/default");
        assert_eq!(normalize_server_address("http://192.168.1.5:6100/g/work/").unwrap(), "http://192.168.1.5:6100/g/work");
        assert_eq!(normalize_server_address("https://example.ts.net/nooklet/g/x").unwrap(), "https://example.ts.net/nooklet/g/x");
        for bad in [
            "",
            "notes.example.com",
            "ftp://notes.example.com",
            "https://",
            "https://me@notes.example.com",
            "https://notes.example.com/g/x?token=1",
            "https://notes.example.com/#a",
            "https://a\n.example.com",
        ] {
            assert!(normalize_server_address(bad).is_err(), "{bad:?}");
        }
        assert!(names_no_graph("https://notes.example.com/"));
        assert!(!names_no_graph("https://notes.example.com/g/work"));
    }

    #[test]
    fn server_ids_are_stable_and_distinct() {
        // Pinned: an id is stored in desktop.json, so it must not change between builds.
        assert_eq!(server_id("https://notes.example.com/g/default"), server_id("https://notes.example.com/g/default"));
        assert_ne!(server_id("https://a.example.com/g/default"), server_id("https://b.example.com/g/default"));
        assert_eq!(server_id(""), "scbf29ce484222325");
    }

    #[test]
    fn adding_a_known_graph_again_reuses_its_entry_and_takes_the_servers_label() {
        let mut config = DesktopConfig::default();
        let first = config.upsert_server("https://notes.example.com/g/default", None);
        assert_eq!(config.server(&first).unwrap().label, "notes.example.com");
        let again = config.upsert_server("https://notes.example.com/g/default", Some("Notes"));
        assert_eq!(first, again);
        assert_eq!(config.server(&first).unwrap().label, "Notes");
        let work = config.upsert_server("http://192.168.1.5:6100/g/work", None);
        assert_ne!(first, work);
        assert_eq!(config.server(&work).unwrap().label, "work");
        assert_eq!(config.servers.len(), 2);
    }

    #[test]
    fn rename_remove_and_the_graph_to_open() {
        let mut config = DesktopConfig::default();
        let id = config.upsert_server("https://notes.example.com/g/work", None);
        config.rename(&GraphKey::Server(id.clone()), " Work\u{7} notes ").unwrap();
        assert_eq!(config.server(&id).unwrap().label, "Work notes");
        config.rename(&GraphKey::Mac("default".into()), "Home").unwrap();
        assert!(config.rename(&GraphKey::Mac("default".into()), "  ").is_err());
        assert!(config.rename(&GraphKey::Server("nope".into()), "x").is_err());

        let local = vec![LocalGraph { id: "default".into(), label: "default".into() }];
        assert_eq!(config.launch_graph(&local), GraphKey::Mac("default".into()));
        assert!(config.set_open(&GraphKey::Server(id.clone())));
        assert!(!config.set_open(&GraphKey::Server(id.clone())));
        assert_eq!(config.launch_graph(&local), GraphKey::Server(id.clone()));
        assert_eq!(config.remove_server(&id), Some("https://notes.example.com/g/work".into()));
        assert_eq!(config.open, None, "removing the open graph falls back to This Mac");
        assert_eq!(config.remove_server(&id), None);
        config.open = Some(OpenGraph::Mac { id: "gone".into() });
        assert_eq!(config.launch_graph(&local), GraphKey::Mac("default".into()));

        let rows = config.page_graphs(&local, 6100);
        assert_eq!(rows[0].label, "Home");
        assert_eq!(rows[0].address, "http://127.0.0.1:6100/g/default");
    }

    #[test]
    fn page_rows_list_this_mac_first_and_servers_by_address() {
        let mut config = DesktopConfig::default();
        config.upsert_server("https://z.example.com/g/default", Some("Zed"));
        config.upsert_server("https://a.example.com/g/work", Some("Work"));
        let local = vec![
            LocalGraph { id: "default".into(), label: "default".into() },
            LocalGraph { id: "quiet-otter".into(), label: "Quiet Otter".into() },
        ];
        let rows = config.page_graphs(&local, 6100);
        let labels: Vec<&str> = rows.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, ["This Mac", "Quiet Otter", "Work", "Zed"]);
        assert_eq!(rows[1].key, "mac:quiet-otter");
        assert_eq!(rows[2].place, "server");
        let json = serde_json::to_string(&rows[2]).unwrap();
        assert!(json.contains(r#""address":"https://a.example.com/g/work""#), "{json}");
    }

    #[test]
    fn a_url_is_matched_to_the_graph_it_belongs_to() {
        let mut config = DesktopConfig::default();
        let work = config.upsert_server("https://notes.example.com/g/work", None);
        let proxied = config.upsert_server("https://example.ts.net/nooklet/g/default", None);
        let at = |s: &str| config.graph_of_url(&url(s), 6100);
        assert_eq!(at("https://notes.example.com/g/work"), Some(GraphKey::Server(work.clone())));
        assert_eq!(at("https://notes.example.com/g/work/page/A"), Some(GraphKey::Server(work.clone())));
        assert_eq!(at("https://notes.example.com/g/workshop"), None, "a longer slug is another graph");
        assert_eq!(at("https://notes.example.com/g/other"), None);
        assert_eq!(at("http://notes.example.com/g/work"), None, "another scheme is another origin");
        assert_eq!(at("https://example.ts.net/nooklet/g/default/journals"), Some(GraphKey::Server(proxied)));
        assert_eq!(at("http://127.0.0.1:6100/g/quiet-otter/journals"), Some(GraphKey::Mac("quiet-otter".into())));
        assert_eq!(at("http://127.0.0.1:6100/"), None);
        assert_eq!(at("http://127.0.0.1:6200/g/x"), None);
        assert_eq!(at("http://localhost:6100/g/x"), None);
        assert_eq!(at("tauri://localhost/index.html"), None);
    }

    #[test]
    fn keys_round_trip_and_reject_junk() {
        assert_eq!(GraphKey::parse("mac:quiet-otter"), Some(GraphKey::Mac("quiet-otter".into())));
        assert_eq!(GraphKey::parse("server:s0123abcd"), Some(GraphKey::Server("s0123abcd".into())));
        for bad in ["", "mac:", "mac:../x", "server:", "server:a/b", "other:x", "default"] {
            assert_eq!(GraphKey::parse(bad), None, "{bad}");
        }
        assert_eq!(GraphKey::Mac("x".into()).to_key(), "mac:x");
    }

    #[test]
    fn the_current_shape_loads_without_migrating() {
        let text = r#"{"servers":[{"id":"s1","address":"https://a.example.com/g/default","label":"A"}],"open":{"kind":"server","id":"s1"}}"#;
        let loaded = load(Some(text));
        assert!(!loaded.migrated);
        assert_eq!(loaded.config.servers.len(), 1);
        assert_eq!(loaded.config.open, Some(OpenGraph::Server { id: "s1".into() }));
        let again = load(Some(&serde_json::to_string(&loaded.config).unwrap()));
        assert_eq!(again.config, loaded.config);
        for empty in [None, Some(""), Some("not json"), Some("[]"), Some("{}")] {
            let l = load(empty);
            assert!(!l.migrated && l.config == DesktopConfig::default(), "{empty:?}");
        }
    }

    /// The owner's file had this shape: two dead test servers on loopback ports plus one real
    /// server (here `notes.example.com`), the real one active. Nothing may be lost.
    #[test]
    fn a_previous_versions_file_migrates_keeping_every_server() {
        let text = r#"{
          "remote_graphs": [
            {"id": "g1111111111111111", "url": "http://127.0.0.1:6311"},
            {"id": "g2222222222222222", "url": "http://127.0.0.1:6549/g/work"},
            {"id": "g3333333333333333", "url": "https://notes.example.com"},
            {"id": "g4444444444444444", "url": "https://notes.example.com/g/default/"}
          ],
          "active_graph_id": "g3333333333333333",
          "active_local_graph": "quiet-otter"
        }"#;
        let loaded = load(Some(text));
        assert!(loaded.migrated);
        let addresses: Vec<&str> = loaded.config.servers.iter().map(|s| s.address.as_str()).collect();
        assert_eq!(
            addresses,
            ["http://127.0.0.1:6311/g/default", "http://127.0.0.1:6549/g/work", "https://notes.example.com/g/default"],
            "two spellings of one graph become one entry"
        );
        let real = loaded.config.servers.iter().find(|s| s.address.starts_with("https://notes")).unwrap();
        assert_eq!(real.label, "notes.example.com");
        assert_eq!(loaded.config.open, Some(OpenGraph::Server { id: real.id.clone() }));
        // Written back in the new shape, it loads as itself.
        let rewritten = serde_json::to_string_pretty(&loaded.config).unwrap();
        assert!(!rewritten.contains("remote_graphs") && !rewritten.contains("token"), "{rewritten}");
        let again = load(Some(&rewritten));
        assert!(!again.migrated);
        assert_eq!(again.config, loaded.config);
    }

    #[test]
    fn older_shapes_migrate_too() {
        let local = load(Some(r#"{"remote_graphs":[],"active_graph_id":null,"active_local_graph":"quiet-otter"}"#));
        assert!(local.migrated);
        assert_eq!(local.config.open, Some(OpenGraph::Mac { id: "quiet-otter".into() }));

        let single = load(Some(r#"{"remote_url":"https://nooklet.example.com/"}"#));
        assert_eq!(single.config.servers[0].address, "https://nooklet.example.com/g/default");
        assert_eq!(single.config.open, Some(OpenGraph::Server { id: single.config.servers[0].id.clone() }));

        let standalone = load(Some(r#"{"remote_url":null}"#));
        assert!(standalone.migrated && standalone.config.servers.is_empty() && standalone.config.open.is_none());

        // A hand-edited bad address is skipped, not fatal; a stale active id opens This Mac.
        let junk = load(Some(r#"{"remote_graphs":[{"id":"a","url":"not a url"},{"url":"https://ok.example.com/g/x"}],"active_graph_id":"a"}"#));
        assert_eq!(junk.config.servers.len(), 1);
        assert_eq!(junk.config.open, None);
    }
}
