/**
 * One journal day's outline in the stream's Today and jumped-to sections: the day's page as a
 * `BlockTree`, the draft that starts the day while it has no page (`VirtualJournalDay.tsx`), or a
 * loading row while the stream has not said which (B-410).
 *
 * Once the draft has started the day, the draft stays and renders the day's tree itself. The
 * section used to swap it for a second tree of the same page as soon as its own resource saw the
 * page, which unmounted the editor the caret had just gone into. Keys typed during the swap were
 * lost, and on the owner's graph `second line` came out as `ecoe` (B-411). Now there is one tree
 * per day for as long as the section shows that day. The caller keys this component by day.
 */
import { createSignal, type JSX, Show } from "solid-js";
import type { JournalDayEntry, NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { JournalDayLoading, VirtualJournalDay } from "./VirtualJournalDay.js";

export function JournalDayOutline(props: {
  day: number;
  /** The stream's entry for `day`; `undefined` while it has not answered for this day. */
  entry: JournalDayEntry | undefined;
  onNavigate?: (t: NavigateTarget) => void;
}): JSX.Element {
  const [started, setStarted] = createSignal(false);
  return (
    <Show when={props.entry !== undefined || started()} fallback={<JournalDayLoading />}>
      <Show
        when={!started() && props.entry?.page}
        fallback={
          <VirtualJournalDay day={props.day} onNavigate={props.onNavigate} onStarted={setStarted} />
        }
      >
        {(page) => <BlockTree pageId={page().id} onNavigate={props.onNavigate} />}
      </Show>
    </Show>
  );
}
