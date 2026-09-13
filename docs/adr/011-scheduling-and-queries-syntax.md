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

## Amendment 2026-09-12: the ```` ```query ```` fence ships (M7); what the language is; what waits

Status of this section: accepted. The original decision above said the fence was reserved for
"a later milestone"; that milestone is M7 (research/13 §4.2 item 1 — queries are the forum's
largest help topic). What shipped, and what was deliberately left out, so the next person does
not have to reverse-engineer either from `packages/core/src/query.ts`.

### The language as implemented

Whitespace-separated terms; juxtaposition is `and`; `or` binds loosest, `not` (or a `-` prefix)
tightest; parentheses group. Parsing never throws: a malformed query is an error with a message
in words and the offending span, rendered as such.

| write | means |
|---|---|
| `TODO` (bare, uppercase; aliases `WAIT`, `CANCELLED`, `IN-PROGRESS` accepted) | `marker:TODO` |
| `marker:TODO,DOING` · `marker:open` · `marker:closed` · `marker:any` · `marker:none` | task state (`task:` is an alias) |
| `priority:A,B` · `priority:none` · `priority:any` | priority |
| `tag:work` · `ref:work` · bare `#work` · bare `[[Project X]]` · `#[[two words]]` | the block references that page — `#x`, `#[[x]]`, `[[x]]`, `[label]([[x]])` or a `tags::` line; a tag *is* a page (ADR 004), so the two spellings are one term |
| `page:[[Name]]` · `namespace:Projects` (`ns:`) | where the block lives |
| `journal:true` · `journal:false` · `journal:>=-7d` | page is/isn't a journal; journal day window |
| `scheduled:` `deadline:` `due:` `done:` `created:` `updated:` with `<` `<=` `>` `>=` `=` (default), `a..b` (inclusive), `none`, `any` | date fields (`due` = `coalesce(scheduled, deadline)`, the `due_day` column) |
| date values: `today` `tomorrow` `yesterday` `YYYY-MM-DD` `+7d` `-2w` `+1m` `-1y` | resolved against the device's local calendar day at evaluation time |
| bare `word` · `"a phrase"` · `text:x` | case-insensitive substring of the block's content |
| `prop:type` · `prop:type=book` (`property:`) | has the property / equals, case-insensitive; keys normalized like OUT-19 |
| `sort:due` (default) · `sort:-deadline` · `sort:updated:desc` · fields `due scheduled deadline done created updated priority page` | order; nulls always last; ties by page (journals newest first, then A→Z), then block order |
| `limit:20` | cap on hits (the renderer's own default is 200) |

Examples that cover what research/13 §2.2 says people actually write:

```
TODO tag:work                          marker:open scheduled:<=today sort:deadline
DONE done:>=-7d                         (TODO or DOING) [[Project X]] not #someday
priority:A due:today..+7d               journal:>=-30d text:"standup"
```

### Semantics worth stating

- A query returns **blocks**, grouped by page in the rendered view, each with its children
  (three levels) so a task's notes travel with it. A hit whose ancestor is also a hit is shown
  once, nested. **Query blocks are never results** — `text:work` would otherwise list the fence
  that says `text:work`.
- Evaluation is **client-only, on the local replica**, so it works offline and re-runs on every
  local or pulled write. The client schema has no `ref` table (sql-schema.md rule 1), so
  `queryPrefilter` compiles the query to a *necessary* SQL condition (marker/priority/date
  columns, page key, "content could hold a reference") that narrows candidates, and
  `matchQuery` decides exactly in JavaScript (`extractRefs` on the text, property values,
  timezone-correct days). Every SQL fragment is two-valued — `NOT (marker IN (…) AND
  scheduled_day = ?)` is NULL, not TRUE, for a NULL column — and `not` over an inexact child is
  not pushed down at all; `query.test.ts` checks the prefilter against a real SQLite for every
  construct.
- `today` is passed in, never read inside the language; results are reproducible and the same
  on every device (modulo timezone, which is the device's by design — a journal day is local).

### Deferred, and why

- **`` ```sql `` fence.** Still reserved (OUT-27). Read-only SQL against the replica is cheap to
  build but expensive to make safe *and* useful: the client tables are not the server's (no
  refs, no FTS), so it would answer different questions on each side. Wait for a need.
- **Path refs** (a block matching `[[work]]` because an *ancestor* references it — Logseq's
  `path-refs`). Needs `path_ref`, server-only today. Common in Logseq task queries; the honest
  answer is to add it when the client gets a derived-refs table, not to fake it with a walk.
- **Page-level queries** (`page-property`, `page-tags`, "pages whose…"). The fence returns blocks.
  A page-scoped result kind is a rendering and grammar decision on its own.
- **Reusing the parser for the Tasks view and the MCP `search` filter argument.** The original
  decision wanted one language for all four consumers. The Tasks view is structured controls
  (`views/taskFilters.ts`'s `TaskFilters`) and `search` takes structured filters (mcp-tools.md
  §4.3.5); both can be *compiled from* `parseQuery` output later without changing what a user
  types. Not done in M7 so as not to touch two other agents' files in the same milestone.
- **Property-typed comparisons** (`prop:pages>100`), **`$$…$$` display math** (grammar-level,
  §2.9 only knows inline), **midnight** (a page open across midnight keeps yesterday's `today`
  until something else re-runs the query — since fixed, 2026-09-13, B-94: the local day is a
  signal, `apps/web/src/data/day-clock.ts`, in the query resource's source).

### Consequences

- `packages/core/src/query.ts` is the one implementation; `apps/web/src/data/queries.ts` is its
  only consumer today. Anything that wants "blocks matching X" — a plugin, the Tasks view, an
  MCP tool — should take a query string and call `parseQuery`, not grow a parallel filter shape.
- `docs/spec/markdown-grammar.md` OUT-27 is unchanged: the fence is still an ordinary fence to
  the grammar; meaning attaches at render time in `render/tokens.tsx` (`lang === "query"`,
  depth 0 only).
