import { describe, expect, it } from "vitest";
import { PairingLinkError, pairingLink } from "./pairing-link.js";

const TOKEN = `nk_${"c".repeat(48)}`;

function params(link: string): { url: string | null; token: string | null } {
  const u = new URL(link);
  expect(u.protocol).toBe("nooklet:");
  expect(u.host).toBe("connect");
  return { url: u.searchParams.get("url"), token: u.searchParams.get("token") };
}

describe("pairingLink (B-603)", () => {
  it("names the graph explicitly for a bare address", () => {
    expect(params(pairingLink("http://192.168.1.5:6100", TOKEN, "default"))).toEqual({
      url: "http://192.168.1.5:6100/g/default",
      token: TOKEN,
    });
    expect(params(pairingLink("https://n.example.ts.net/", TOKEN, "work")).url).toBe(
      "https://n.example.ts.net/g/work",
    );
  });

  it("keeps an address that already has a path", () => {
    expect(params(pairingLink("https://h.example/nooklet/g/default/", TOKEN, "default")).url).toBe(
      "https://h.example/nooklet/g/default",
    );
  });

  it("refuses what the app would refuse", () => {
    for (const bad of [
      "192.168.1.5:6100",
      "ftp://h.example",
      "https://u:p@h.example",
      "https://h.example/?x=1",
      "not a url",
    ]) {
      expect(() => pairingLink(bad, TOKEN, "default"), bad).toThrow(PairingLinkError);
    }
  });
});
