//! "Connect to a server", checked by the shell (proposal 005, ADR 032).
//!
//! The page cannot check a server on another origin: the request is cross-origin, and a nooklet
//! server's CORS allowlist admits only the app shells' own origins (`capacitor://localhost`), so
//! from the desktop window it fails as "Load failed" (B-704). A request from Rust is not subject to
//! CORS at all, so the shell makes the same calls the web client makes:
//!
//! - `POST <graph>/api/v1/graph.overview` with `Authorization: Bearer <token>` — the check the
//!   web client's `connectToGraph` (`apps/web/src/data/connect-graph.ts`) uses, and the graph's own
//!   label from its answer;
//! - `POST <graph>/api/v1/pairing.redeem` with `{code, label}` and no token (ADR 029), to trade a
//!   one-time pairing code for this Mac's own token first;
//! - `GET <server>/graphs` with the server's ROOT token (B-787): the listing the web client's
//!   `listServerGraphs` makes, so the person picks a graph rather than typing its `/g/<id>`. The
//!   root token is used for that one request and never kept: nothing here takes a `TokenStore`.
//!
//! The error words match the web client's for the same cases, so the form reads the same whether
//! the page or the shell checked.

use std::time::Duration;

/// What one HTTP exchange came back with. A trait so tests can stand in for the network; the real
/// one is `Ureq`, and `tests::a_real_socket` drives it against a local listener.
pub trait Http {
    /// POST `body` (JSON) to `url`. `Ok((status, body))` for any HTTP answer, `Err(reason)` when
    /// there was none (refused, DNS, TLS, timeout).
    fn post_json(&self, url: &str, bearer: Option<&str>, body: &str) -> Result<(u16, String), String>;

    /// A request without a body (`GET`, `DELETE`), with the same contract as `post_json`. A default
    /// so the test doubles that only ever see POSTs need not spell it out.
    fn call(&self, method: &str, url: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
        let _ = (url, bearer);
        Err(format!("{method} is not supported here"))
    }
}

pub struct Ureq {
    agent: ureq::Agent,
}

impl Ureq {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            // A status is an answer, worded by `describe_status`, not a transport error.
            .http_status_as_error(false)
            // Never follow: a redirect (http → https, a proxy) would drop the Authorization header
            // and come back as a misleading "token rejected". Say where it points instead.
            .max_redirects(0)
            .build();
        Ureq { agent: ureq::Agent::new_with_config(config) }
    }
}

/// Status and body of an answer; for a redirect, its target instead of its body, which says nothing.
fn read_answer(mut response: ureq::http::Response<ureq::Body>) -> (u16, String) {
    let status = response.status().as_u16();
    let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
    let text = response.body_mut().with_config().limit(1024 * 1024).read_to_string().unwrap_or_default();
    (status, location.filter(|_| (300..400).contains(&status)).unwrap_or(text))
}

