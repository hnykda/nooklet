/**
 * Zip safety for the in-app import (ADR 030): an uploaded archive is hostile until proven
 * otherwise. Each refusal test has a control showing the same archive minus the hostile part is
 * accepted, so the refusal is the check under test and not something incidental.
 */

import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractLogseqZip, ZipRejectedError } from "./zip.js";
import { fixtureGraphFiles, rawZip, storeZip, writeZip } from "./zip-test-helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nooklet-zip-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const out = () => join(dir, "out");

describe("extractLogseqZip", () => {
  it("unpacks a graph zipped as its folder, keeping only what the importer reads", async () => {
    const zip = writeZip(join(dir, "g.zip"), storeZip(fixtureGraphFiles("My graph/")));
    const r = await extractLogseqZip(zip, out());
    expect(r.root).toBe("My graph/");
    expect(r.files).toBe(5);
    expect(readdirSync(join(out(), "pages")).sort()).toEqual(["Garden plan.md", "Plánování.md"]);
    expect(existsSync(join(out(), "logseq", "bak"))).toBe(false);
    expect(readFileSync(join(out(), "logseq", "config.edn"), "utf8")).toContain("EEE");
  });

  it("unpacks deflated entries (a zip made by Finder or Files)", async () => {
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([{ name: "pages/A.md", data: "- hello\n".repeat(100), deflate: true }]),
    );
    await extractLogseqZip(zip, out());
    expect(readFileSync(join(out(), "pages", "A.md"), "utf8")).toBe("- hello\n".repeat(100));
  });

  it("refuses path traversal (zip-slip) and writes nothing outside", async () => {
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([
        { name: "pages/A.md", data: "- ok" },
        { name: "../../escaped.md", data: "- pwned" },
      ]),
    );
    await expect(extractLogseqZip(zip, out())).rejects.toThrow(ZipRejectedError);
    expect(existsSync(join(dir, "escaped.md"))).toBe(false);
    expect(existsSync(join(dir, "..", "escaped.md"))).toBe(false);
  });

  it("refuses an absolute entry name", async () => {
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([
        { name: "pages/A.md", data: "- ok" },
        { name: "/tmp/evil.md", data: "- pwned" },
      ]),
    );
    await expect(extractLogseqZip(zip, out())).rejects.toThrow(ZipRejectedError);
  });

  it("skips a symlink entry, and never creates a link", async () => {
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([
        { name: "pages/A.md", data: "- ok" },
        { name: "assets/key.png", data: "../../.ssh/id_ed25519", mode: 0o120777 },
        { name: "assets/real.png", data: "png" },
      ]),
    );
    const r = await extractLogseqZip(zip, out());
    expect(r.warnings.join("\n")).toMatch(/assets\/key\.png: a symbolic link/);
    expect(existsSync(join(out(), "assets", "key.png"))).toBe(false);
    // Control: the regular file next to it came through, as a regular file.
    expect(lstatSync(join(out(), "assets", "real.png")).isFile()).toBe(true);
  });

  it("refuses a decompression bomb by its ratio before writing it", async () => {
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([{ name: "pages/bomb.md", data: zeros, deflate: true }]),
    );
    await expect(extractLogseqZip(zip, out())).rejects.toThrow(/zip bomb/);
    expect(existsSync(join(out(), "pages", "bomb.md"))).toBe(false);
  });

  it("refuses an entry that inflates past the size it declared", async () => {
    // Declares 10 bytes, holds 2 MiB: a ratio check on declared sizes alone would pass it.
    const zip = writeZip(
      join(dir, "g.zip"),
      rawZip([
        {
          name: "pages/liar.md",
          data: new Uint8Array(2 * 1024 * 1024).fill(97),
          deflate: true,
          declaredSize: 10,
        },
      ]),
    );
    await expect(extractLogseqZip(zip, out())).rejects.toThrow();
    const written = existsSync(join(out(), "pages", "liar.md"))
      ? readFileSync(join(out(), "pages", "liar.md")).length
      : 0;
    expect(written).toBeLessThanOrEqual(10);
  });

  it("enforces the total unpacked size and the entry count", async () => {
    const files = { "pages/A.md": "x".repeat(4000), "pages/B.md": "y".repeat(4000) };
    const zip = writeZip(join(dir, "g.zip"), storeZip(files));
    await expect(
      extractLogseqZip(zip, out(), { limits: { maxUnpackedBytes: 5000 } }),
    ).rejects.toThrow(/unpacks to more than/);
    await expect(
      extractLogseqZip(zip, join(dir, "out2"), { limits: { maxEntries: 1 } }),
    ).rejects.toThrow(/lists 2 entries/);
    // Control: within both limits it unpacks.
    await expect(
      extractLogseqZip(zip, join(dir, "out3"), {
        limits: { maxUnpackedBytes: 8000, maxEntries: 2 },
      }),
    ).resolves.toMatchObject({ files: 2 });
  });

  it("refuses something that is not a zip, or not a graph", async () => {
    const notZip = writeZip(join(dir, "a.zip"), Buffer.from("hello"));
    await expect(extractLogseqZip(notZip, out())).rejects.toThrow(/not a readable zip/);
    const notGraph = writeZip(join(dir, "b.zip"), storeZip({ "photos/a.jpg": "x" }));
    await expect(extractLogseqZip(notGraph, join(dir, "o2"))).rejects.toThrow(/not a Logseq/);
  });

  it("keeps the first of two names that differ only in case", async () => {
    const zip = writeZip(
      join(dir, "g.zip"),
      storeZip({ "pages/A.md": "- 1", "pages/a.md": "- 2" }),
    );
    const r = await extractLogseqZip(zip, out());
    expect(r.files).toBe(1);
    expect(r.warnings.join("\n")).toMatch(/duplicate file name/);
  });
});
