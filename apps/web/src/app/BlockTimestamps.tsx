/**
 * The non-clickable "Created … · Edited …" footer of the block context menu (audit §2 #15).
 * Wording and caveats live in `./block-times.ts`.
 */

import { type JSX, Show } from "solid-js";
import { useBlockTimes } from "../data/block-times.js";
import "./block-timestamps.css";
import { blockTimesLabel, blockTimesTitle } from "./block-times.js";

export function BlockTimestamps(props: { blockId: string }): JSX.Element {
  const times = useBlockTimes(() => props.blockId);
  // `times.error` first: reading an errored resource re-throws, and a failed lookup must cost the
  // menu its footer, not the menu itself.
  const loaded = () => (times.error ? undefined : times());
  return (
    <Show when={loaded()}>
      {(t) => (
        <>
          <div class="ctx-sep" aria-hidden="true" />
          <div
            class="ctx-meta"
            role="note"
            title={blockTimesTitle(t())}
            // A press on plain menu content would move focus to <body>, which ends editing (B-74)
            // while the menu stays open. The items guard against the same thing (B-71).
            onMouseDown={(e) => e.preventDefault()}
          >
            {blockTimesLabel(t())}
          </div>
        </>
      )}
    </Show>
  );
}
