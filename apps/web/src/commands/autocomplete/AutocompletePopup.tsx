/**
 * `<AutocompletePopup>` (R56-R59, BUILD item 5): one reusable component for `[[` (pages), `#`
 * (tags), and `((` (blocks) — same trigger-driven-by-the-editor pattern as `<SlashMenu>`. The
 * editor watches document changes with `autocomplete/trigger.ts`'s pure matchers and passes the
 * live match down as `props.trigger` (`null` = closed).
 */

import { formatJournalTitle } from "@nooklet/core";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { journalTitleFormat } from "../../data/page-title.js";
import type { EditorHost } from "../hosts/editor-host.js";
import type { BlockSource, BlockSummary, PageSource, PageSummary } from "../hosts/page-source.js";
import { useCommands } from "../provider/CommandProvider.js";
import { rankItems } from "../ranking/rank.js";
import { dateShortcuts } from "./dates.js";
import type { AutocompleteMatch } from "./trigger.js";
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

    const candidates = (pages() ?? []).filter((p) =>
      props.variant === "tag" ? p.isTag === true : true,
    );
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
      const created = await props.pages.createPage(trig.query);
      replaceQueryWith(trig, shape, created.title);
      mru.record("page", created.id);
      props.onDismiss();
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
        const to = trig.from + shape.delimiterLen + trig.query.length;
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
    const to = from + trig.query.length;
    const text = `${title}${shape.closer}`;
    props.editor.replaceRange({ from, to, text, caretOffset: text.length });
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = rows();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onDismiss();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const row = list[highlight()];
      if (row) void selectRow(row);
    }
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
