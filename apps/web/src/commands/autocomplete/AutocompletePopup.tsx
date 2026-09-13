/**
 * `<AutocompletePopup>` (R56-R59, BUILD item 5): one reusable component for `[[` (pages), `#`
 * (tags), and `((` (blocks) — same trigger-driven-by-the-editor pattern as `<SlashMenu>`. The
 * editor watches document changes with `autocomplete/trigger.ts`'s pure matchers and passes the
 * live match down as `props.trigger` (`null` = closed).
 */

import { formatJournalTitle } from "@nooklet/core";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { journalTitleFormat } from "../../data/page-title.js";
import type { EditorHost } from "../hosts/editor-host.js";
import type { BlockSource, BlockSummary, PageSource, PageSummary } from "../hosts/page-source.js";
import { claimPopupKeys } from "../popup-keys.js";
import { useCommands } from "../provider/CommandProvider.js";
import { rankItems } from "../ranking/rank.js";
import { dateShortcuts } from "./dates.js";
import { type AutocompleteMatch, existingRefTailLength } from "./trigger.js";
import "../styles.css";

export type AutocompleteVariant = "page" | "tag" | "block";

export interface AutocompletePopupProps {
  variant: AutocompleteVariant;
  editor: EditorHost;
  /** `null` means closed. */
  trigger: AutocompleteMatch | null;
  position: { top: number; left: number };
  pages?: PageSource; // required for "page"/"tag"
  blocks?: BlockSource; // required for "block"
  onDismiss: () => void;
}

interface Row {
  id: string;
  label: string;
  sublabel?: string;
  isCreate?: boolean;
  page?: PageSummary;
  block?: BlockSummary;
  /** A journal day to link to, from the date shortcuts (`./dates.ts`). */
  day?: number;
}

