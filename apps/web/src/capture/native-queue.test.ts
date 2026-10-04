/**
 * B-801: the drain must reach the plugin. A Capacitor plugin proxy answers every property,
 * `then` included, with a method wrapper; resolving a promise with it hung forever. The fake below
 * is shaped like `@capacitor/core`'s `registerPlugin` proxy (dist/index.js, 8.5.1).
 */
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("@capacitor/core", () => {
  const impl: Record<string, (arg?: unknown) => Promise<unknown>> = {
    list: async () => ({ ids: [] }),
    read: async () => ({ json: "{}" }),
    remove: async () => undefined,
  };
  const proxy = new Proxy(
    {},
    {
      get(_, prop: string) {
        // Like Capacitor: any property is a method wrapper. A `then` wrapper ignores the
        // resolve/reject callbacks it is handed, so a promise resolved with this never settles.
        return (arg?: unknown) => {
          calls.push(prop);
          return impl[prop]?.(arg) ?? new Promise(() => {});
        };
      },
    },
  );
  return {
    Capacitor: { isPluginAvailable: (name: string) => name === "NookletCapture" },
    registerPlugin: () => proxy,
  };
});

vi.mock("../db/client.js", () => ({ queryAs: async () => [] }));

describe("drainNativeCaptureQueue", () => {
  it("reaches the native plugin and finishes (no thenable trap)", async () => {
    const { drainNativeCaptureQueue } = await import("./native-queue.js");
    const report = await Promise.race([
      drainNativeCaptureQueue(),
      new Promise((r) => setTimeout(() => r("timed out"), 1000)),
    ]);
    expect(report).not.toBe("timed out");
    expect(calls).toContain("list");
  });
});
