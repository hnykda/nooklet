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

/**
 * Refuses a plugin `OpDef` that lacks a field the registry relies on, naming every missing one.
 *
 * A plugin reaches here through esbuild, which strips types without checking them, so `defineOp`'s
 * signature guarantees nothing at runtime. An op with no `annotations` used to be accepted, and
 * mounting its HTTP route read `annotations.readOnlyHint` outside any per-plugin guard: `nooklet
 * serve` — and the desktop app, which then never opened — exited at startup (B-402). Thrown from
 * `ctx.ops.register`, inside the plugin's `activate()`, this is that plugin's error instead.
 * (`render` is the registry's own check: it is required only when the op is exposed to MCP.)
 */
function assertCompleteOpDef(def: PluginOpDef): void {
  const d = def as unknown as Record<string, unknown>;
  const isSchema = (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === "function";
  const missing = [
    typeof d.name === "string" ? null : "name",
    typeof d.summary === "string" ? null : "summary",
    typeof d.description === "string" ? null : "description",
    isSchema(d.input) ? null : "input (a zod schema)",
    isSchema(d.output) ? null : "output (a zod schema)",
    typeof d.annotations === "object" && d.annotations !== null ? null : "annotations",
    Array.isArray(d.scopes) ? null : "scopes",
    typeof d.handler === "function" ? null : "handler",
  ].filter((f): f is string => f !== null);
  if (missing.length > 0) {
    const name = typeof d.name === "string" ? `"${d.name}"` : "(unnamed)";
    throw new Error(
      `op ${name} is missing ${missing.join(", ")} — see defineOp's OpDef in @nooklet/plugin-api`,
    );
  }
}

/** Wraps a plugin's `OpDef` so its `handler` runs unchanged, but any thrown "op error shaped"
 * value (whichever `OpError` class produced it) is normalized to THIS package's own `OpError`
 * before it reaches `toErrorBody`. Returns a value structurally assignable to `../ops/registry.ts`'s
 * `OpDef` (plugin-api's `OpDef` and the registry's are the same shape by construction — see
 * `@nooklet/plugin-api/src/op-def.ts`'s header comment). */
export function wrapPluginOp(def: PluginOpDef): ServerOpDef {
  assertCompleteOpDef(def);
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