// Delimiter length + closing text per variant (R56/R57/R58).
const VARIANT_SHAPE: Record<AutocompleteVariant, { delimiterLen: number; closer: string }> = {
  page: { delimiterLen: 2, closer: "]]" },
  tag: { delimiterLen: 1, closer: "" },
  block: { delimiterLen: 2, closer: "))" },
};

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { mru } = useCommands();
  const [highlight, setHighlight] = createSignal(0);

  // Pages are fetched once per "popup opens" transition (not per keystroke) — filtering/ranking
  // against the query happens locally via `rankItems`. Block search, by contrast, is a real
  // query-dependent lookup (R58: full-text match against block content), so it re-fetches
  // whenever the query changes.
  const [pages] = createResource(
    () => (props.variant !== "block" && props.trigger !== null ? true : undefined),
    async () => (props.pages ? props.pages.listPages() : []),
  );
  // `[[` searches blocks too, not only pages — the same thing Logseq does once you start typing,
  // and the reason it is worth having: most of the time you are trying to find a thought you
  // already wrote, and you do not remember which page it is on. Requires a query; listing every
  // block for an empty one would be noise.
  const [blockResults] = createResource(
    () => {
      if (props.trigger === null) return undefined;
      if (props.variant === "block") return props.trigger.query;
      if (props.variant === "page" && props.trigger.query.trim() !== "") return props.trigger.query;
      return undefined;
    },
    async (query) => (props.blocks ? props.blocks.searchBlocks(query) : []),
  );

  const rows = createMemo<Row[]>(() => {
    const trig = props.trigger;
    if (!trig) return [];

    if (props.variant === "block") {
      const results = blockResults() ?? [];
      return results.map(
        (b): Row => ({ id: b.id, label: b.snippet, sublabel: b.pageTitle, block: b }),
      );
    }

    // Every page is a candidate for `#` as much as for `[[`: a tag IS a page (ADR 017), and the
    // `isTag` flag this used to filter on was declared and never set anywhere, so `#` offered
    // nothing but "New page" for pages that were already in use as tags (B-69).
    const candidates = pages() ?? [];
    const ranked = rankItems({ query: trig.query, items: candidates, mru, kind: "page" });
    const pageRows: Row[] = ranked.map((r) => ({
      id: r.item.id,
      label: r.item.title,
      page: r.item,
    }));

    // Nothing typed yet, linking a page: offer the dates. This is the single most common thing
    // anyone links to from a journal, and writing the title format out by hand is tedious.
    if (props.variant === "page" && trig.query.trim() === "") {
      const dateRows: Row[] = dateShortcuts().map((d) => ({
        id: d.id,
        label: d.label,
        sublabel: formatJournalTitle(d.day, journalTitleFormat()),
        day: d.day,
      }));
      return [...dateRows, ...pageRows];
    }

    // R56/R57: append "Create <query>" unless some candidate's title matches the query exactly
    // (case-insensitive), and only once the user has typed something.
    if (trig.query.trim() !== "") {
      const q = trig.query.toLowerCase();
      const hasExact = candidates.some((p) => p.title.toLowerCase() === q);
      if (!hasExact) {
        pageRows.push({ id: "__create__", label: `New page "${trig.query}"`, isCreate: true });
      }
    }

    // Then blocks that mention it, so "I know I wrote this somewhere" works without leaving the
    // editor. After pages and Create: naming a page is the primary intent of `[[`.
    if (props.variant === "page") {
      for (const b of blockResults() ?? []) {
        pageRows.push({ id: `block:${b.id}`, label: b.snippet, sublabel: b.pageTitle, block: b });
      }
    }
    return pageRows;
  });

  async function selectRow(row: Row) {
    const trig = props.trigger;
    if (!trig) return;
    const shape = VARIANT_SHAPE[props.variant];

    if (row.isCreate && props.pages) {
      // Link first, create second. The text used to wait for `createPage`, a round trip to the
      // replica's worker, which on a fresh client is busy with its first sync for seconds: the
      // editor kept showing `[[title` with the popup open, and whatever was typed meanwhile raced
      // the late insertion, which then landed on a buffer that had moved on (B-244). A `[[link]]`
      // to a page that does not exist yet is an ordinary state — references are keyed by name,
      // not id — so nothing depends on the page being there first.
      replaceQueryWith(trig, shape, trig.query);
      props.onDismiss();
      void props.pages.createPage(trig.query).then(
        (created) => mru.record("page", created.id),
        (err) => console.error("nooklet: creating the linked page failed", err),
      );
      return;
    }

    // A date shortcut inserts the date the way the reader reads dates, not the ISO name the page
    // is stored under (ADR 018): `normalizeKey` resolves any recognised format to the same page, so
    // the words in the block can stay the words a person would write.
    if (row.day !== undefined) {
      replaceQueryWith(trig, shape, formatJournalTitle(row.day, journalTitleFormat()));
      props.onDismiss();
      return;
    }

    if (row.block) {
      // Picking a block from `[[` means "reference that block", so the whole `[[…]]` becomes a
      // block ref rather than a page link.
      if (props.variant === "page") {
        const from = trig.from;
        const to = queryEnd(trig, shape);
        const text = `((${row.block.id}))`;
        props.editor.replaceRange({ from, to, text, caretOffset: text.length });
      } else {
        replaceQueryWith(trig, shape, row.block.id);
      }
      props.onDismiss();
      return;
    }

    if (row.page) {
      replaceQueryWith(trig, shape, row.page.title);
      mru.record("page", row.page.id);
      props.onDismiss();
    }
  }

  function replaceQueryWith(
    trig: AutocompleteMatch,
    shape: { delimiterLen: number; closer: string },
    title: string,
  ): void {
    const from = trig.from + shape.delimiterLen;
    const to = queryEnd(trig, shape);
    const text = `${title}${shape.closer}`;
    props.editor.replaceRange({ from, to, text, caretOffset: text.length });
  }

  /** Where the replaced text ends: the caret, or — when the caret is inside a link that is already
   * closed — that link's closer, so the old link's tail does not stay behind the new one (B-294). */
  function queryEnd(trig: AutocompleteMatch, shape: { delimiterLen: number; closer: string }) {
    const caret = trig.from + shape.delimiterLen + trig.query.length;
    if (shape.closer !== "]]" && shape.closer !== "))") return caret;
    const content = props.editor.getSelection()?.content ?? "";
    return caret + existingRefTailLength(content.slice(caret), shape.closer);
  }

  /** The popup's keymap (R12 step 2). Reached two ways: from the editor's own key dispatch via
   * `claimPopupKeys` — the normal case, since the editor keeps focus while the popup is open —
   * and from this element's `onKeyDown` when a row has been clicked and holds focus itself. */
  function handleKey(key: string): boolean {
    const list = rows();
    if (key === "Escape") {
      props.onDismiss();
      return true;
    }
    if (key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      return true;
    }
    if (key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      return true;
    }
    if (key === "Enter" || key === "Tab") {
      const row = list[highlight()];
      if (row) void selectRow(row);
      return true;
    }
    return false;
  }

  // Own the popup keys for exactly as long as there is a trigger (B-65). The release runs both
  // when the trigger goes null and when the component unmounts, so a popup can never leave the
  // editor believing it is still open.
  createEffect(() => {
    if (props.trigger === null) return;
    // `editorFed`: the editor keeps focus and offers this popup only keys without Cmd/Ctrl/Alt,
    // so Alt+Enter (follow the link under the caret) and friends stay the keymap's (B-203).
    const release = claimPopupKeys(handleKey, { editorFed: true });
    onCleanup(release);
  });

  function onKeyDown(e: KeyboardEvent) {
    if (handleKey(e.key)) e.preventDefault();
  }

  return (
    <Show when={props.trigger !== null}>
      <div
        class="cmd-popup"
        style={{ top: `${props.position.top}px`, left: `${props.position.left}px` }}
        role="listbox"
        onKeyDown={onKeyDown}
      >
        <For each={rows()}>
          {(row, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the listbox's own onKeyDown above, not per-row.
            <div
              role="option"
              tabIndex={-1}
              // Focus stays in the editor: a row that took focus on mousedown left the caret
              // nowhere after the click (B-71).
              onMouseDown={(e) => e.preventDefault()}
              aria-selected={i() === highlight()}
              classList={{ "cmd-row": true, "cmd-row--active": i() === highlight() }}
              onMouseEnter={() => setHighlight(i())}
              onClick={() => void selectRow(row)}
            >
              <span>{row.label}</span>
              <Show when={row.sublabel}>
                <span class="cmd-row-subtitle">{row.sublabel}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={rows().length === 0}>
          <div class="cmd-empty">No results</div>
        </Show>
      </div>
    </Show>
  );
}
