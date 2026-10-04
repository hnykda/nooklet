/**
 * A block's properties, read-only and compact, under its rendered content (B-101). Before this a
 * block with `author:: Dan` showed only its text: the property existed in the database, in
 * `page.read`, in the markdown mirror — everywhere except on the screen.
 *
 * Editing is not done here. Clicking the chips enters edit mode, where the same properties are
 * `key:: value` lines in the buffer (`editText.ts`) — one way to change a property, the same one a
 * markdown file and `block.update` use, rather than a second mini-editor with its own rules.
 *
 * Placed under the WHOLE content, not literally between line 1 and line 2 as Logseq does: the
 * rendered view resolves a click to a caret offset through one `BlockContentView` over the whole
 * content (`caret.ts`, `data-from`), and splitting that view in two would break it. In the owner's
 * graph 33 of ~400 blocks with a visible property have more than one line.
 */
import { createMemo, For, Show } from "solid-js";
import { sameJson } from "../data/same-json.js";
import "./block-properties.css";
import { InlineContent } from "./InlineContent.js";
import type { NavigateTarget } from "./render/tokens.js";

/**
 * Keys never shown as chips. `list` because the ordinal already says it (OUT-17); the rest are the
 * ones Logseq itself hides from rendered blocks — PDF-highlight bookkeeping, query-table settings,
 * timestamps and macro plumbing that arrive with imported graphs. Source, fetched 2026-09-13:
 * `hidden-built-in-properties` in
 * https://github.com/logseq/logseq/blob/master/deps/graph-parser/src/logseq/graph_parser/property.cljs
 * (`id`, `collapsed` and the task markers in that list are never generic properties here). They
 * stay in the editing buffer: hidden from reading is not the same as deleted.
 */
const HIDDEN_KEYS = new Set([
  "list",
  "heading",
  "background-color",
  "created-at",
  "updated-at",
  "last-modified-at",
  "query-table",
  "query-properties",
  "query-sort-by",
  "query-sort-desc",
  "ls-type",
  "hl-type",
  "hl-page",
  "hl-stamp",
  "hl-color",
  "hl-value",
  "logseq.macro-name",
  "logseq.macro-arguments",
]);

/** Set by the server on the block it makes from a conflict's losing text (ADR 027, B-642). */
export const SYNC_CONFLICT_KEY = "sync-conflict";
const SYNC_CONFLICT_TITLE =
  "This block and the one above were edited on two devices at the same time. The block above kept its own text; this is the other device's. Keep, merge or delete it.";

export function visibleProperties(
  properties: Readonly<Record<string, string>>,
): Array<[string, string]> {
  return Object.entries(properties)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function BlockProperties(props: {
  properties: Readonly<Record<string, string>>;
  onNavigate?: (t: NavigateTarget) => void;
  /** A click that is not on a link inside a value: edit the block. */
  onActivate: () => void;
}) {
  // A memo compared by value: the row gets a new properties object on every refresh, and a fresh
  // array of the same pairs made `<For>` rebuild every property row each time (B-511).
  const entries = createMemo(() => visibleProperties(props.properties), undefined, {
    equals: sameJson,
  });
  return (
    <Show when={entries().length > 0}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the row's own `.vr-block-view` is the keyboard route into edit mode (Enter); this is a pointer shortcut onto the same action, not a second control. */}
      <div
        class="vr-block-props"
        onMouseDown={(e) => {
          // Same reason as `.vr-block-view`'s handler: focus must not land here on the way into
          // edit mode, or the first keystrokes after the click go to <body>.
          if (e.button === 0 && !(e.target as HTMLElement).closest("a, button")) e.preventDefault();
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button")) return;
          props.onActivate();
        }}
      >
        <For each={entries()}>
          {([key, value]) =>
            key === SYNC_CONFLICT_KEY ? (
              // ADR 027: the server's marker on the losing side of a same-block edit conflict. A
              // badge that says what happened, not "sync-conflict: true"; the line stays in the
              // editing buffer, so deleting it there clears the badge once merged by hand.
              <span class="vr-prop vr-prop-conflict" data-key={key} title={SYNC_CONFLICT_TITLE}>
                sync conflict
              </span>
            ) : (
              <span class="vr-prop" data-key={key} title={`${key}:: ${value}`}>
                <span class="vr-prop-key">{key}</span>
                <span class="vr-prop-value">
                  <InlineContent content={value} onNavigate={props.onNavigate} />
                </span>
              </span>
            )
          }
        </For>
      </div>
    </Show>
  );
}
