import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTarGz,
  readTarGz,
  readTarGzFile,
  type TarBufferSource,
  type TarEntry,
  type TarFileSource,
  writeTarGzFile,
} from "./tar.js";

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

describe("writeTarGzFile / readTarGzFile (streaming)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nooklet-tar-stream-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeArchive(entries: (TarFileSource | TarBufferSource)[]): Promise<string> {
    const path = join(dir, "out.tar.gz");
    const fh = await open(path, "w");
    try {
      await writeTarGzFile(fh, entries);
    } finally {
      await fh.close();
    }
    return path;
  }

  async function readAll(path: string): Promise<TarEntry[]> {
    const out: TarEntry[] = [];
    await readTarGzFile(path, async (h) => {
      const parts: Buffer[] = [];
      return {
        async write(chunk) {
          parts.push(Buffer.from(chunk));
        },
        async end() {
          out.push({ path: h.path, data: Buffer.concat(parts) });
        },
      };
    });
    return out;
  }

  interface Fixture {
    path: string;
    data: Buffer;
    file: string;
    level?: number;
  }

  /** Sizes chosen to hit every padding case and to straddle the 64 KiB read/gunzip chunk size. */
  function fixtureFiles(): Fixture[] {
    const specs: [string, number, number?][] = [
      ["graph.sqlite", 200_001],
      ["assets/empty.txt", 0],
      ["assets/exact.bin", 512],
      ["assets/photo.jpg", 3 * 65_536 + 7, 0],
      ["assets/odd.png", 511, 0],
      ["assets/notes.txt", 70_000],
    ];
    return specs.map(([path, size, level]) => {
      const data = path.endsWith(".txt") ? Buffer.alloc(size, "abc ") : randomBytes(size);
      const file = join(dir, path.replaceAll("/", "_"));
      writeFileSync(file, data);
      return { path, data, file, ...(level === undefined ? {} : { level }) };
    });
  }

  const sources = (files: Fixture[], level?: number): TarFileSource[] =>
    files.map((f) => {
      const l = level ?? f.level;
      return {
        path: f.path,
        file: f.file,
        size: f.data.length,
        ...(l === undefined ? {} : { level: l }),
      };
    });

  it("round-trips files of every padding shape, with stored and deflated entries mixed", async () => {
    const files = fixtureFiles();
    const manifest = { path: "manifest.json", data: Buffer.from('{"a":1}') };
    const back = await readAll(await writeArchive([manifest, ...sources(files)]));
    expect(back.map((e) => e.path)).toEqual(["manifest.json", ...files.map((f) => f.path)]);
    for (const f of files) {
      expect(back.find((e) => e.path === f.path)?.data.equals(f.data)).toBe(true);
    }
  });

  it("new archives read with the old in-memory reader (an older nooklet can restore them)", async () => {
    const files = fixtureFiles();
    const archive = await writeArchive(sources(files));
    // readTarGz is the reader every build up to c9d993b restored with, unchanged.
    const back = readTarGz(readFileSync(archive));
    expect(back.map((e) => e.path)).toEqual(files.map((f) => f.path));
    for (const [i, f] of files.entries()) expect(back[i]?.data.equals(f.data)).toBe(true);
  });

  it("old archives (createTarGz) read with the streaming reader", async () => {
    const entries: TarEntry[] = [
      { path: "manifest.json", data: Buffer.from('{"a":1}') },
      { path: "graph.sqlite", data: randomBytes(100_000) },
      { path: "assets/x.png", data: Buffer.alloc(0) },
    ];
    const path = join(dir, "old.tar.gz");
    writeFileSync(path, createTarGz(entries));
    expect(await readAll(path)).toEqual(entries);
  });

  it("a streamed archive extracts with a real tar binary (skipped if tar is unavailable)", async () => {
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }
    const files = fixtureFiles();
    const archive = await writeArchive(sources(files));
    const outDir = mkdtempSync(join(dir, "x-"));
    execFileSync("tar", ["xzf", archive, "-C", outDir]);
    for (const f of files) expect(readFileSync(join(outDir, f.path)).equals(f.data)).toBe(true);
  });

  it("refuses a file whose size changed since it was listed (its header is already written)", async () => {
    const file = join(dir, "changed.bin");
    writeFileSync(file, Buffer.alloc(1000));
    await expect(writeArchive([{ path: "c.bin", file, size: 999 }])).rejects.toThrow(/grew/);
    await expect(writeArchive([{ path: "c.bin", file, size: 1001 }])).rejects.toThrow(/shrank/);
  });

  it("rejects a truncated archive instead of returning the entries parsed so far", async () => {
    const files = fixtureFiles();
    const bytes = readFileSync(await writeArchive(sources(files)));
    const cut = join(dir, "cut.tar.gz");
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(readAll(cut)).rejects.toThrow();

    // An intact gzip stream around a tar stream that just stops (no end-of-archive blocks): the
    // old reader returned the entries it had; the streaming reader refuses.
    const raw = gunzipSync(createTarGz([{ path: "a.txt", data: Buffer.from("hello") }]));
    const noMarker = join(dir, "nomarker.tar.gz");
    writeFileSync(noMarker, gzipSync(raw.subarray(0, 1024))); // header + one data block
    expect(readTarGz(readFileSync(noMarker))).toHaveLength(1);
    await expect(readAll(noMarker)).rejects.toThrow(/truncated/);
  });

  it("rejects a corrupted archive: a flipped byte inside a stored entry fails the gzip CRC", async () => {
    const files = fixtureFiles();
    const bytes = Buffer.from(readFileSync(await writeArchive(sources(files, 0))));
    // Level 0 everywhere: inflate copies stored blocks verbatim and cannot notice a flipped byte.
    // Only the CRC-32 in the gzip trailer does; the reader drains the stream to its end so that
    // check always runs, even when the end-of-archive marker arrives first.
    const photo = files.find((f) => f.path === "assets/photo.jpg") as Fixture;
    const at = bytes.indexOf(photo.data.subarray(150_000, 150_032)); // stored verbatim: findable
    expect(at).toBeGreaterThan(0);
    bytes[at + 10] = (bytes[at + 10] as number) ^ 0xff;
    const bad = join(dir, "bad.tar.gz");
    writeFileSync(bad, bytes);
    await expect(readAll(bad)).rejects.toThrow();
  });
});
