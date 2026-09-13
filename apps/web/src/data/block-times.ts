/**
 * One block's created/edited timestamps from the local replica, for the context menu's footer
 * (`app/BlockTimestamps.tsx`). Its own module rather than a `use*` in `store.ts` so the hookup
 * stays a new file; it follows `store.ts`'s idiom through `stampedFor` (the worker's change bus
 * has one listener, and `store.ts` owns it).
 */

import { type Accessor, createResource, type Resource } from "solid-js";
import type { BlockTimes } from "../app/block-times.js";
import { queryAs } from "../db/client.js";
import { stampedFor } from "./store.js";

/** `null` = no such live block; `undefined` = loading or no id. Re-reads on any `block` change, so
 * a text edit committed while the menu is open (right-click commits the row being typed in)
 * updates the line instead of showing the time from before it. */
export function useBlockTimes(blockId: Accessor<string | undefined>): Resource<BlockTimes | null> {
  const [resource] = createResource(
    () => {
      const id = blockId();
      return id ? stampedFor(id, ["block"]) : undefined;
    },
    async ({ value: id }) => {
      const rows = await queryAs<{ created_at: number; updated_at: number }>(
        "SELECT created_at, updated_at FROM block WHERE id = ? AND deleted_at IS NULL LIMIT 1",
        [id],
      );
      const r = rows[0];
      return r ? { createdAt: r.created_at, updatedAt: r.updated_at } : null;
    },
  );
  return resource;
}
