import { describe, expect, it, vi } from "vitest";
import { canonicalPageRedirect } from "./canonicalPageRoute.js";

// `navigateTarget.ts` imports the store for block lookups; none of that is exercised here.
vi.mock("../data/store.js", () => ({ resolveBlockPageName: vi.fn() }));
// The router touches `window` at import; the hook half is covered by the e2e spec.
vi.mock("@solidjs/router", () => ({ useNavigate: vi.fn() }));

const zahrada = { name: "Zahrada", key: "zahrada", journalDay: null };

describe("canonicalPageRedirect (B-104)", () => {
  it("moves an alias route to the page's own name", () => {
    expect(canonicalPageRedirect("garden", zahrada, undefined)).toBe("/page/Zahrada");
  });

  it("keeps the zoomed block and encodes namespace segments", () => {
    const page = { name: "Projects/Čapek Notes", key: "projects/čapek notes", journalDay: null };
    expect(canonicalPageRedirect("capek", page, "blk1")).toBe(
      "/page/Projects/%C4%8Capek%20Notes?block=blk1",
    );
  });

  it("stays when the route already names the page, in any case or spacing", () => {
    expect(canonicalPageRedirect("Zahrada", zahrada, undefined)).toBeNull();
    expect(canonicalPageRedirect("  zahrada ", zahrada, undefined)).toBeNull();
  });

  it("stays on a journal day addressed by another title format", () => {
    const day = { name: "2026-09-07", key: "2026-09-07", journalDay: 20260907 };
    expect(canonicalPageRedirect("Sep 7th, 2026", day, undefined)).toBeNull();
  });

  it("stays while there is no page (loading, or a page that does not exist)", () => {
    expect(canonicalPageRedirect("garden", undefined, undefined)).toBeNull();
    expect(canonicalPageRedirect("garden", null, undefined)).toBeNull();
  });
});
