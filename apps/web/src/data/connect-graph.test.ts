import { describe, expect, it } from "vitest";
import { graphBaseUrl, repairTargetFor } from "./connect-graph.js";

describe("repairTargetFor (B-613: re-pair the SAME entry)", () => {
  it("a same-origin entry re-pairs in place (null base) and shows the full address", () => {
    expect(repairTargetFor("/g/work", "https://h.example")).toEqual({
      connectBase: null,
      displayUrl: "https://h.example/g/work",
      sessionBase: "/g/work",
      graphSlug: "work",
    });
  });

  it("an absolute (Capacitor) entry re-pairs against its own address", () => {
    expect(repairTargetFor("https://h.example/g/default", "capacitor://localhost")).toEqual({
      connectBase: "https://h.example/g/default",
      displayUrl: "https://h.example/g/default",
      sessionBase: "https://h.example/g/default",
      graphSlug: "default",
    });
  });
});

describe("graphBaseUrl", () => {
  // A WebSocket never follows the server's bare-origin 307 to `/g/default`, so a bare origin
  // stored as-is left `/sync/live` never opening (`tools/probes/ws-bare-origin.mjs`).
  it("maps a bare origin to its default graph", () => {
    expect(graphBaseUrl("http://192.168.1.5:6100")).toBe("http://192.168.1.5:6100/g/default");
    expect(graphBaseUrl("https://nooklet.example.ts.net/")).toBe(
      "https://nooklet.example.ts.net/g/default",
    );
  });

  it("keeps an address that already names a graph or a subpath exactly as typed", () => {
    expect(graphBaseUrl("https://h.example/g/work")).toBe("https://h.example/g/work");
    expect(graphBaseUrl("https://h.example/nooklet/g/default")).toBe(
      "https://h.example/nooklet/g/default",
    );
  });

  it("leaves a non-absolute value alone for the fetch to reject readably", () => {
    expect(graphBaseUrl("/g/default")).toBe("/g/default");
  });
});
