/**
 * The page view (BUILD item 2) and, scoped to one block via `rootBlockId`, the zoom view (BUILD
 * item 3). Page title (editable, through `page.update` — B-261), properties panel, `BlockTree`, and — only for the
 * full page, not the zoomed-in one — the namespace section and linked/unlinked references below
 * it. Resolves the page by name, case-insensitively (`normalizePageName`, via
 * `../data/store.ts#usePageByName`), since that is what refs navigate to (PLAN.md §4).
 */
import { isoJournalName, newId, orderBetween, parseJournalTitle } from "@nooklet/core";
import { A, useNavigate } from "@solidjs/router";
import { type Accessor, createEffect, createSignal, type JSX, Show } from "solid-js";
import { useAgendaTasks } from "../data/agenda.js";
import { describeError } from "../data/api-client.js";
import { currentDay } from "../data/day-clock.js";
import { renamePage } from "../data/page-rename.js";
import { displayPageName, displayRefName } from "../data/page-title.js";
import { applyOp, usePageByName, usePageProperties } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { requestBlockFocus } from "../editor/focus-request.js";
import { isReadOnlyValue, READ_ONLY_NOTICE, READ_ONLY_PROPERTY } from "../editor/readOnly.js";
import { useCanonicalPageRoute } from "./canonicalPageRoute.js";
import { JournalAgenda } from "./JournalAgenda.js";
import { NamespaceChildren } from "./NamespaceChildren.js";
import { goToTarget, pageNameToPath, pageRoutePath } from "./navigateTarget.js";
import { usePageFind } from "./PageFindBar.js";
import { PageIconEditor } from "./PageIcon.js";
import { PageProperties } from "./PageProperties.js";
import { ReferencesPanel } from "./ReferencesPanel.js";

export interface PageViewProps {
  name: Accessor<string>;
  /** Present (and non-empty) only on the `?block=` zoom route (BUILD item 3). */
  blockId?: Accessor<string | undefined>;
}

