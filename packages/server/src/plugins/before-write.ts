/**
 * The `beforeWrite` transform-or-veto seam (ADR 007; `docs/spec/api-and-plugin-types.md` rule 13,
 * `ServerPluginContext.beforeWrite`). Mirrors `../sync/realtime.ts`'s subscribe/notify pattern
 * (a `WeakMap<ServerContext, ...>` of registrations) but is a synchronous transform-or-veto hook
 * rather than a fire-and-forget notification.
 *
 * `../apply-ops.ts`'s `serverApplyOps` calls `runBeforeWrite` exactly once, at the very top,
 * before it does anything else (HLC absorption, the transaction, `changes` rows) — see the single
 * call there for the whole integration. Kept in its own module, not inlined, for the same reason
 * `../sync/realtime.ts` is separate: `apply-ops.ts` stays free of plugin-host bookkeeping beyond
 * that one call.
 *
 * v1 trust note (ADR 007: "v1 runtime is trusted"): `serverApplyOps` is and must stay synchronous
 * — `../sync/push.ts` and most of `../data-api.ts` call it without `await`, and making it async
 * would ripple into every write call site across the codebase (sync push included, which this task
 * is not to touch). So `runBeforeWrite` invokes each handler and uses its return value
 * synchronously: a handler that mutates `tx.ops` in place or `throw`s before returning is honored
 * exactly as the spec describes. A handler that instead returns a pending `Promise` (the type
 * allows `void | Promise<void>`, for a future sandboxed/worker host that truly is async) has that
 * promise's eventual resolution/rejection ignored for THIS write — a documented v1 limitation of
 * the trusted, single-process, synchronous-write host; async transform/veto is a v1.x/v2 upgrade
 * (ADR 007's worker-thread/sandbox path), not a v1 requirement. All 3 built-in plugins and this
 * package's own tests only ever register synchronous handlers.
 */
import type { Op } from "@nooklet/core";
import type { BeforeWriteHandler, OriginKind, PendingWriteTx } from "@nooklet/plugin-api";
import type { ServerContext } from "../apply-ops.js";

interface Registration {
  handler: BeforeWriteHandler;
  priority: number;
  /** Registration order, for a stable tie-break when priorities match. */
  seq: number;
}

const registrationsByCtx = new WeakMap<ServerContext, Registration[]>();
let seqCounter = 0;

/** `ServerPluginContext.beforeWrite`'s real implementation. Returns an unsubscribe function; the
 * host wraps it in a `Disposable` (`./server-context.ts`). */
export function registerBeforeWrite(
  ctx: ServerContext,
  handler: BeforeWriteHandler,
  opts?: { priority?: number },
): () => void {
  const list = registrationsByCtx.get(ctx) ?? [];
  const reg: Registration = { handler, priority: opts?.priority ?? 0, seq: seqCounter++ };
  list.push(reg);
  registrationsByCtx.set(ctx, list);
  return () => {
    const cur = registrationsByCtx.get(ctx);
    if (!cur) return;
    const idx = cur.indexOf(reg);
    if (idx !== -1) cur.splice(idx, 1);
  };
}

/**
 * Called by `serverApplyOps` for every write. Rule 13: MUST be skipped entirely when
 * `origin === "sync"` — an incoming sync write must always converge, never be vetoed or rewritten
 * by a plugin, or replicas diverge. Handlers run in priority order (higher first), ties broken by
 * registration order; each sees (and may mutate) the SAME `tx.ops` array reference, so handler N's
 * transform is visible to handler N+1. A thrown error propagates to the caller, which aborts the
 * write before `serverApplyOps` has opened its transaction — nothing is written.
 */
export function runBeforeWrite(
  ctx: ServerContext,
  txId: string,
  origin: OriginKind,
  deviceId: string | undefined,
  ops: Op[],
): Op[] {
  if (origin === "sync") return ops; // rule 13, non-negotiable
  const list = registrationsByCtx.get(ctx);
  if (!list || list.length === 0) return ops;

  const tx: PendingWriteTx = { id: txId, origin: { kind: origin, deviceId }, ops };
  const ordered = [...list].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  for (const reg of ordered) {
    reg.handler(tx); // see file header: a returned Promise is intentionally not awaited in v1
  }
  return tx.ops;
}
