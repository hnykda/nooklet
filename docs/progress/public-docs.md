# Progress: public documentation (docs/guide, README, CONTRIBUTING, SECURITY)

Branch: `worktree-agent-adac0d7da28c15554`, fast-forwarded to `main` @ `e3df44a`. Started 2026-10-04.

Goal: `docs/guide/` is the single source for public docs (a docs site renders it: CommonMark, YAML
front matter `title`/`description`/`order`, relative links, no raw HTML). README becomes a short
front door; CONTRIBUTING and SECURITY at the root. No personal data, no private hostnames.

## Status

- [x] Read CLAUDE.md, README, PLAN, ADRs, OPERATIONS, apps/web/README, progress files
      (real-device-test, server-search, multi-graph-hosting, pairing, connection-states).
- [x] Checked against the code: `nooklet --help`, `cli.ts` flags, a real `serve` on port 6440 with a
      scratch `NOOKLET_DATA` (MCP `tools/list`, OpenAPI paths, `page.append`/`page.read`, `/graphs`,
      `/api/session`, Host 403, CORS preflight), `backup` → `restore` → `verify` round trip,
      `pnpm --filter @nooklet/web build`.
- [x] Guide pages: what-is-nooklet, features, how-it-works (3 `animation-spec` blocks),
      sync-and-offline, getting-started, self-hosting, security, agents, faq.
- [x] README rewritten, CONTRIBUTING rewritten, SECURITY.md added.
- [x] Coordinator decision (2026-10-04) applied: three deployment tiers; tier 1 (tailnet + HTTPS +
      per-device tokens) is first in Getting started and Self-hosting; tier 2 checklist with a
      marked `TODO (security review)` block in self-hosting.md and security.md; tier 3 unsupported.
- [x] Leak grep (paths, hostnames, IPs, tokens) and a relative-link/anchor check: clean.
- [x] Committed (see git log).

## Findings (code vs docs), for the coordinator to fold into BUGS.md

Recorded here, not in BUGS.md (another agent owns that file this round).

1. `--graph <id>` (every command except `serve`) and `--no-mirror` (`serve`) exist in `cli.ts` but
   are missing from `nooklet --help`.
2. No rate limiting exists. `docs/spec/mcp-tools.md` §3.7 and ADR 008 describe per-token limits;
   the server only has the `rate_limited` error code. Nothing returns 429.
3. No op requires the `admin` scope; an `admin` token can do exactly what a `write` token can.
   (`token create --scope admin` is still accepted.)
4. ADR 015 names the live-UI tools `ui_list_windows`/`ui_get_state`/`ui_run_command`; the server
   exposes `ui_windows`/`ui_state`/`ui_run`/`ui_navigate`/`ui_highlight`.
5. Old README's MCP example points at bare `/mcp`, which answers 307 to `/g/default/mcp`; whether
   every MCP client follows a 307 on POST is unverified. The guide uses `/g/default/mcp`.
6. Old README advertises `brew install --cask hnykda/tap/nooklet` and a Releases download. The
   release workflow creates draft releases; no tap is in this repo and `gh release list` showed
   none published. The guide says "build from source" and mentions Releases only conditionally.
7. `apps/web/README.md` still says the package does not implement the editor, views, search or
   palette; all exist.
8. OPERATIONS §3 describes restore as writing `<data>/graph.sqlite`; since ADR 025 it writes
   `<data>/graphs/<id>/` (`--graph`). Backups default to `<data>/graphs/<id>/backups/`.
9. For the security reviewer: `GET /g/<id>/assets/<id>` is unauthenticated by design (an `<img>`
   cannot send a bearer token). Asset ids are a millisecond timestamp plus 25 random bits and the
   server has no rate limit, so on a public deployment asset URLs can be brute-forced within a known
   time window. Documented in security.md.
10. The OpenAI-compatible embedding provider never sends an API key (already noted in
   `docs/progress/server-search.md`); the guide says only keyless endpoints work.

## How to resume

`git log --oneline e3df44a..HEAD`. Pages live in `docs/guide/`; each has front matter. Re-check any
claim against `pnpm nooklet --help` and `packages/server/src/cli.ts` before changing it.
