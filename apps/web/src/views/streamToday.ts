/**
 * The day the journal stream treats as "Today" (B-170). It follows the local day
 * (`../data/day-clock.ts`), so a tab left open overnight shows the new day in the morning — with
 * one exception: it does not move while someone is typing in the stream.
 *
 * Moving "Today" re-homes yesterday's page from the Today section into the earlier days, which
 * unmounts the `BlockTree` rendering it and mounts a fresh one. A typed edit is written only after
 * a ~500 ms pause (`../editor/BlockTree.tsx`'s debounce), and unmounting does not flush it, so
 * swapping the tree out mid-sentence at 00:00 could drop the last few keystrokes. Waiting until
 * input has been idle for `EDIT_IDLE_MS` — well past that debounce — means nothing is pending when
 * the swap happens. An idle caret left in a block overnight does not hold the day back.
 */

import { type Accessor, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { currentDay } from "../data/day-clock.js";

/** Input quiet for this long means the editor's debounced write has already gone out. */
export const EDIT_IDLE_MS = 2_000;
const RETRY_MS = 500;

export function createStreamToday(root: () => HTMLElement | undefined): Accessor<number> {
  const [today, setToday] = createSignal(untrack(currentDay));
  let lastInputAt = Number.NEGATIVE_INFINITY;
  const noteInput = (): void => {
    lastInputAt = Date.now();
  };

  onMount(() => {
    const el = root();
    if (!el) return;
    // Capture phase: the editor stops some key events from bubbling.
    el.addEventListener("keydown", noteInput, true);
    el.addEventListener("input", noteInput, true);
    onCleanup(() => {
      el.removeEventListener("keydown", noteInput, true);
      el.removeEventListener("input", noteInput, true);
    });
  });

  createEffect(() => {
    const day = currentDay();
    if (day === untrack(today)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (): void => {
      timer = undefined;
      if (Date.now() - lastInputAt < EDIT_IDLE_MS) {
        timer = setTimeout(attempt, RETRY_MS);
        return;
      }
      setToday(day);
    };
    attempt();
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  });

  return today;
}
