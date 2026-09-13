/**
 * Renaming a page from the app goes through the server's `page.update`, not a locally minted
 * `page.rename` op (B-261).
 *
 * A rename is more than the page row: `page.update` rewrites every `[[link]]` and `#tag` that
 * names the page and keeps the old name as an `alias::`, and the rewrite needs the `ref` index,
 * which only the server has — the same reason the M7 refactors are server ops (ADR 020 §1,
 * `./refactor-api.ts`). The title input used to apply a bare `page.rename` locally; it synced and
 * looked right on the page itself while every reference to it pointed at a name nothing answered
 * to any more, and following one offered to "Create" the page.
 *
 * Ordering matters. The push BEFORE the call is not a courtesy: a page created in this tab a moment
 * ago may not have reached the server yet, and `page.update` would answer "no page". There must
 * also be no local `page.rename` in flight — if one reached the server first, the server's page
 * would already carry the new name and `page.update` would see nothing to rename or rewrite. The
 * pull AFTER brings the rename and the rewritten blocks into the local replica, so the caller can
 * navigate to the new name and find it.
 */

import { forceSync } from "../db/client.js";
import { callOp } from "./api-client.js";

/** Rename `pageId` to `newName`; resolves to the name the server stored. Throws `ApiError` — for
 * instance `conflict` when another page already has that name — with nothing written. */
export async function renamePage(pageId: string, newName: string): Promise<string> {
  await forceSync();
  const out = await callOp<{ page: { name: string } }>("page.update", {
    page: pageId,
    new_name: newName,
  });
  await forceSync();
  return out.page.name;
}
