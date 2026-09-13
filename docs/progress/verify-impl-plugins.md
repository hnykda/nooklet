# M8 · verify impl-plugins — progress log

Adversarial verification of `m8/impl-plugins` (B-103 client plugin host, B-181). Worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-11`, e2e port 6404, scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-plugins-verify/`.
Branch head at start: `b6c199d`.

## State

Fixes for B-183/B-184/B-185 written, unit + plugins e2e green (7/7; the three new assertions fail on
the unfixed code). Committing next; then wider e2e (popups, render, editing, views) and a real-graph recheck.

Reruns on the branch head as received: typecheck clean; web unit 703/703 (first run 702/703 — a
displayPageName import timeout under load, green on rerun); server 523/523; plugin-api 17/17;
e2e plugins.spec 6/6.

## Findings

1. **B-183** every edit anywhere on a page re-creates every row's rendered content (pre-existing,
   `BlockRowView` content memo), so a mermaid diagram falls back to its `<pre>` source and
   re-renders asynchronously: measured 4 flashes of 14-52 ms, 328 px -> 95 px -> 328 px, while
   typing three words in a sibling row (probe `e2e/tests/zz-probe-verify2.spec.ts`, not kept).
   Fix: PluginFence seeds the last output for the same renderer+source synchronously.
2. **B-184** a mermaid fence that fails to parse leaves mermaid's `div#dnooklet-mermaid-<uuid>`
   ("Syntax error in text" SVG) in `document.body`, one per render attempt (3 broken fences ->
   3 stray divs). mermaid only removes its temp element on error with `suppressErrorRendering`.
3. **B-185** `/mermaid` leaves the caret after the closing fence; the next keystroke makes it
   "```X", which is no longer a fence. Core "Code block" puts the caret inside.
4. Real graph, word count while typing on OmnivoreSync (961 blocks): 2 `rpc/count` per coalesced
   edit (local write, then push drain), 25-80 ms each; final count correct (232731 after 5 words).
   One earlier run right after first load looked stale for 3 s; not reproduced with tracing.
5. Not a defect of this branch: redo (Mod+Shift+Z) after undoing a slash insert restored nothing
   in a probe; not investigated (pre-existing path, not plugin code).

## Commits added

(none yet)
