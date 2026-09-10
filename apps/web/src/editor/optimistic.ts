/**
 * Applies a just-built batch of ops to a local `EditableBlock[]` snapshot immediately, so the UI
 * reflects a structural command (split/indent/outdent/merge/…) the instant it runs rather than
 * waiting for the worker round trip + `usePageTree` resource refetch (`data/store.ts`'s
 * invalidation bus is real but async — Comlink is a `postMessage` boundary). The eventual refetch
 * still lands and reconciles this into the true synced state; this is a same-tab, same-user
 * responsiveness layer only, not a second source of truth (`applyOps` — the real data seam — is
 * always still called with the same ops).
 *
 * `deletedCache` lets an undo of a delete (`block.delete` with `deletedAt: null`) restore a
 * block's full fields — `invertOp` only knows the *tombstone* flips back to alive, not the
 * content/marker/etc. it had, since those never changed by being deleted. `BlockTree.tsx` feeds
 * every block this function is about to drop into the cache first.
 */
import type { EditableBlock } from "./types.js";

export interface OptimisticOp {
  entity: string;
  payload:
    | {
        kind: "block.create";
        place: { parentId: string | null; order: string };
        content: string;
        marker?: EditableBlock["marker"];
        priority?: EditableBlock["priority"];
        collapsed?: boolean;
      }
    | { kind: "block.place"; place: { parentId: string | null; order: string } }
    | { kind: "block.text"; content: string }
    | { kind: "block.prop"; key: string; value: string | null }
    | { kind: "block.delete"; deletedAt: number | null };
}

function withProp(b: EditableBlock, key: string, value: string | null): EditableBlock {
  switch (key) {
    case "collapsed":
      return { ...b, collapsed: value === "true" };
    case "marker":
      return { ...b, marker: value as EditableBlock["marker"] };
    case "priority":
      return { ...b, priority: value as EditableBlock["priority"] };
    case "scheduled":
      return { ...b, scheduled: value };
    case "deadline":
      return { ...b, deadline: value };
    case "repeat":
      return { ...b, repeat: value };
    case "done":
      return { ...b, doneAt: value ? Date.parse(value) : null };
    default:
      return b; // generic block_prop keys are not modeled client-side in this milestone
  }
}

export function applyOptimistic(
  blocks: readonly EditableBlock[],
  ops: readonly OptimisticOp[],
  deletedCache: Map<string, EditableBlock>,
): EditableBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const op of ops) {
    const p = op.payload;
    switch (p.kind) {
      case "block.create":
        byId.set(op.entity, {
          id: op.entity,
          parentId: p.place.parentId,
          order: p.place.order,
          content: p.content,
          marker: p.marker ?? null,
          priority: p.priority ?? null,
          collapsed: p.collapsed ?? false,
          scheduled: null,
          deadline: null,
          repeat: null,
          doneAt: null,
          listNumber: false,
        });
        break;
      case "block.place": {
        const b = byId.get(op.entity);
        if (b) byId.set(op.entity, { ...b, parentId: p.place.parentId, order: p.place.order });
        break;
      }
      case "block.text": {
        const b = byId.get(op.entity);
        if (b) byId.set(op.entity, { ...b, content: p.content });
        break;
      }
      case "block.prop": {
        const b = byId.get(op.entity);
        if (b) byId.set(op.entity, withProp(b, p.key, p.value));
        break;
      }
      case "block.delete": {
        if (p.deletedAt === null) {
          const cached = deletedCache.get(op.entity);
          if (cached && !byId.has(op.entity)) byId.set(op.entity, cached);
        } else {
          const b = byId.get(op.entity);
          if (b) deletedCache.set(op.entity, b);
          byId.delete(op.entity);
        }
        break;
      }
      default:
        break;
    }
  }
  return [...byId.values()];
}
