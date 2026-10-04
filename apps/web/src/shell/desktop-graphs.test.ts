import { describe, expect, it } from "vitest";
import type { DesktopGraph } from "../platform/desktop-shell.js";
import {
  groupDesktopGraphs,
  readAddress,
  readCredential,
  serverGraphPath,
} from "./desktop-graphs.js";

const TOKEN = `nk_${"ab".repeat(24)}`;
const CODE = "nkp_abcdefghijklmnopqrstuv";

function graph(key: string, place: "mac" | "server", address: string): DesktopGraph {
  return { key, place, id: key.split(":")[1] ?? key, label: key, address };
}

describe("groupDesktopGraphs (proposal 005)", () => {
  it("keeps This Mac's graphs in the shell's order and groups servers by host", () => {
    const grouped = groupDesktopGraphs([
      graph("mac:default", "mac", "http://127.0.0.1:6100/g/default"),
      graph("server:a", "server", "https://notes.example.com/g/default"),
      graph("server:b", "server", "http://192.168.1.5:6100/g/x"),
      graph("server:c", "server", "https://notes.example.com/g/work"),
      graph("mac:quiet-otter", "mac", "http://127.0.0.1:6100/g/quiet-otter"),
    ]);
    expect(grouped.mac.map((g) => g.key)).toEqual(["mac:default", "mac:quiet-otter"]);
    expect(grouped.servers.map((s) => [s.host, s.graphs.map((g) => g.key)])).toEqual([
      ["notes.example.com", ["server:a", "server:c"]],
      ["192.168.1.5:6100", ["server:b"]],
    ]);
    expect(serverGraphPath("https://example.ts.net/nooklet/g/work")).toBe("/nooklet/g/work");
  });
});

describe("readCredential: a token, or anything a pairing gives you", () => {
  it("a token, cleaned of what was copied around it (B-706)", () => {
    expect(readCredential(` "${TOKEN}". `)).toEqual({ kind: "token", token: TOKEN });
  });

  it("names a token of the wrong shape, and a root token", () => {
    const short = readCredential("nk_abc");
    expect(short.kind === "error" && short.error).toContain("nk_");
    const root = readCredential(`nkroot_${"a".repeat(48)}`);
    expect(root.kind === "error" && root.error).toContain("root token");
  });

  it("a bare pairing code, a nooklet:// link (code or token), and the pairing page's address", () => {
    expect(readCredential(CODE)).toEqual({ kind: "code", code: CODE });
    expect(
      readCredential(
        `nooklet://connect?url=${encodeURIComponent("https://notes.example.com")}&code=${CODE}`,
      ),
    ).toEqual({ kind: "code", code: CODE, address: "https://notes.example.com/g/default" });
    expect(
      readCredential(
        `nooklet://connect?url=${encodeURIComponent("https://notes.example.com/g/work")}&token=${TOKEN}`,
      ),
    ).toEqual({ kind: "token", token: TOKEN });
    expect(readCredential(`https://notes.example.com/g/work/pair#code=${CODE}`)).toEqual({
      kind: "code",
      code: CODE,
      address: "https://notes.example.com/g/work",
    });
  });

  it("an address pasted into the token field, or a link that is not a pairing link, is named", () => {
    const address = readCredential("https://notes.example.com/g/work");
    expect(address.kind === "error" && address.error).toContain("not a token");
    const other = readCredential("nooklet://open?page=x");
    expect(other.kind === "error" && other.error).toContain("not a pairing link");
    const bad = readCredential(
      `nooklet://connect?url=${encodeURIComponent("ftp://x")}&code=${CODE}`,
    );
    expect(bad.kind).toBe("error");
  });
});

describe("readAddress", () => {
  it("checks the scheme and refuses a user name, but adds no /g/default (the shell needs to know)", () => {
    expect(readAddress(" https://notes.example.com/ ")).toEqual({
      address: "https://notes.example.com",
    });
    expect("error" in readAddress("notes.example.com")).toBe(true);
    expect("error" in readAddress("")).toBe(true);
    expect("error" in readAddress("https://me@notes.example.com")).toBe(true);
  });
});
