/**
 * B-642 / ADR 027: the losing side of a same-block text conflict becomes its own block, right after
 * the winner, instead of a `conflict_copy::` property chip under it.
 *
 * Detection stays where it was (ADR 003, `packages/core/src/sync/text-merge.ts`): a client that
 * pulls another device's `block.text` while its own is still pending runs the 3-way merge, and on a
 * genuine overlap pushes `block.prop conflict_copy = <loser text>` on the winning block. Clients
 * built before this change do exactly the same, so the server is the one place that can upgrade
 * every client at once — and the one place that can mint the new block exactly once.
 *
 * Why the server and not the client mints the block: BOTH devices can detect the same conflict
 * (each has the other's op arrive while its own is still pending). Two clients each creating a block
 * would duplicate it; two clients creating it under one derived id would still disagree on its
 * place (each computes an order key from its own replica) and on `content_hlc`, and core's
 * `block.create` is `INSERT OR IGNORE`, so whichever create a replica saw first would stick there —
 * replicas would diverge. The server applies pushes one at a time, so it mints one `block.create`
 * that every replica then receives in `seq` order (ADR 026).
 *
 * Why the id is still derived (sha256 of winner id + loser text) rather than random: the second
 * device's report of the same conflict arrives in a later push. With a derived id the planner sees
 * the block already exists and only clears the property — no state to remember, and a block the
 * person already deleted is not resurrected by a late duplicate report.
 *
 * Everything here is ordinary server-authored ops (like `./subtree-page-repair.ts` and
 * `./ref-pages.ts`): logged, so `verify` replays them; recorded in `changes`, so `batch.undo`
 * covers them; returned as `corrections`, so the pushing device converges at once.
 */

import { createHash } from "node:crypto";
import type { AppliedOpResult, Op, OpPayload, SqlDriver } from "@nooklet/core";
import { orderBetween } from "@nooklet/core";
import type { BlockChangeSnapshot, PageChangeSnapshot } from "./rows.js";

/** The property key a client's text-merge fallback writes (`resolvePendingTextConflict`). */
export const CONFLICT_COPY_KEY = "conflict_copy";

/** The property key on the materialised block, rendered as a badge (`BlockProperties.tsx`). */
export const SYNC_CONFLICT_KEY = "sync-conflict";

/** Reserved device id stamped on the ops this module authors. Not hex, so never a real device;
 * distinct from `SERVER_DEVICE_ID` and `REFERENCE_DEVICE_ID`. */
export const CONFLICT_DEVICE_ID = "conflict";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * The id of the block that holds `text` as a conflict copy of block `winnerId`: 14 Crockford base32
 * characters (ADR 004's shape, so every id check accepts it) taken from 70 bits of
 * sha256(winnerId, NUL, text). Unlike `newId` the leading characters are not a timestamp —
 * nothing reads time out of a block id (`idTime` has no caller outside its own tests).
 */
export function conflictCopyBlockId(winnerId: string, text: string): string {
  const digest = createHash("sha256").update(`${winnerId}\u0000${text}`, "utf8").digest();
  let out = "";
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < 14) {
    if (bits < 5) {
      acc = ((acc << 8) | (digest[i++] as number)) & 0xffff;
      bits += 8;
    }
    out += ALPHABET[(acc >> (bits - 5)) & 31];
    bits -= 5;
  }
  return out;
}

/**
 * Plan the ops that turn every `conflict_copy` this batch wrote into a sibling block, and clear the
 * property. Called inside `serverApplyOps`' transaction after the incoming ops are applied.
 *
 * Which values are materialised, per block a non-rejected sync `block.prop conflict_copy` named:
 *  - each such op's own value, applied or not. A report that lost LWW (`noop`: an earlier report's
 *    clear has a newer HLC) still carries text nobody else has; dropping it would be the silent loss
 *    this exists to prevent. The derived id makes a duplicate a no-op.
 *  - the block's `conflict_copy` value before this batch and its value now, so neither the report's
 *    LWW overwrite nor the clear below discards text — this is how a pre-ADR-027 value on a block
 *    that conflicts again is carried along (the old client-only scheme simply overwrote it). Values
 *    on blocks no new report names are left alone: no migration (ADR 027).
 * Then one `block.prop conflict_copy = null` if the property is set.
 *
 * `mint` stamps a server HLC and `CONFLICT_DEVICE_ID`.
 */
export function planConflictCopies(
  driver: SqlDriver,
  ops: readonly Op[],
  results: readonly AppliedOpResult[],
  before: ReadonlyMap<string, PageChangeSnapshot | BlockChangeSnapshot | null>,
  mint: (entity: string, payload: OpPayload) => Op,
): Op[] {
  const resultById = new Map(results.map((r) => [r.id, r]));
  const textsByBlock = new Map<string, string[]>();
  for (const op of ops) {
    const p = op.payload;
    if (p.kind !== "block.prop" || p.key !== CONFLICT_COPY_KEY) continue;
    const r = resultById.get(op.id);
    if (!r || r.status === "rejected" || r.reason === "no-such-block") continue;
    const texts = textsByBlock.get(op.entity) ?? [];
    if (p.value !== null && p.value.trim() !== "") texts.push(p.value);
    textsByBlock.set(op.entity, texts);
  }

  const out: Op[] = [];
  for (const [winnerId, opTexts] of textsByBlock) {
    const winner = driver.get<{ page_id: string; parent_id: string | null; order_key: string }>(
      "SELECT page_id, parent_id, order_key FROM block WHERE id = ?",
      [winnerId],
    );
    if (!winner) continue;
    const current = driver.get<{ value: string | null }>(
      "SELECT value FROM block_prop WHERE block_id = ? AND key = ?",
      [winnerId, CONFLICT_COPY_KEY],
    )?.value;

    const prior = before.get(winnerId);
    const priorValue =
      prior && "content" in prior ? prior.properties[CONFLICT_COPY_KEY] : undefined;
    const texts = [...opTexts];
    for (const v of [priorValue, current]) if (v != null && v.trim() !== "") texts.push(v);
    // The winner's own text needs no copy (the property can hold it after a later edit made the
    // two sides agree); each distinct text once.
    const winnerText =
      driver.get<{ content: string }>("SELECT content FROM block WHERE id = ?", [winnerId])
        ?.content ?? "";
    const unique = [...new Set(texts)].filter((t) => t !== winnerText);

    // Directly after the winner and before every sibling that follows it (tombstones included,
    // so an un-deleted sibling cannot end up between them). Several copies in one batch go in
    // order, each after the previous.
    const next =
      driver.get<{ k: string | null }>(
        `SELECT MIN(order_key) AS k FROM block
         WHERE page_id = ? AND parent_id IS ? AND order_key > ?`,
        [winner.page_id, winner.parent_id, winner.order_key],
      )?.k ?? null;
    let after = winner.order_key;
    for (const text of unique) {
      const id = conflictCopyBlockId(winnerId, text);
      if (driver.get("SELECT id FROM block WHERE id = ?", [id])) continue;
      const order = orderBetween(after, next);
      after = order;
      out.push(
        mint(id, {
          kind: "block.create",
          place: { pageId: winner.page_id, parentId: winner.parent_id, order },
          content: text,
          properties: { [SYNC_CONFLICT_KEY]: "true" },
          createdAt: Date.now(),
        }),
      );
    }
    if (current != null) {
      out.push(mint(winnerId, { kind: "block.prop", key: CONFLICT_COPY_KEY, value: null }));
    }
  }
  return out;
}
