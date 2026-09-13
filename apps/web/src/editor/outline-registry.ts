/**
 * Every editable `BlockTree` on screen, for the commands that act on "the page" rather than on a
 * block: `block.collapseAll` and `block.expandAll`.
 *
 * Structural commands normally reach a tree through `../app/editor-host.ts`, which only knows the
 * tree that is being edited or has a selection. With nothing focused — the ordinary state when
 * someone opens the palette to tidy a page — there is no such tree, the host is the inert no-op
 * one, and both commands did nothing at all (B-97). A page-scoped command still has an obvious
 * target in that state: the outline(s) the person is looking at. So each tree registers here for
 * its lifetime, and the no-op host hands page-scoped commands to all of them.
 *
 * "All of them" matters only on the journal stream, where each loaded day is its own tree; there,
 * Collapse all with nothing focused folds every day on screen, as it does in Logseq. With a block
 * focused, the focused tree's own host handles the command and only that page changes.
 *
 * A plain `Set`, not a signal: nothing renders from this, it is only read when a command runs.
 */

/** The command ids a tree answers without being focused. */
export const PAGE_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "block.collapseAll",
  "block.expandAll",
]);

export type PageCommandHandler = (commandId: string) => void;

const outlines = new Set<PageCommandHandler>();

/** Register a mounted tree's handler; call the returned function on unmount. */
export function registerOutline(handler: PageCommandHandler): () => void {
  outlines.add(handler);
  return () => outlines.delete(handler);
}

/** Run a page-scoped command on every registered tree. Any other id is ignored: undo, indent and
 * the rest mean something only for the tree that has focus, and must never fan out to every page
 * on screen. Returns how many trees it reached. */
export function runOnOutlines(commandId: string): number {
  if (!PAGE_SCOPED_COMMANDS.has(commandId)) return 0;
  for (const handler of [...outlines]) handler(commandId);
  return outlines.size;
}

/**
 * Typing still inside a tree's write debounce, written now, by every mounted tree (B-192).
 *
 * For a write that happens somewhere other than the local replica — a server op, like "Turn into
 * page". `forceSync` pushes what the replica holds, and the last keystrokes are not in it until the
 * debounce ends: the op read the text as it was before them, and the rewrite that came back met
 * the editor still holding them. The palette and a picker take focus and flush on the way out; the
 * block context menu keeps focus in the editor, so nothing did. Each tree writes only its own
 * pending edit, and one that has none does nothing.
 */
const typingFlushes = new Set<() => void>();

/** Register a mounted tree's flush; call the returned function on unmount. */
export function registerTypingFlush(flush: () => void): () => void {
  typingFlushes.add(flush);
  return () => typingFlushes.delete(flush);
}

export function flushTyping(): void {
  for (const flush of [...typingFlushes]) flush();
}
