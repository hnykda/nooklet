/**
 * `ServerPluginContext.ops.register(opDef)`: the full `defineOp` escape hatch onto the SAME
 * `OpRegistry` core ops use (`../ops/registry.ts`) — HTTP + OpenAPI + MCP, all from one call,
 * exactly like a core op.
 *
 * Bridges the `OpError` divergence `@nooklet/plugin-api/src/op-def.ts`'s header comment flags:
 * a plugin author throws `@nooklet/plugin-api`'s `OpError` (the class their code imports), but
 * `../ops/registry.ts`'s `toErrorBody` (used by both the HTTP and MCP mounts) only recognizes ITS
 * OWN internal `OpError` class via `instanceof` — two distinct class references even though
 * they're structurally identical. Left unbridged, a plugin op's intended `not_found`/`invalid`/…
 * envelope would collapse to a generic `500 internal` on every throw. `wrapPluginOp` below is that
 * bridge: it duck-types on `{code, message, hint?, details?}` (exactly the fix the header comment
 * suggests) and re-throws as the registry's own `OpError` so `toErrorBody` renders the right HTTP
 * status / MCP error shape either way.
 */
import type { OpDef as PluginOpDef } from "@nooklet/plugin-api";
import type { OpErrorCode, OpDef as ServerOpDef } from "../ops/registry.js";
import { HTTP_STATUS, OpError as ServerOpError } from "../ops/registry.js";

function isOpErrorShaped(
  e: unknown,
): e is { code: OpErrorCode; message: string; hint?: string; details?: unknown } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { code: unknown }).code === "string" &&
    (e as { code: string }).code in HTTP_STATUS
  );
}

/** Wraps a plugin's `OpDef` so its `handler` runs unchanged, but any thrown "op error shaped"
 * value (whichever `OpError` class produced it) is normalized to THIS package's own `OpError`
 * before it reaches `toErrorBody`. Returns a value structurally assignable to `../ops/registry.ts`'s
 * `OpDef` (plugin-api's `OpDef` and the registry's are the same shape by construction — see
 * `@nooklet/plugin-api/src/op-def.ts`'s header comment). */
export function wrapPluginOp(def: PluginOpDef): ServerOpDef {
  const wrapped: ServerOpDef = {
    ...(def as unknown as ServerOpDef),
    handler: async (input, ctx) => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: bridging two structurally-identical but nominally distinct OpContext/OpDef type declarations (plugin-api vs. server-internal).
        return await (def.handler as any)(input, ctx);
      } catch (e) {
        if (e instanceof ServerOpError) throw e;
        if (isOpErrorShaped(e))
          throw new ServerOpError(e.code, e.message, e.hint, e.details as never);
        throw e;
      }
    },
  };
  return wrapped;
}