impl Http for Ureq {
    fn post_json(&self, url: &str, bearer: Option<&str>, body: &str) -> Result<(u16, String), String> {
        let mut request = self.agent.post(url).header("content-type", "application/json").header("accept", "application/json");
        if let Some(token) = bearer {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        request.send(body).map(read_answer).map_err(|e| e.to_string())
    }

    fn call(&self, method: &str, url: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
        let request = match method {
            "GET" => self.agent.get(url),
            "DELETE" => self.agent.delete(url),
            other => return Err(format!("{other} is not supported here")),
        };
        let mut request = request.header("accept", "application/json");
        if let Some(token) = bearer {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        request.call().map(read_answer).map_err(|e| e.to_string())
    }
}

/// `nk_`/`vrt_` + hex, or anything token-like within limits: the page checks the exact shape
/// (`apps/web/src/data/token-input.ts`); this only refuses what could not be a token at all before
/// it is put in a header.
pub fn token_is_plausible(token: &str) -> bool {
    (8..=256).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `nkp_` + 22 base64url characters (`packages/server/src/auth/pairing-codes.ts#PAIRING_CODE_RE`).
pub fn pairing_code_is_valid(code: &str) -> bool {
    code.len() == 26 && code.starts_with("nkp_") && code[4..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn host_of(address: &str) -> String {
    tauri::Url::parse(address)
        .ok()
        .and_then(|u| u.host_str().map(|h| match u.port() {
            Some(p) => format!("{h}:{p}"),
            None => h.to_string(),
        }))
        .unwrap_or_else(|| address.to_string())
}

/// What a refused token means depends on the address it was checked against
/// (`connect-graph.ts#rejectedTokenMessage`): one typed with no `/g/<graph>` is the server's
/// DEFAULT graph, and a good token for another graph is refused there.
fn rejected(address: &str, named_no_graph: bool) -> String {
    if named_no_graph {
        let origin = tauri::Url::parse(address).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
        format!(
            "This token isn't valid for the server's default graph. If it's for another graph, add /g/<graph> to the address (e.g. {origin}/g/work)."
        )
    } else {
        "That token was rejected. Check it was copied whole, and not revoked.".into()
    }
}

fn describe_status(status: u16, body: &str) -> String {
    if (300..400).contains(&status) && !body.is_empty() {
        return format!("The server redirects to {body}. Use that address instead.");
    }
    if status == 404 {
        return "There is no nooklet graph at that address. Check the /g/<graph> part.".into();
    }
    format!("Server returned {status}. Is this the right address?")
}

/// Checks `token` against the graph at `address` (normalized, `graph_list::normalize_server_address`).
/// `Ok(label)`: accepted, with the graph's own label when the server sent one.
pub fn verify_token(http: &dyn Http, address: &str, token: &str, named_no_graph: bool) -> Result<Option<String>, String> {
    let (status, body) = http
        .post_json(&format!("{address}/api/v1/graph.overview"), Some(token), "{}")
        .map_err(|e| format!("Couldn't reach {}: {e}", host_of(address)))?;
    match status {
        200..=299 => {
            let label = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("graph")?.get("label")?.as_str().map(str::to_string))
                .filter(|l| !l.trim().is_empty());
            Ok(label)
        }
        401 | 403 => Err(rejected(address, named_no_graph)),
        _ => Err(describe_status(status, &body)),
    }
}

/// Trades a one-time pairing code for this Mac's own token, named `device` on the server
/// (`pairing.redeem`, ADR 029). The server answers every unusable code the same way.
pub fn redeem_code(http: &dyn Http, address: &str, code: &str, device: &str) -> Result<String, String> {
    let body = serde_json::json!({ "code": code, "label": device }).to_string();
    let (status, text) = http
        .post_json(&format!("{address}/api/v1/pairing.redeem"), None, &body)
        .map_err(|e| format!("Couldn't reach {}: {e}", host_of(address)))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
    match status {
        200..=299 => parsed
            .as_ref()
            .and_then(|v| v.get("token")?.as_str())
            .filter(|t| token_is_plausible(t))
            .map(str::to_string)
            .ok_or_else(|| "The server's answer had no token in it.".into()),
        401 => Err("This pairing code is no longer valid: it expires after 10 minutes and works once. Make a new one on the device that showed it.".into()),
        429 => Err("Too many attempts. Wait a minute, then try again.".into()),
        _ => Err(parsed
            .as_ref()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
            .unwrap_or_else(|| describe_status(status, &text))),
    }
}

/// One graph a server hosts, as the add form offers it (B-787).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ListedGraph {
    pub id: String,
    pub label: String,
    /// The address to add it by: `<server>/g/<id>`.
    pub address: String,
}

/// The server a graph address belongs to: the address without its trailing `/g/<id>` (a reverse
/// proxy's own path, if any, is kept). `connect-graph.ts#serverRootOf`, the same rule.
pub fn server_root(address: &str) -> String {
    let trimmed = address.trim_end_matches('/');
    match trimmed.rsplit_once("/g/") {
        Some((root, id)) if crate::graph_list::is_valid_graph_id(id) => root.to_string(),
        _ => trimmed.to_string(),
    }
}

const NOT_A_LIST: &str = "The server's answer was not a list of graphs.";

/// B-787: the graphs the server at `raw_address` hosts, listed with its root token
/// (`GET <server>/graphs`, root-token gated, ADR 025). The token is sent once and dropped: this
/// takes no `TokenStore`, writes nothing, and no error it returns quotes the token.
///
/// A root token cannot open a graph, and the server has no op that turns it into a device token
/// for an EXISTING graph: `POST /graphs` mints one only for a graph it creates, and
/// `pairing.create` needs that graph's admin token, not the root token. So the person picks a graph
/// here and then gives that graph's device token or pairing link, as on the phone and in a browser.
pub fn list_server_graphs(http: &dyn Http, raw_address: &str, root_token: &str) -> Result<Vec<ListedGraph>, String> {
    let address = crate::graph_list::normalize_server_address(raw_address)?;
    let root = server_root(&address);
    let (status, body) = http
        .call("GET", &format!("{root}/graphs"), Some(root_token))
        .map_err(|e| format!("Couldn't reach {}: {e}", host_of(&address)))?;
    match status {
        200..=299 => {
            let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|_| NOT_A_LIST.to_string())?;
            let list = parsed.get("graphs").and_then(|g| g.as_array()).ok_or(NOT_A_LIST)?;
            Ok(list
                .iter()
                .filter_map(|g| {
                    let id = g.get("id")?.as_str()?;
                    if !crate::graph_list::is_valid_graph_id(id) {
                        return None;
                    }
                    let label = g
                        .get("label")
                        .and_then(|l| l.as_str())
                        .map(crate::graph_list::clean_label)
                        .filter(|l| !l.is_empty())
                        .unwrap_or_else(|| id.to_string());
                    Some(ListedGraph { id: id.to_string(), label, address: format!("{root}/g/{id}") })
                })
                .collect())
        }
        401 | 403 => Err(
            "That root token was rejected. Listing a server's graphs needs its root token (nkroot_…, shown by `nooklet token root` on the server's machine); a device token can only open the graph it was made for."
                .into(),
        ),
        404 => Err("That server has no list of graphs. Check the address: it should be a nooklet server.".into()),
        _ => Err(describe_status(status, &body)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Answers every request with the next canned response, recording what was asked.
    struct Canned {
        answers: Mutex<Vec<Result<(u16, String), String>>>,
        asked: Mutex<Vec<(String, Option<String>, String)>>,
    }

    impl Canned {
        fn new(answers: Vec<Result<(u16, String), String>>) -> Self {
            Canned { answers: Mutex::new(answers), asked: Mutex::default() }
        }
    }

    impl Http for Canned {
        fn post_json(&self, url: &str, bearer: Option<&str>, body: &str) -> Result<(u16, String), String> {
            self.asked.lock().unwrap().push((url.into(), bearer.map(str::to_string), body.into()));
            self.answers.lock().unwrap().remove(0)
        }

        fn call(&self, method: &str, url: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
            self.asked.lock().unwrap().push((url.into(), bearer.map(str::to_string), method.into()));
            self.answers.lock().unwrap().remove(0)
        }
    }

    const ADDR: &str = "https://notes.example.com/g/work";

    #[test]
    fn an_accepted_token_returns_the_graphs_label() {
        let http = Canned::new(vec![Ok((200, r#"{"graph":{"label":"Work notes","pages":3}}"#.into()))]);
        assert_eq!(verify_token(&http, ADDR, "nk_abc12345", false), Ok(Some("Work notes".into())));
        let asked = http.asked.lock().unwrap();
        assert_eq!(asked[0].0, "https://notes.example.com/g/work/api/v1/graph.overview");
        assert_eq!(asked[0].1.as_deref(), Some("nk_abc12345"));
        assert_eq!(asked[0].2, "{}");
        drop(asked);
        let http = Canned::new(vec![Ok((200, "not json".into()))]);
        assert_eq!(verify_token(&http, ADDR, "nk_abc12345", false), Ok(None));
    }

    #[test]
    fn each_failure_is_worded_for_the_form() {
        let cases: Vec<(Result<(u16, String), String>, bool, &str)> = vec![
            (Ok((401, String::new())), false, "That token was rejected"),
            (Ok((403, String::new())), true, "add /g/<graph> to the address (e.g. https://notes.example.com/g/work)"),
            (Ok((404, String::new())), false, "There is no nooklet graph at that address"),
            (Ok((502, "bad gateway".into())), false, "Server returned 502. Is this the right address?"),
            (Ok((308, "https://notes.example.com/g/work".into())), false, "redirects to https://notes.example.com/g/work"),
            (Err("Connection refused".into()), false, "Couldn't reach notes.example.com: Connection refused"),
        ];
        for (answer, no_graph, expected) in cases {
            let http = Canned::new(vec![answer]);
            let err = verify_token(&http, ADDR, "nk_abc12345", no_graph).unwrap_err();
            assert!(err.contains(expected), "{err} should contain {expected}");
        }
    }

    #[test]
    fn a_pairing_code_is_traded_for_a_token() {
        let http = Canned::new(vec![Ok((200, r#"{"token":"nk_0123456789abcdef"}"#.into()))]);
        assert_eq!(redeem_code(&http, ADDR, "nkp_abcdefghijklmnopqrstuv", "Mac"), Ok("nk_0123456789abcdef".into()));
        let asked = http.asked.lock().unwrap();
        assert_eq!(asked[0].0, "https://notes.example.com/g/work/api/v1/pairing.redeem");
        assert_eq!(asked[0].1, None, "no token: redeeming is how a device gets one");
        assert_eq!(asked[0].2, r#"{"code":"nkp_abcdefghijklmnopqrstuv","label":"Mac"}"#);
        drop(asked);
        for (answer, expected) in [
            (Ok((401, String::new())), "no longer valid"),
            (Ok((429, String::new())), "Too many attempts"),
            (Ok((400, r#"{"error":{"message":"label too long"}}"#.into())), "label too long"),
            (Ok((200, r#"{"token":"x"}"#.into())), "no token"),
            (Err("timed out".into()), "Couldn't reach notes.example.com"),
        ] {
            let http = Canned::new(vec![answer]);
            let err = redeem_code(&http, ADDR, "nkp_abcdefghijklmnopqrstuv", "Mac").unwrap_err();
            assert!(err.contains(expected), "{err} should contain {expected}");
        }
    }

    #[test]
    fn token_and_code_shapes() {
        assert!(token_is_plausible(&format!("nk_{}", "a1".repeat(24))));
        for bad in ["", "short", "nk_abc def12", "nk_abc\r\nX-Evil: 1", &"a".repeat(257)] {
            assert!(!token_is_plausible(bad), "{bad:?}");
        }
        assert!(pairing_code_is_valid("nkp_abcdefghijklmnopqrstuv"));
        assert!(!pairing_code_is_valid("nkp_short"));
        assert!(!pairing_code_is_valid("nk_abcdefghijklmnopqrstuvw"));
    }

    /// One HTTP server answering one request on a local port, recording the request head.
    fn one_shot_server(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/g/work", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            head
        });
        (address, handle)
    }

    /// The real HTTP client, against a real socket: the request carries the bearer token and the
    /// server's answer is read; a redirect is reported, not followed.
    #[test]
    fn a_real_socket() {
        let (address, server) = one_shot_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 26\r\nconnection: close\r\n\r\n{\"graph\":{\"label\":\"Work\"}}",
        );
        assert_eq!(verify_token(&Ureq::new(), &address, "nk_abc12345", false), Ok(Some("Work".into())));
        let head = server.join().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /g/work/api/v1/graph.overview http/1.1"), "{head}");
        assert!(head.contains("authorization: bearer nk_abc12345"), "{head}");

        let (address, server) = one_shot_server("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        assert!(verify_token(&Ureq::new(), &address, "nk_abc12345", false).unwrap_err().contains("rejected"));
        server.join().unwrap();

        let (address, server) = one_shot_server(
            "HTTP/1.1 301 Moved\r\nlocation: https://notes.example.com/g/work\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        );
        let err = verify_token(&Ureq::new(), &address, "nk_abc12345", false).unwrap_err();
        assert!(err.contains("redirects to https://notes.example.com/g/work"), "{err}");
        server.join().unwrap();

        // Nothing listening.
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/g/work", free.local_addr().unwrap());
        drop(free);
        assert!(verify_token(&Ureq::new(), &address, "nk_abc12345", false).unwrap_err().starts_with("Couldn't reach 127.0.0.1:"));
    }

    // Assembled, so the source holds no token-shaped literal (tools/leak-check.mjs).
    const ROOT: &str = concat!("nkroot_", "0123456789abcdef0123456789abcdef", "0123456789abcdef");

    #[test]
    fn b787_a_servers_graphs_are_listed_with_its_root_token() {
        let http = Canned::new(vec![Ok((
            200,
            r#"{"graphs":[{"id":"default","label":"Home"},{"id":"work","label":""},{"id":"../x","label":"bad"},{"label":"no id"}]}"#.into(),
        ))]);
        let listed = list_server_graphs(&http, "https://notes.example.com/g/work/", ROOT).unwrap();
        assert_eq!(
            listed,
            vec![
                ListedGraph { id: "default".into(), label: "Home".into(), address: "https://notes.example.com/g/default".into() },
                ListedGraph { id: "work".into(), label: "work".into(), address: "https://notes.example.com/g/work".into() },
            ]
        );
        let asked = http.asked.lock().unwrap();
        assert_eq!(asked[0], ("https://notes.example.com/graphs".into(), Some(ROOT.into()), "GET".into()));
        drop(asked);

        // A proxy path is kept; a bare address lists the same server.
        assert_eq!(server_root("https://h.example/notes/g/work"), "https://h.example/notes");
        assert_eq!(server_root("https://h.example/g/default"), "https://h.example");
        let http = Canned::new(vec![Ok((200, r#"{"graphs":[]}"#.into()))]);
        assert_eq!(list_server_graphs(&http, "https://notes.example.com", ROOT), Ok(vec![]));
        assert_eq!(http.asked.lock().unwrap()[0].0, "https://notes.example.com/graphs");
    }

    #[test]
    fn b787_listing_failures_are_worded_and_never_quote_the_root_token() {
        for (answer, expected) in [
            (Ok((401, String::new())), "root token was rejected"),
            (Ok((403, String::new())), "root token was rejected"),
            (Ok((404, String::new())), "no list of graphs"),
            (Ok((200, "<html>".into())), "not a list of graphs"),
            (Ok((502, String::new())), "Server returned 502"),
            (Ok((301, "https://other.example/graphs".into())), "redirects to https://other.example/graphs"),
            (Err("Connection refused".to_string()), "Couldn't reach notes.example.com: Connection refused"),
        ] {
            let http = Canned::new(vec![answer]);
            let err = list_server_graphs(&http, "https://notes.example.com/g/work", ROOT).unwrap_err();
            assert!(err.contains(expected), "{err} should contain {expected}");
            assert!(!err.contains("nkroot_0123"), "{err}");
        }
        // A bad address is named before anything is sent.
        let http = Canned::new(vec![]);
        assert!(list_server_graphs(&http, "notes.example.com", ROOT).unwrap_err().contains("http://"));
        assert!(http.asked.lock().unwrap().is_empty());
    }

    /// The real client's GET, against a real socket: the root token goes in the header, and only there.
    #[test]
    fn b787_a_real_socket_get() {
        let (address, server) = one_shot_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 38\r\nconnection: close\r\n\r\n{\"graphs\":[{\"id\":\"work\",\"label\":\"W\"}]}",
        );
        let listed = list_server_graphs(&Ureq::new(), &address, ROOT).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].address.ends_with("/g/work"));
        let head = server.join().unwrap();
        let lower = head.to_ascii_lowercase();
        assert!(lower.starts_with("get /graphs http/1.1"), "{head}");
        assert_eq!(head.matches(ROOT).count(), 1, "once, in the Authorization header: {head}");
        assert!(lower.contains(&format!("authorization: bearer {ROOT}")), "{head}");
    }
}
