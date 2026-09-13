### B-146 (existing)

**Fixed 2026-09-13.** `cli.ts#main` checks `cli-args.ts#wantsHelp` (`--help`, `-h`, or `help` in
any position) before any command runs, prints usage and returns — no graph is opened. Verified by
`NOOKLET_DATA=<scratch> pnpm nooklet serve --help`: usage printed, no data dir created. The owner's
graph content was unchanged by the incident (block 18,628 rows and op max seq 20,411 before and
after; the verifier's row hashes of every content table matched); the pre-incident copy is kept
at `~/.nooklet/backup-2026-09-13-before-accidental-serve.sqlite`. Test:
`packages/server/src/cli-args.test.ts` "--help, -h or help in any position is a request for usage,
never a command (B-146)".

---

