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
//!   one-time pairing code for this Mac's own token first.
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

impl Http for Ureq {
    fn post_json(&self, url: &str, bearer: Option<&str>, body: &str) -> Result<(u16, String), String> {
        let mut request = self.agent.post(url).header("content-type", "application/json").header("accept", "application/json");
        if let Some(token) = bearer {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        let mut response = request.send(body).map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
        let text = response.body_mut().with_config().limit(1024 * 1024).read_to_string().unwrap_or_default();
        // A redirect's body says nothing; its target is what the person needs to see.
        Ok((status, location.filter(|_| (300..400).contains(&status)).unwrap_or(text)))
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
}
