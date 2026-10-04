# Contributing

Issues and pull requests are welcome. nooklet is early, so the most useful thing you can do is use
it and report what breaks.

## Feature requests, and voting on them

Open a [feature request](../../issues/new?template=feature_request.yml), then react with 👍 to the
ones you want. That reaction is the vote; GitHub can sort by it.

[See what people want most](../../issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement+sort%3Areactions-%2B1-desc)

Reactions are a strong signal, not a queue. A small fix that unblocks daily use can beat a popular
large feature. Requests outside the scope below get a direct "no" with the reasoning.

## Scope

nooklet stays small: an outliner, tasks, links, search, sync, and an API AI agents can use. Not
planned: flashcards and spaced repetition, kanban or whiteboard views, real-time co-editing, a
plugin marketplace, a hosted service. If you think one of those belongs, make the case in an issue.

## Bugs

Include what you did, what you expected and what happened. Open **Diagnostics** (click the sync
indicator in the top bar) and paste what it shows: whether the client reached the API, whether
search and embeddings work, and what sync is doing. Say how you run the server (local, tailnet,
proxy, container).

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Working on the code

You need Node 24+, pnpm 12 and git. The desktop app also needs Rust and the Tauri prerequisites;
the iOS app needs Xcode.

```sh
pnpm install
pnpm -r test                       # unit and component tests; fast, run them constantly
pnpm -r typecheck
pnpm exec biome check --write .    # lint and format
pnpm e2e                           # Playwright: real Chromium, real `nooklet serve`, production build
pnpm nooklet verify --data <dir>   # replay the op log and diff it against live state
```

`pnpm e2e` builds the client and starts a server on a throwaway graph itself (port 6188 by
default, `NOOKLET_E2E_PORT` to change it). Install the browsers once with
`pnpm exec playwright install chromium webkit`.

When you run the server by hand, point it at a scratch directory (`--data "$(mktemp -d)"`) so you
never touch your own notes.

### The rules this repo works by

[CLAUDE.md](CLAUDE.md) states them for AI assistants, and they apply to everyone. The short form:

- **A green unit suite is not evidence the app works.** Six serious defects once shipped past
  more than a thousand passing unit tests because none of those tests drove a real browser against
  a real server. If you change anything a user touches, run `pnpm e2e` and add an e2e test.
- **When you fix a bug, add the test that would have caught it**, and name it in the
  [docs/BUGS.md](docs/BUGS.md) entry. Log the bug before you start fixing it.
- **Get evidence first.** A probe, a failing test or a DOM dump beats reasoning. Throwaway programs
  that settled a question go in `tools/probes/` and stay there.
- **Nothing important lives only in a chat or a PR thread.** Decisions with rejected alternatives go
  in [docs/adr](docs/adr/), precise behaviour in [docs/spec](docs/spec/), scope in
  [docs/PLAN.md](docs/PLAN.md).
- **Comments explain why**, especially where the obvious approach is wrong.
- **Respect the seams.** `packages/core` stays platform-free. New capabilities go through the one
  `defineOp` registry, which drives HTTP, OpenAPI, MCP and the typed client. Server writes go through
  `serverApplyOps`.

### User documentation

Public docs live in [docs/guide](docs/guide/) as CommonMark with YAML front matter (`title`,
`description`, `order`). A docs site renders them, so use relative links and no raw HTML. If your
change alters a flag, an endpoint or something a user sees, update the matching page in the same
pull request.
