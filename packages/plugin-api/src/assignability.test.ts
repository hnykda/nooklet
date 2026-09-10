/**
 * Type-level tests: the whole failure mode this package exists to prevent is its published types
 * drifting from what `packages/server` actually implements. These checks catch that at
 * `tsc --noEmit`/`vitest typecheck` time, not at runtime — each `it` below also runs a trivial
 * runtime call so the check isn't silently skipped and shows up in the test count, but the real
 * assertion is that this FILE COMPILES AT ALL: if `packages/server`'s real `DataApi`/`OpContext`
 * implementation ever stops satisfying `@nooklet/plugin-api`'s public types, `assertAssignable`
 * below turns that drift into a compile error here, in CI, on this file — not a silent runtime
 * surprise for a plugin author months later.
 *
 * These import the two specific server files directly by relative path
 * (`../../server/src/data-api.ts`, `../../server/src/ops/registry.ts`) rather than via the
 * `@nooklet/server` package specifier. Reason: this workspace ships packages as TS source, not
 * built `dist` (see `package.json`), so importing anything from `@nooklet/server`'s package root
 * (`./src/index.ts`) pulls its ENTIRE re-export graph — including `src/embeddings/*`, which
 * concurrent work-in-progress elsewhere in this repo currently leaves mid-typecheck-error — into
 * *this* package's `tsc --noEmit`, failing plugin-api's typecheck for reasons that have nothing to
 * do with plugin-api. `data-api.ts` and `ops/registry.ts` only transitively import
 * `@nooklet/core` plus each other (verified by reading their imports), so reaching them directly
 * keeps this test scoped to exactly the two files it means to check.
 */
import { describe, expect, it } from "vitest";
import type { DataApi as ServerDataApi } from "../../server/src/data-api.js";
import type {
  OpContext as ServerOpContext,
  OpDef as ServerOpDef,
} from "../../server/src/ops/registry.js";
import type { DataApi as PluginDataApi } from "./data.js";
import type { OpContext as PluginOpContext, OpDef as PluginOpDef } from "./op-def.js";

/** `_value` is only ever used at the type level: passing a `T` where a `U` is expected fails to
 * compile unless `T extends U`. Never actually invoked with a value that matters at runtime. */
function assertAssignable<U>(_value: U): void {}

function checkDataApiAssignableToPluginApi(server: ServerDataApi): void {
  assertAssignable<PluginDataApi>(server);
}

function checkOpContextAssignableToPluginApi(server: ServerOpContext): void {
  assertAssignable<PluginOpContext>(server);
}

function checkOpDefAssignableToPluginApi(server: ServerOpDef): void {
  assertAssignable<PluginOpDef>(server);
}

describe("real implementations satisfy @nooklet/plugin-api's public types", () => {
  it("packages/server's real DataApi implementation type is assignable to plugin-api's DataApi", () => {
    checkDataApiAssignableToPluginApi(null as never);
    expect(true).toBe(true);
  });

  it("packages/server's real OpContext (ops/registry.ts) is assignable to plugin-api's OpContext", () => {
    checkOpContextAssignableToPluginApi(null as never);
    expect(true).toBe(true);
  });

  it("packages/server's real OpDef (ops/registry.ts) is assignable to plugin-api's OpDef", () => {
    checkOpDefAssignableToPluginApi(null as never);
    expect(true).toBe(true);
  });
});
