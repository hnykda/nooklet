// @vitest-environment node
/**
 * The inline service-worker takeover listener in `index.html` (B-537). It is the ONLY thing that
 * reloads the page onto a new build, so its three cases are pinned here against the exact script the
 * build ships, not a copy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1] ?? "")
  .find((s) => s.includes("controllerchange"));

function run(controller: object | null, withServiceWorker = true) {
  const container = Object.assign(new EventTarget(), { controller });
  const navigator = withServiceWorker ? { serviceWorker: container } : {};
  const location = { reload: vi.fn() };
  new Function("navigator", "location", inline ?? "throw new Error('no inline script')")(
    navigator,
    location,
  );
  const takeOver = () => container.dispatchEvent(new Event("controllerchange"));
  return { reload: location.reload, takeOver };
}

describe("index.html takeover listener (B-537)", () => {
  it("is in index.html, ahead of the bundle", () => {
    expect(inline).toBeDefined();
    expect(html.indexOf("controllerchange")).toBeLessThan(html.indexOf('type="module"'));
  });

  it("reloads a page an older worker served when a newer one takes it over", () => {
    const { reload, takeOver } = run({ scriptURL: "/sw.js" });
    expect(reload).not.toHaveBeenCalled();
    takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for the claim after a first install, but does for a later update", () => {
    const { reload, takeOver } = run(null);
    takeOver(); // the first worker claims a page that came from the network: already the newest
    expect(reload).not.toHaveBeenCalled();
    takeOver(); // an update found later in the same session
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there are no service workers (Capacitor, insecure origins)", () => {
    expect(() => run(null, false)).not.toThrow();
  });
});
