# ADR 011: Scheduling, repeats, and query blocks use one property/fence syntax, not org-mode

Date: 2026-09-10. Status: accepted.

## Decision

- Scheduled and deadline dates are ordinary typed properties, not org-mode drawer lines:
  `scheduled:: 2026-09-12`, `deadline:: 2026-09-14 14:00` (ISO date, optional time, no weekday,
  no angle brackets).
- Repeats are a separate property: `repeat:: 1w` (shift forward from the scheduled/deadline date)
  or `repeat:: 1w from done` (shift from the completion time). Org's three repeater dialects
  (`+1w`, `++1w`, `.+1w`) are import-time input only and map onto this one property.
- There is no `:LOGBOOK:` drawer. Marker changes are already ops in the sync log with a
  timestamp and actor (ADR 003); "when did this become DOING", time-in-state, and completion
  history are queries over that log, not text stored in the block. Completing a task additionally
  sets an automatic `done:: <timestamp>` property so simple "what did I finish this week" queries
  work without touching the log.
- Query blocks are a fenced code block, `` ```query ``, whose body is one compact filter
  language (`marker:TODO tag:work scheduled:<=today sort:deadline`). The same language backs the
  Tasks view, full-text search filters, and the MCP `search` tool's filter argument, so there is
  exactly one filter syntax across the product. The grammar reserves `` ```query `` and a
  read-only `` ```sql `` fence (direct read access to the block/ref/embedding tables) for a
  later milestone; neither ships in v1, per the plan's non-goals on Logseq advanced queries.
- Import maps Logseq's `SCHEDULED: <2026-09-12 Sat .+1w>` / `DEADLINE:` lines and `:LOGBOOK:`
  drawers onto the properties above (the drawer's raw content is not kept); `{{query ...}}` /
  Datalog blocks are imported as literal text inside the block, flagged for the user to migrate.

## Why

Org-mode's syntax is three dialects next to `key:: value` (angle-bracket dates with weekdays,
repeater shorthand, drawer blocks) for information nooklet already has better places for: typed
properties for the data, the op log for history. One property syntax stays readable in the
markdown mirror and cheap for LLMs to write; deriving history from the op log avoids bloating
every task block with a growing drawer. One filter language reused by four consumers (Tasks
view, search, MCP, later query blocks) avoids Logseq's split between simple queries and Datalog.

## Consequences

- The markdown grammar spec (`docs/spec/markdown-grammar.md`) must parse Logseq's
  SCHEDULED/DEADLINE/LOGBOOK syntax on import but never emit it.
- The filter-language grammar becomes a shared spec, not something the Tasks view invents alone;
  it should be specified alongside or before the query-fence feature is built.
- Property values `scheduled`/`deadline`/`done`/`repeat` join the reserved-key list already used
  for `marker`/`priority`/`collapsed`/`id` (ADR 004, `packages/core/src/ops.ts`).
