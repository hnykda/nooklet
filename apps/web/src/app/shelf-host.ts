/**
 * The real `ShelfHost` (`../commands/registrations/shelf.ts`): "Open on shelf" from the palette,
 * the context menu, or a key, landing in the same `./shelf.ts` channel a Shift+click uses — one
 * shelf, several ways in (B-160).
 */

import type { ShelfHost } from "../commands/registrations/shelf.js";
import { queryAs } from "../db/client.js";
import { currentPageNameFromPath } from "./refactor-host.js";
import { openOnShelf } from "./shelf.js";

export function createShelfHost(): ShelfHost {
  return {
    async openBlock(blockId) {
      // A shelved block records its page (see `ShelfTarget`). A Shift+click gets it for free from
      // the `BlockTree` it happened in; a command only has the block id, so ask the replica.
      const rows = await queryAs<{ page_id: string }>(
        "SELECT page_id FROM block WHERE id = ? AND deleted_at IS NULL LIMIT 1",
        [blockId],
      );
      const pageId = rows[0]?.page_id;
      if (pageId) openOnShelf({ kind: "block", id: blockId, pageId });
    },
    openCurrentPage() {
      const name = currentPageNameFromPath(window.location.pathname);
      if (name) openOnShelf({ kind: "page", name });
    },
  };
}
