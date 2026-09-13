# ADR 019: Templates are core; the journal template is a property of the graph

Date: 2026-09-12. Status: accepted.

## Context

Logseq's templates are three things: a block with `template:: name` is a template; `/template`
inserts a copy of its subtree at the caret, with `<% today %>`-style tokens expanded; and
`:default-templates {:journals "name"}` in `config.edn` makes every new journal day start from
one. Demand is not in doubt (research/13 §4.2 item 2: a 44k-view how-to thread, the default
config, Logseq's own roadmap calling it "text template revival"). `PLAN.md` §17 deferred them as
"later as a plugin or slash command", and `docs/spec/commands-and-keymap.md` R54 says templates
are "not a core slash item".

Three facts about the code as it stands decide the shape:

1. **There is no client plugin host.** `@nooklet/plugin-api` declares `registerSlashCommand`, but
   nothing in `apps/web` implements `ClientPluginContext`; `SlashMenu` ranks a static `SLASH_ITEMS`
   list. The built-in `mermaid` plugin's `/mermaid` has never reached the menu (B-103).
2. **A journal day is born in two places** — `views/VirtualJournalDay.tsx` on the first keystroke
   and `packages/server/src/data-api.ts#journal()` when an agent's `page_append` names a day that
   does not exist — and neither has a hook a plugin could attach to.
3. **There is no settings API.** `setting` is a server table read by three startup helpers; the
   client's preferences live in `localStorage` (ADR 018 deliberately left the journal title format
   per-device for this reason).

## Decision

**Templates are core.** One command (`block.insertTemplate`), one slash row, a picker, and a
pure module in `@nooklet/core` (`templates.ts`) that both the client and the server use to turn
a template subtree into `block.create` ops. The block copy is fresh ids, template-only properties
dropped, tokens expanded — the same on either side because it is the same function.

**The journal template is chosen by a property, not a setting.** `journal-template:: true` on
the template block. It is read by both birth paths from what they already have — the client's
replica, the server's database — and written by the Settings panel as an ordinary `block.prop`
op. Several claimants: the oldest block wins, by the same query on both sides.

**Date tokens are written in a display format and resolve anyway.** The client expands
`<% today %>` in the reader's journal title format, matching what `/today` inserts. The server
has no reader, so it uses the format the graph came with (`journal-format.ts`) or the default.
Both are `[[links]]` that resolve to the same page, because reference keys canonicalise
(ADR 018). In a journal template `today` is that journal's day, not the wall clock's: an agent
creating tomorrow's page gets tomorrow's date in it.

## Why not the alternatives

**A built-in plugin, as PLAN §17 and research/13 said.** The honest cost is a client plugin host
that does not exist — loader, `EditorApi`, a `registerSlashCommand` that `SlashMenu` actually
consults — plus a server-side "page created" hook for the journal template, plus a plugin
settings UI. That is most of a milestone to deliver a feature whose whole implementation is
smaller than the host it would need. It would also make the journal template the only thing in
the graph that behaves differently depending on whether a plugin is enabled. The plugin API is
still the right place for *someone else's* template engine; this one is the same kind of core
convention that `favorite::` and `icon::` already are.

**A server setting (`setting` table) named in Settings.** Where Logseq keeps it. Rejected because
there is no op to read or write settings, `ops/**` is not this change's to extend, and — the
real reason — the client would then need the server to know which template to insert on a day
it creates offline. A property is in the replica already. It also syncs, appears in the markdown
mirror, and an agent can set it with `block_update`, which a settings row could not offer
without three more ops.

**A per-device preference in `localStorage`, like the theme.** Would have to be set on every
device and could never reach the server's birth path at all.

**Apply the journal template on first render instead of at creation.** "If a journal page has no
blocks, insert the template" would cover both paths with one client-side rule. Rejected: it
writes to a page the person only looked at, it races with a sync that is about to deliver the
blocks the other device already wrote, and an API-created day would read empty to the agent that
created it until some browser happened to open it.

**Reuse the empty bullet by deleting it and inserting fresh blocks.** Simpler than merging the
template's first block into the block being edited. Rejected because `BlockTree` deliberately
keeps a row whose id it is editing even when a refetch no longer contains it (an optimistic
insert looks the same), so the deleted bullet would linger as a ghost row until the next change.
Merging writes the text through `EditorHost.replaceRange` — the editor's own path — and the rest
by ops.

## Consequences

- `PLAN.md` §2/§17 and spec R54 need their "templates are not core" sentences updated; both
  files belong to the coordinator this session.
- `template-including-parent:: false` is honoured (Logseq's switch for "insert the children, not
  the block"), so imported templates keep behaving. Natural-language tokens (`<% next friday %>`)
  are not implemented; an unknown token stays in the text rather than vanishing.
- The picker is a second popup opened by a command rather than by a text trigger, so it is
  mounted imperatively into `document.body` instead of by `CommandLayer`. It keeps the editor
  focused and takes the characters typed to filter at the document's capture phase, the way the
  slash menu keeps its query out of the block.
- Inserting a template from `/template` bypasses the editor's undo history (`BlockTree`'s
  `commit`), so Cmd/Ctrl+Z does not remove it (B-108; fixed, see the amendment below). The ops are ordinary and `batch_undo`
  reverses an API-side insertion as usual.
- A template's `properties` are copied to the copy, including `scheduled`/`deadline`/`repeat`;
  `template`, `journal-template` and `template-including-parent` are dropped from every copied
  node, so a template nested inside a template does not register a duplicate on each insert.
- Client-created days now apply the page, the template and the typed block in one `applyOps`
  batch from one clock (`getOpClock`), sized from the loaded template, rather than three
  sequential single-op writes.

## Amendment 2026-09-13: the insertion is one editor batch (B-108)

`/template` no longer writes around the editor. `data/templates.ts` builds the ops without
applying them (`templateAfterOps`, `templateIntoBlockOps`) and the command hands them to
`EditorHost.commitOps`, which the mounted `BlockTree` commits through the same `runStructural`
path as a split — so the whole insertion is one Cmd/Ctrl+Z, and redo puts it back. The "into an
empty bullet" text is now a `block.text` op in that batch instead of an `EditorHost.replaceRange`:
the reason for `replaceRange` above (an op beside the open buffer is flushed over) does not apply
to a batch the editor commits itself, since it syncs its buffer to what it commits. When no
mounted editor shows the block (the person left the page while the template was being read) the
command applies the ops directly, which is correct but not undoable from the keyboard.

Cost: the tree's undo can only restore properties it models (`invert.ts#propValueBefore`). A
generic property the template writes onto the bullet is undone to "absent", which is only wrong
if the empty bullet already carried that same key — logged as B-191.
