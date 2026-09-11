# Contributing

Issues and pull requests are welcome. nooklet is early, so the most useful thing you can do right
now is use it and tell me what breaks.

## Feature requests, and voting on them

Open a [feature request](../../issues/new?template=feature_request.yml). Then **react with 👍 to
the ones you want** — that is the vote. There is no separate voting system to sign up for; GitHub
reactions are sortable, which is all a vote needs to be.

[**See what people want most →**](../../issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement+sort%3Areactions-%2B1-desc)

Reactions are a strong signal, not a queue. Something small that unblocks daily use can beat
something popular but large, and anything that conflicts with the project's scope (below) will get
a straight "no" with the reasoning rather than sitting open forever.

## Scope

nooklet is deliberately small: an outliner, tasks, links, search, sync, and an API that AI agents
can use properly. Things that are **not** planned: flashcards and spaced repetition, kanban or
whiteboard views, a plugin marketplace, or a hosted service.

If you want one of those, say so anyway — a well-argued case for why something belongs is worth
reading, and "no" is easier to give honestly than to guess at.

## Bugs

Please include what you did, what you expected, and what happened. If it involves the desktop app,
the output of **Diagnostics** (click the sync indicator in the top bar) is usually the fastest
route to an answer — it shows whether the client reached the API, whether search and embeddings
are actually working, and what sync thinks it is doing.

## Working on the code

```sh
pnpm install
pnpm test        # unit and component tests, fast
pnpm e2e         # real Chromium against a real server
pnpm typecheck
pnpm lint
```

A green `pnpm test` is not evidence that the app works — this project learned that the hard way,
and `docs/BUGS.md` records exactly how. **If you change anything a user touches, add an e2e test.**

Two conventions worth knowing before you start:

- **Decisions live in `docs/`.** `PLAN.md` for scope, `adr/` for decisions *and what they cost*,
  `spec/` for implementation-ready detail, `research/` for the findings behind them. If you make a
  non-obvious choice, write down why — including the option you rejected.
- **Comments explain why, not what.** Several fixes in this codebase exist because code that
  looked obviously correct was not; those comments say what breaks otherwise.

`CLAUDE.md` describes the same conventions in the form an AI assistant needs them. It is worth a
read even if you are human — it is the shortest description of how this repo expects to be worked
on.
