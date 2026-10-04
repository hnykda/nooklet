/**
 * B-800: every deep-link subscriber sees a cold-start link. With one `getLaunchUrl()` +
 * `claimLaunchUrl()` per subscriber, the first claimed it and the second (`AppLinkHandler`, after
 * `PairingLinkPrompt`) never saw it, so a quick action or `nooklet://capture` link that launched
 * the app opened nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: ((e: { url: string }) => void)[] = [];
let launchUrl: string | undefined;

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_name: string, cb: (e: { url: string }) => void) => {
      listeners.push(cb);
      return { remove: async () => {} };
    },
    getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : undefined),
  },
}));

beforeEach(() => {
  listeners.length = 0;
  vi.resetModules();
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("capacitor deep links", () => {
  it("hands a cold-start link to every subscriber, once each", async () => {
    launchUrl = "nooklet://capture?text=hi";
    const { capacitorPlatform } = await import("./capacitor.js");
    const a: string[] = [];
    const b: string[] = [];
    capacitorPlatform.deepLinks.onOpen((u) => a.push(u));
    capacitorPlatform.deepLinks.onOpen((u) => b.push(u));
    await tick();
    expect(a).toEqual([launchUrl]);
    expect(b).toEqual([launchUrl]);
  });

  it("uses one native listener, and a live link reaches every subscriber", async () => {
    launchUrl = undefined;
    const { capacitorPlatform } = await import("./capacitor.js");
    const a: string[] = [];
    const b: string[] = [];
    capacitorPlatform.deepLinks.onOpen((u) => a.push(u));
    const stopB = capacitorPlatform.deepLinks.onOpen((u) => b.push(u));
    await tick();
    expect(listeners).toHaveLength(1);
    listeners[0]?.({ url: "nooklet://today" });
    stopB();
    listeners[0]?.({ url: "nooklet://search" });
    expect(a).toEqual(["nooklet://today", "nooklet://search"]);
    expect(b).toEqual(["nooklet://today"]);
  });

  it("does not re-deliver a launch link after a reload in the same page session", async () => {
    launchUrl = "nooklet://today";
    let mod = await import("./capacitor.js");
    const first: string[] = [];
    mod.capacitorPlatform.deepLinks.onOpen((u) => first.push(u));
    await tick();
    vi.resetModules(); // a reload: fresh module state, same sessionStorage
    mod = await import("./capacitor.js");
    const second: string[] = [];
    mod.capacitorPlatform.deepLinks.onOpen((u) => second.push(u));
    await tick();
    expect(first).toEqual(["nooklet://today"]);
    expect(second).toEqual([]);
  });
});
