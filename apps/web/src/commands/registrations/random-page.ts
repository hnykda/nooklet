/** `nav.randomPage` (audit §2 #18), category `Navigation`. */
import { normalizePageName } from "@nooklet/core";
import type { Command } from "../types.js";

export interface RandomPageCandidate {
  id: string;
  name: string;
}

/** The seam to the data and the router (`app/CommandLayer.tsx` supplies the real one). */
export interface RandomPageHost {
  /** Pages a random pick may land on: live, not a journal day, with at least one block. */
  candidates(): Promise<RandomPageCandidate[]>;
  /** The name of the page on screen, or `null` when the view is not a page. */
  currentPageName(): string | null;
  open(pageId: string): void;
}

/**
 * One page at random, never the one already showing — "random page" that sometimes does nothing
 * visible reads as broken. `null` when there is nowhere else to go.
 *
 * Why the candidates exclude journal days and empty pages (the host's query): journals are
 * already one keystroke away and are most of a daily-notes graph — in a copy of the owner's graph
 * on 2026-09-13, 825 of 952 pages — so they would swamp the pick; and a page that exists only
 * because something links to it has nothing on it to rediscover (41 of the remaining 127).
 */
export function pickRandomPage(
  candidates: readonly RandomPageCandidate[],
  currentName: string | null,
  random: () => number = Math.random,
): RandomPageCandidate | null {
  const current = currentName === null ? null : normalizePageName(currentName);
  const pool = candidates.filter((c) => normalizePageName(c.name) !== current);
  if (pool.length === 0) return null;
  // `random()` is in [0, 1); the clamp covers a stub that returns exactly 1.
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] ?? null;
}

export function createRandomPageCommands(deps: {
  randomPage: RandomPageHost;
  random?: () => number;
}): Command[] {
  return [
    {
      id: "nav.randomPage",
      title: "Open a random page",
      description: "Jump to a random page (journal days and empty pages are skipped)",
      category: "Navigation",
      defaultKeys: {},
      when: "true",
      async run() {
        const pick = pickRandomPage(
          await deps.randomPage.candidates(),
          deps.randomPage.currentPageName(),
          deps.random,
        );
        if (pick) deps.randomPage.open(pick.id);
      },
    },
  ];
}

export function createFakeRandomPageHost(
  candidates: RandomPageCandidate[] = [],
  current: string | null = null,
): RandomPageHost & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async candidates() {
      return candidates;
    },
    currentPageName: () => current,
    open(pageId) {
      opened.push(pageId);
    },
  };
}
