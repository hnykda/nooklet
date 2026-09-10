/**
 * A working fake for `types.ts#Store`, used by this package's own tests (task-state commands).
 * The real implementation is the integrator's responsibility: it wraps `data/store.ts#applyOps`
 * with a correctly-clocked `Op` (HLC + device id) per write — commands/ never constructs an op id
 * itself, since doing so here would risk a second, independent HLC counter racing the one the
 * editor/data layer already owns for the exact same device (two counters could momentarily emit
 * the same timestamp).
 */
import type { ApplyOpsResult, Op, TaskMarker } from "@nooklet/core";
import type { BlockTaskSnapshot, Store } from "../types.js";

const TASK_KEYS = ["marker", "scheduled", "deadline", "repeat"] as const;

export function createFakeStore(
  initial: Record<string, Record<string, string | null>> = {},
): Store & { props: Map<string, Record<string, string | null>> } {
  const props = new Map<string, Record<string, string | null>>(
    Object.entries(initial).map(([id, p]) => [id, { ...p }]),
  );

  function merge(blockId: string, patch: Record<string, string | null>): void {
    const existing = props.get(blockId) ?? {};
    props.set(blockId, { ...existing, ...patch });
  }

  return {
    props,
    async getBlockTaskState(blockId): Promise<BlockTaskSnapshot | undefined> {
      const p = props.get(blockId);
      if (!p) return undefined;
      const snapshot: BlockTaskSnapshot = {
        marker: (p.marker as TaskMarker | null | undefined) ?? null,
      };
      for (const key of TASK_KEYS) {
        if (key === "marker") continue;
        const value = p[key];
        if (value !== undefined && value !== null) snapshot[key] = value;
      }
      return snapshot;
    },
    async setBlockProp(blockId, key, value) {
      merge(blockId, { [key]: value });
    },
    async setBlockProps(blockId, patch) {
      merge(blockId, patch);
    },
    async applyOps(ops: Op[]): Promise<ApplyOpsResult> {
      const results = ops.map((o) => ({
        id: o.id,
        hlc: o.hlc,
        kind: o.payload.kind,
        entity: o.entity,
        status: "applied" as const,
      }));
      return { results, applied: results.length, noop: 0, rejected: 0 };
    },
  };
}
