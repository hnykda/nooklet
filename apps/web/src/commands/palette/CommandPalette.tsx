/**
 * `<CommandPalette>` (R40-R41, BUILD item 3): the shared `Cmd/Ctrl+K` palette. Mixed mode
 * interleaves fuzzy-matched commands and pages; `>` switches to commands-only, `#` to tags, for
 * the rest of the session (until the query is cleared); `nav.switchPage` opens the same component
 * pre-scoped to pages via the shared `PaletteController` (`palette/palette-controller.ts`).
 *
 * Mount ONE instance under `<CommandProvider>`, anywhere in the tree (it renders nothing while
 * closed and portals-in-place via `position: fixed` while open) — see this package's summary for
 * exactly where the integrator should mount it.
 */
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { PageSource, PageSummary } from "../hosts/page-source.js";
import { useCommands } from "../provider/CommandProvider.js";
import { rankItems } from "../ranking/rank.js";
import type { CommandContext } from "../types.js";
import { matchesWhen } from "../when/index.js";
import "../styles.css";

export interface CommandPaletteProps {
  pages: PageSource;
  /** A fresh `CommandContext` base (everything but `exec`/`args`), read on every render/keystroke
   * — the Definitions section's "computed fresh before every ... palette/menu render." */
  getContext: () => Omit<CommandContext, "exec" | "args">;
  /** Navigate to a page the user picked. Wiring actual routing is outside this package's scope. */
  onSelectPage?: (page: PageSummary) => void;
}

interface Row {
  kind: "command" | "page";
  id: string;
  title: string;
  subtitle?: string;
  score: number | null;
  page?: PageSummary;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { registry, palette, mru, buildContext } = useCommands();
  const [highlight, setHighlight] = createSignal(0);
  const [pages, setPages] = createSignal<PageSummary[]>([]);

  onMount(() => {
    void props.pages.listPages().then(setPages);
  });

  function refreshPages() {
    void props.pages.listPages().then(setPages);
  }

  const rows = createMemo<Row[]>(() => {
    const state = palette.state();
    const query = state.query;
    const mode = state.mode;
    const ctxBase = props.getContext();

    const commandCandidates =
      mode === "pages" || mode === "tags"
        ? []
        : registry.list().filter((c) => matchesWhen(c.when, ctxBase));
    const pageCandidates =
      mode === "commands" ? [] : pages().filter((p) => (mode === "tags" ? p.isTag === true : true));

    const rankedCommands = rankItems({ query, items: commandCandidates, mru, kind: "command" });
    const rankedPages = rankItems({ query, items: pageCandidates, mru, kind: "page" });

    const commandRows: Row[] = rankedCommands.map((r) => ({
      kind: "command",
      id: r.item.id,
      title: r.item.title,
      subtitle: r.item.category,
      score: r.score,
    }));
    const pageRows: Row[] = rankedPages.map((r) => ({
      kind: "page",
      id: r.item.id,
      title: r.item.title,
      score: r.score,
      page: r.item,
    }));

    if (mode === "commands") return commandRows;
    if (mode === "pages" || mode === "tags") return pageRows;

    // Mixed mode: an empty query keeps each side's own MRU-first order, concatenated (commands
    // first is an arbitrary but stable choice); a non-empty query re-sorts the combined set by
    // score, matching R73's "results interleave" for the shared ranking algorithm.
    if (query.trim() === "") return [...commandRows, ...pageRows];
    return [...commandRows, ...pageRows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  });

  function onInput(value: string) {
    const mode = palette.state().mode;
    if (mode === "mixed" && value === ">") {
      palette.setMode("commands");
      palette.setQuery("");
      setHighlight(0);
      return;
    }
    if (mode === "mixed" && value === "#") {
      palette.setMode("tags");
      palette.setQuery("");
      setHighlight(0);
      return;
    }
    if (value === "") palette.setMode("mixed"); // R40: clearing the query returns to mixed mode.
    palette.setQuery(value);
    setHighlight(0);
  }

  async function selectRow(row: Row) {
    if (row.kind === "command") {
      const ctx = buildContext(props.getContext());
      await ctx.exec(row.id);
    } else if (row.page) {
      mru.record("page", row.page.id);
      props.onSelectPage?.(row.page);
    }
    palette.close();
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = rows();
    if (e.key === "Escape") {
      e.preventDefault();
      palette.close();
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
    if (e.key === "Enter") {
      e.preventDefault();
      const row = list[highlight()];
      if (row) void selectRow(row);
    }
  }

  return (
    <Show when={palette.isOpen()}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-dismiss (a standard pattern); keyboard users dismiss via Escape on the input below, per onKeyDown. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
      <div class="cmd-overlay" onClick={() => palette.close()}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the overlay's click-to-dismiss from firing for clicks inside the palette itself. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: no keyboard action needed here — it only stops propagation. */}
        <div class="cmd-palette" onClick={(e) => e.stopPropagation()}>
          <input
            ref={(el) => {
              queueMicrotask(() => el.focus());
            }}
            class="cmd-input"
            value={palette.state().query}
            onInput={(e) => {
              onInput(e.currentTarget.value);
              refreshPages();
            }}
            onKeyDown={onKeyDown}
            placeholder={
              palette.state().mode === "commands"
                ? "Type a command…"
                : palette.state().mode === "tags"
                  ? "Search tags…"
                  : "Search, or type > for commands, # for tags…"
            }
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-palette-listbox"
            aria-activedescendant={
              rows()[highlight()] ? `cmd-palette-option-${highlight()}` : undefined
            }
            aria-label="Command palette"
          />
          <div id="cmd-palette-listbox" class="cmd-list" role="listbox">
            <For each={rows()}>
              {(row, i) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the input's onKeyDown (Up/Down/Enter) above, not per-row.
                <div
                  id={`cmd-palette-option-${i()}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i() === highlight()}
                  classList={{ "cmd-row": true, "cmd-row--active": i() === highlight() }}
                  onMouseEnter={() => setHighlight(i())}
                  onClick={() => void selectRow(row)}
                >
                  <span>{row.title}</span>
                  <Show when={row.subtitle}>
                    <span class="cmd-row-subtitle">{row.subtitle}</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={rows().length === 0}>
              <div class="cmd-empty">No results</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