export function PageView(props: PageViewProps): JSX.Element {
  const navigate = useNavigate();
  const onNavigate = (t: NavigateTarget) => void goToTarget(navigate, t);

  const page = usePageByName(props.name);
  const pageId = () => page()?.id;
  const properties = usePageProperties(pageId);
  const blockId = () => props.blockId?.();
  useCanonicalPageRoute(props.name, page, blockId);
  // Find in page (audit §2 #16): Cmd/Ctrl+F narrows the outline below.
  const find = usePageFind(props.name, () => Boolean(page()));
  let viewEl: HTMLDivElement | undefined;
  // `read-only:: true` (audit §2 #17): the outline enforces it itself; the title follows suit.
  const locked = () => isReadOnlyValue(properties()[READ_ONLY_PROPERTY]);

  /** A journal's title is its date, rendered in the reader's chosen format (ADR 018) — there is no
   *  name to edit, so the input becomes a heading. */
  const isJournal = () => (page()?.journalDay ?? null) !== null;
  /** The day this route names, if it names one — whether or not its page exists yet. A date link
   *  to a day nobody has written in still shows what is scheduled or due then. */
  const journalDay = (): number | null => {
    const p = page();
    if (p) return p.journalDay;
    return p === null ? parseJournalTitle(props.name()) : null;
  };
  // Read only where the "Scheduled and deadline" list can show: a whole journal day.
  const agenda = useAgendaTasks(() => journalDay() !== null && !blockId());
  const agendaSection = (): JSX.Element => (
    <Show when={!blockId() && journalDay()}>
      {(day) => (
        <JournalAgenda day={day()} today={currentDay()} tasks={agenda} onNavigate={onNavigate} />
      )}
    </Show>
  );
  const title = () => {
    const p = page();
    return p ? displayPageName(p) : props.name();
  };

  const [titleDraft, setTitleDraft] = createSignal(props.name());
  /** From the pull that renames the page locally until the page resolves under its new name, the
   * route's name resolves to nothing; without this the "doesn't exist yet" view flashes. Cleared
   * by the page resolving, not right after `navigate` — the new name's lookup has not started by
   * then, so a `finally` reset still showed the missing view for a frame (seen on the real graph). */
  const [renaming, setRenaming] = createSignal(false);
  createEffect(() => {
    const p = page();
    setTitleDraft(p ? p.name : props.name());
    if (p) setRenaming(false);
  });

  async function commitTitle(): Promise<void> {
    const p = page();
    if (!p) return;
    const value = titleDraft().trim();
    if (value === "" || value === p.name) {
      setTitleDraft(p.name);
      return;
    }
    // Through the server, which rewrites every link to the page and keeps the old name as an
    // alias (B-261). A local `page.rename` did neither.
    setRenaming(true);
    try {
      const stored = await renamePage(p.id, value);
      // Routes are name-addressed, so the page has just moved out from under its own URL: left
      // there, this view resolved the OLD name, found nothing, and said the page did not exist
      // (B-78). Follow it. `replace`, so Back does not lead to a name that no longer resolves.
      navigate(pageRoutePath(stored), { replace: true });
    } catch (err) {
      // Nothing was written (a name another page already has, or no server to ask): say so and
      // put the real name back rather than leave the input claiming a rename that did not happen.
      setRenaming(false);
      setTitleDraft(p.name);
      window.alert(`Rename failed: ${describeError(err)}`);
    }
  }

  async function createThisPage(): Promise<void> {
    const id = newId();
    const firstBlockId = newId();
    // A page with no blocks has nothing to click into — Create used to leave you staring at a
    // title with nowhere to type (B-75). Give it one empty block and put the caret there, the way
    // a journal day's first block is made.
    requestBlockFocus(firstBlockId);
    // A URL that names a date is a journal day, and gets created as one — stored under its ISO
    // name (ADR 018) with the day set. Creating an ordinary page called "Sep 8th, 2026" here made a
    // page that shadowed the journal forever (B-77): the guard `page.create` has server-side
    // (B-23) does not apply to a client-minted op.
    const day = parseJournalTitle(props.name());
    await applyOp(id, {
      kind: "page.create",
      name: day === null ? props.name() : isoJournalName(day),
      journalDay: day,
      createdAt: Date.now(),
    });
    await applyOp(firstBlockId, {
      kind: "block.create",
      place: { pageId: id, parentId: null, order: orderBetween(null, null) },
      content: "",
      createdAt: Date.now(),
    });
  }

  return (
    <div class="page-view" ref={viewEl}>
      <Show when={blockId()}>
        <div class="page-view-breadcrumb">
          <button
            type="button"
            class="page-view-back"
            onClick={() => navigate(pageRoutePath(props.name()))}
          >
            ← {title()}
          </button>
        </div>
      </Show>

      {/* Only while there is nothing to show yet. `loading` is also true on every REFETCH, and
          every resource refetches whenever its tables change (`data/store.ts`'s version stamping),
          so keying a spinner off `loading` alone replaces the page with "Loading…" every time sync
          pulls — which read as a page stuck loading forever. */}
      <Show when={page.loading && page() === undefined}>
        <p class="page-view-loading">Loading…</p>
      </Show>

      <Show when={!page.loading && page() === null && !renaming()}>
        <div class="page-view-missing">
          <h1>{displayRefName(props.name())}</h1>
          <p>This page doesn't exist yet.</p>
          <button type="button" onClick={() => void createThisPage()}>
            Create "{props.name()}"
          </button>
        </div>
        {agendaSection()}
      </Show>

      <Show when={page()}>
        {(p) => (
          <>
            {/* `.page-title-input` zeroes its own margins, so the heading and the input occupy
                the same space — moving between a journal and an ordinary page does not shift the
                content below. */}
            <div class="page-title-row">
              <PageIconEditor pageId={p().id} icon={properties().icon} />
              <Show when={!isJournal()} fallback={<h1 class="page-title-input">{title()}</h1>}>
                <input
                  class="page-title-input"
                  value={titleDraft()}
                  onInput={(e) => setTitleDraft(e.currentTarget.value)}
                  onBlur={() => void commitTitle()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  readOnly={locked()}
                  aria-label="Page title"
                />
              </Show>
              <Show when={locked()}>
                <span class="page-readonly-badge" title={READ_ONLY_NOTICE}>
                  Read-only
                </span>
              </Show>
              {/* ADR 022: the page's timeline lives at `/history/<name>` (a splat under `/page/`
                  would read "/history" as part of the name). Muted until the row is hovered, like
                  the empty icon slot — a control every page has but few visits need. */}
              <A
                class="page-history-link"
                href={`/history/${pageNameToPath(p().name)}`}
                aria-label="Page history"
              >
                History
              </A>
            </div>
            <PageProperties pageId={p().id} properties={properties()} />
            <find.Bar scope={() => viewEl} />
            <BlockTree
              pageId={p().id}
              rootBlockId={blockId()}
              onNavigate={onNavigate}
              filter={find.filter()}
              onFilterMatches={find.onMatches}
            />

            {agendaSection()}
            <Show when={!blockId()}>
              <NamespaceChildren name={p().name} onNavigate={onNavigate} />
              <ReferencesPanel target={p().name} onNavigate={onNavigate} />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
