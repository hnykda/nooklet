import { describe, expect, it } from "vitest";
import {
  graphBaseUrl,
  parsePairingLink,
  rejectedTokenMessage,
  repairTargetFor,
} from "./connect-graph.js";

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

describe("parsePairingLink (B-603)", () => {
  const TOKEN = `nk_${"a".repeat(48)}`;
  const link = (q: string) => `nooklet://connect?${q}`;

  it("reads the server address and token, URL-encoded as `token create --link` prints them", () => {
    const url = encodeURIComponent("http://192.168.1.5:6100");
    expect(parsePairingLink(link(`url=${url}&token=${TOKEN}`))).toEqual({
      serverUrl: "http://192.168.1.5:6100",
      token: TOKEN,
    });
    expect(parsePairingLink(link(`url=https://n.example.ts.net/g/work/&token=${TOKEN}`))).toEqual({
      serverUrl: "https://n.example.ts.net/g/work",
      token: TOKEN,
    });
  });

  it("rejects a non-http(s) server address", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://h.example",
      "h.example",
    ]) {
      const r = parsePairingLink(link(`url=${encodeURIComponent(bad)}&token=${TOKEN}`));
      expect(r, bad).toHaveProperty("error");
    }
  });

  it("rejects a missing url or token, and a token that is not token-shaped", () => {
    expect(parsePairingLink(link(`token=${TOKEN}`))).toHaveProperty("error");
    expect(parsePairingLink(link("url=https://h.example"))).toHaveProperty("error");
    expect(parsePairingLink(link("url=https://h.example&token="))).toHaveProperty("error");
    expect(parsePairingLink(link("url=https://h.example&token=a%20b%3Cscript"))).toHaveProperty(
      "error",
    );
  });

  it("rejects an address with a user-info part, which would disguise the real host", () => {
    const url = encodeURIComponent("https://my-server.example@evil.example");
    expect(parsePairingLink(link(`url=${url}&token=${TOKEN}`))).toHaveProperty("error");
  });

  it("B-655: reads a one-time code instead of a token, strictly shaped, never both", () => {
    const CODE = "nkp_abcdefghijklmnopqrst-_";
    const url = encodeURIComponent("https://n.example.ts.net/g/default");
    expect(parsePairingLink(link(`url=${url}&code=${CODE}`))).toEqual({
      serverUrl: "https://n.example.ts.net/g/default",
      code: CODE,
    });
    expect(parsePairingLink(link(`url=${url}&code=nkp_short`))).toHaveProperty("error");
    expect(parsePairingLink(link(`url=${url}&code=${TOKEN}`))).toHaveProperty("error");
    expect(parsePairingLink(link(`url=${url}&code=${CODE}&token=${TOKEN}`))).toHaveProperty(
      "error",
    );
  });

  it("does not claim other links", () => {
    expect(parsePairingLink("nooklet://page/Foo")).toBeUndefined();
    expect(
      parsePairingLink(`https://connect?url=https://h.example&token=${TOKEN}`),
    ).toBeUndefined();
    expect(parsePairingLink("not a url")).toBeUndefined();
  });
});

describe("rejectedTokenMessage", () => {
  it("a bare address (checked against the default graph) points at /g/<graph>", () => {
    for (const typed of [
      "https://n.example.ts.net",
      "https://n.example.ts.net/",
      "http://192.168.1.5:6100",
    ]) {
      const msg = rejectedTokenMessage(typed);
      expect(msg).toContain("isn't valid for the server's default graph");
      expect(msg).toContain(`${new URL(typed).origin}/g/work`);
    }
  });

  it("an address naming a graph, or none typed (same origin), blames the token", () => {
    const old = "That token was rejected. Check it was copied whole, and not revoked.";
    expect(rejectedTokenMessage("https://n.example.ts.net/g/work")).toBe(old);
    expect(rejectedTokenMessage("https://n.example.ts.net/g/default")).toBe(old);
    expect(rejectedTokenMessage(null)).toBe(old);
  });
});
