import { describe, expect, it } from "vitest";
import { PairingLinkError, pairingCodeLink, pairingLink, pairingPageUrl } from "./pairing-link.js";

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

describe("QR pairing links with a one-time code (B-655)", () => {
  const CODE = "nkp_abcdefghijklmnopqrstuv";

  it("the page URL keeps the code in the fragment, which no browser sends to a server", () => {
    const url = new URL(pairingPageUrl("https://n.example.ts.net", CODE, "default"));
    expect(url.origin + url.pathname).toBe("https://n.example.ts.net/g/default/pair");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#code=${CODE}`);
  });

  it("the app link carries code=, not token=", () => {
    const u = new URL(pairingCodeLink("http://192.168.1.5:6100", CODE, "work"));
    expect(u.searchParams.get("url")).toBe("http://192.168.1.5:6100/g/work");
    expect(u.searchParams.get("code")).toBe(CODE);
    expect(u.searchParams.has("token")).toBe(false);
  });

  it("refuses the same addresses as the token link", () => {
    expect(() => pairingPageUrl("https://u:p@h.example", CODE, "default")).toThrow(
      PairingLinkError,
    );
  });
});
