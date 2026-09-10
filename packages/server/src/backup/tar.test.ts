import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTarGz, readTarGz, type TarEntry } from "./tar.js";

describe("createTarGz / readTarGz", () => {
  it("round-trips a handful of small files", () => {
    const entries: TarEntry[] = [
      { path: "manifest.json", data: Buffer.from('{"a":1}') },
      { path: "graph.sqlite", data: Buffer.from("not really sqlite but bytes") },
      { path: "assets/1k7f3q9xz2hav4.png", data: Buffer.from([0, 1, 2, 3, 255, 254]) },
    ];
    const archive = createTarGz(entries);
    const back = readTarGz(archive);
    expect(back).toHaveLength(3);
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (let i = 0; i < entries.length; i++) {
      expect(back[i]?.data.equals((entries[i] as TarEntry).data)).toBe(true);
    }
  });

  it("round-trips an empty file", () => {
    const archive = createTarGz([{ path: "empty.txt", data: Buffer.alloc(0) }]);
    const back = readTarGz(archive);
    expect(back).toEqual([{ path: "empty.txt", data: Buffer.alloc(0) }]);
  });

  it("round-trips a file larger than one 512-byte block", () => {
    const data = Buffer.alloc(1500, 0x42);
    const archive = createTarGz([{ path: "big.bin", data }]);
    const back = readTarGz(archive);
    expect(back).toHaveLength(1);
    expect(back[0]?.data.equals(data)).toBe(true);
  });

  it("round-trips an empty archive", () => {
    const archive = createTarGz([]);
    expect(readTarGz(archive)).toEqual([]);
  });

  it("rejects a path longer than 100 bytes", () => {
    const longPath = `assets/${"x".repeat(120)}.png`;
    expect(() => createTarGz([{ path: longPath, data: Buffer.alloc(1) }])).toThrow(/too long/);
  });

  it("produces an archive a real tar binary can list and extract (best-effort, skipped if tar is unavailable)", () => {
    let tarAvailable = true;
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
    } catch {
      tarAvailable = false;
    }
    if (!tarAvailable) return;

    const dir = mkdtempSync(join(tmpdir(), "nooklet-tar-interop-"));
    try {
      const archive = createTarGz([
        { path: "manifest.json", data: Buffer.from('{"schemaVersion":2}') },
        { path: "assets/hello.txt", data: Buffer.from("hello world") },
      ]);
      const archivePath = join(dir, "backup.tar.gz");
      writeFileSync(archivePath, archive);

      const listing = execFileSync("tar", ["tzf", archivePath], { encoding: "utf8" });
      expect(listing).toContain("manifest.json");
      expect(listing).toContain("assets/hello.txt");

      execFileSync("tar", ["xzf", archivePath, "-C", dir]);
      expect(readFileSync(join(dir, "assets/hello.txt"), "utf8")).toBe("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
