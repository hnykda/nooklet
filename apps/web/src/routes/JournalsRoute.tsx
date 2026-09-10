/**
 * The journal stream, PLAN.md §8 / BUILD item 1 — see `../views/JournalStreamView.tsx` for the
 * actual view; this route component is intentionally a thin wrapper (routes own URL/param
 * plumbing, views own the UI, per this task's split between `routes/` and `views/`).
 */
import type { JSX } from "solid-js";
import { JournalStreamView } from "../views/JournalStreamView.js";

export function JournalsRoute(): JSX.Element {
  return <JournalStreamView />;
}
