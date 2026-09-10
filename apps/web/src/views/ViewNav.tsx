/**
 * A small nav row mounted at the top of every view this task owns (Journals/Page/Search/Tasks):
 * links between them plus the page-switcher trigger (BUILD item 6). `shell/AppShell.tsx` (another
 * agent's file) only links Journals/Search today; this fills the rest in from inside view content
 * rather than editing that shared shell.
 */
import { A, useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { goToTarget } from "./navigateTarget.js";
import { PageFinderTrigger } from "./PageFinder.js";

export function ViewNav(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div class="view-nav">
      <nav class="view-nav-links">
        <A href="/journals" end>
          Journals
        </A>
        <A href="/search">Search</A>
        <A href="/tasks">Tasks</A>
      </nav>
      <PageFinderTrigger onNavigate={(t) => void goToTarget(navigate, t)} />
    </div>
  );
}
