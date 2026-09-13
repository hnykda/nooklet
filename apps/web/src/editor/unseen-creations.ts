/**
 * Which blocks this tab created (or revived) that no page refetch has returned yet.
 *
 * `BlockTree` has to decide, whenever a refetch comes back WITHOUT the block being edited, whether
 * that block is about to appear or has gone:
 * - just created here (Enter, a paste, an undone delete) and the write has not committed when the
 *   refetch read — keep the local row, or the editor unmounts mid-keystroke and the next
 *   characters are lost (the "second bullet" typed as "cond bullet" bug);
 * - deleted or moved to another page by another device, an agent, or a server-side refactor —
 *   end editing, or the row sits there with its old text until the next click (B-88).
 *
 * The tree used to treat every absence as the first case. The difference is whether any refetch
 * has ever returned the block: once one has, the database knows it, and a later refetch that does
 * not is news. Refetch results are applied newest-last (`createResource` drops a superseded fetch:
 * solid-js 1.9.15, `loadEnd`'s `if (pr === p)`), so "seen once, then missing" is not the
 * stale-read race the first case guards against — except for a block this tab brings back itself,
 * which is why a revive counts as a creation again.
 *
 * Not covered: a block created here and removed elsewhere before any refetch returned it keeps its
 * row until editing ends. That window is one refetch long.
 */
import type { OpPayload } from "@nooklet/core";

export class UnseenCreations {
  private readonly ids = new Set<string>();

  /** Record what a batch this tab is applying creates or revives. */
  note(ops: ReadonlyArray<{ entity: string; payload: OpPayload }>): void {
    for (const { entity, payload } of ops) {
      if (
        payload.kind === "block.create" ||
        (payload.kind === "block.delete" && payload.deletedAt === null)
      )
        this.ids.add(entity);
    }
  }

  /** A refetch returned these blocks: from now on the database has them. */
  seen(ids: Iterable<string>): void {
    if (this.ids.size === 0) return;
    for (const id of ids) this.ids.delete(id);
  }

  /** Whether `id` is a local creation no refetch has returned yet. */
  has(id: string): boolean {
    return this.ids.has(id);
  }
}
