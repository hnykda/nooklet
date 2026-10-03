type:: guide
summary:: How to report bugs and request features, the project's scope, and how the code expects to be worked on — from CONTRIBUTING.md and CLAUDE.md.
tags:: guide

- Issues and pull requests are welcome. nooklet is early, so the most useful thing you can do is use it and say what breaks.
- ## Feature requests, and voting on them
  - Open a feature request on GitHub, then react with 👍 to the ones you want — that is the vote; reactions are sortable, which is all a vote needs to be. The `?` menu in the app has "Request a feature" and "Report a bug" links that open the right templates.
  - Reactions are a strong signal, not a queue: something small that unblocks daily use can beat something popular but large, and anything outside the scope gets a straight "no" with the reasoning rather than sitting open forever.
- ## Scope
  - Deliberately small: an outliner, tasks, links, search, sync, and an API that AI agents can use properly. Not planned: flashcards and spaced repetition, kanban or whiteboard views, a plugin marketplace, a hosted service. A well-argued case for one of those is still worth reading.
- ## Bugs
  - Say what you did, what you expected, and what happened. Include the output of **Diagnostics** (click the sync indicator in the top bar, or `⋯` → Diagnostics): it shows whether the client reached the API, whether search and embeddings work, and what sync thinks it is doing. Say which app and which build — the `?` menu shows the version.
- ## Working on the code
  - ```sh
    pnpm install
    pnpm test        # unit and component tests, fast
    pnpm e2e         # real Chromium against a real server and a real production build
    pnpm typecheck
    pnpm lint
    ```
  - A green `pnpm test` is not evidence that the app works: six bugs shipped past 1,180 passing tests because none of them launched a browser against a served build. If you change anything a user touches, add an e2e test.
  - `pnpm nooklet verify` replays the op log and diffs it against live state; run it after touching sync, ops or the schema.
  - Decisions live in `docs/`: `PLAN.md` for scope, `adr/` for decisions and what they cost, `spec/` for implementation-ready detail, `research/` for the findings behind them, `BUGS.md` for what is broken — log a bug there before fixing it, and name the test that would have caught it. A non-obvious choice gets written down with the option that was rejected.
  - Comments explain why, not what. Several fixes exist because code that looked correct was not, and those comments say what breaks otherwise.
  - Respect the seams: `packages/core` stays platform-free; the command system is host-agnostic and ships its own fakes; the editor's keys-to-ops boundary is pure; new capabilities go into the `defineOp` registry, not a parallel path; the server's single write path is `serverApplyOps`.
  - `CLAUDE.md` describes the same conventions in the form an AI assistant needs them — the shortest description of how the repository expects to be worked on, worth reading even if you are human.
- Licence: MIT.
