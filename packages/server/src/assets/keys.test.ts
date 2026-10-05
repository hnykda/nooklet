/**
 * B-737 / ADR 036: the asset key's generation and comparison (`./keys.ts`). The route's behaviour
 * (404 for every refusal, 200 with the key) is in `../ops/asset-upload.http.test.ts`; the
 * migration that gives existing assets a key is in `../db.test.ts`.
 */

import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const { ASSET_KEY_LENGTH, assetKeyMatches, assetUrlPath, newAssetKey } = await import("./keys.js");

afterEach(() => {
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe("newAssetKey", () => {
  it("is 128 random bits as 22 URL-safe characters, different every time", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => newAssetKey()));
    expect(keys.size).toBe(1000);
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(k).toHaveLength(ASSET_KEY_LENGTH);
      expect(Buffer.from(k, "base64url")).toHaveLength(16);
    }
  });
});

describe("assetKeyMatches", () => {
  const stored = newAssetKey();

  it("matches only the exact key", () => {
    expect(assetKeyMatches(stored, stored)).toBe(true);
    expect(assetKeyMatches(undefined, stored)).toBe(false);
    expect(assetKeyMatches("", stored)).toBe(false);
    const flipped = `${stored.startsWith("A") ? "B" : "A"}${stored.slice(1)}`;
    expect(assetKeyMatches(flipped, stored)).toBe(false);
    expect(assetKeyMatches(`${stored}x`, stored)).toBe(false);
    expect(assetKeyMatches(stored.slice(1), stored)).toBe(false);
  });

  it("never matches a stored key that is not a real one (a migrated row's '' default, a missing row)", () => {
    expect(assetKeyMatches("", "")).toBe(false);
    expect(assetKeyMatches(undefined, "")).toBe(false);
    expect(assetKeyMatches("short", "short")).toBe(false);
    expect(assetKeyMatches("", null)).toBe(false);
    expect(assetKeyMatches(stored, null)).toBe(false);
  });

  it("compares in constant time: always one timingSafeEqual over two 32-byte digests", () => {
    // Whatever the inputs — right, wrong at the first or last character, a different length, no key
    // at all, no row at all — the work is the same: hash both sides, compare 32 bytes with
    // `timingSafeEqual`. A plain `===` would return at the first differing character.
    const cases: Array<[string | undefined, string | null]> = [
      [stored, stored],
      [`x${stored.slice(1)}`, stored],
      [`${stored.slice(0, -1)}x`, stored],
      ["a", stored],
      [`${stored}${stored}`, stored],
      [undefined, stored],
      [stored, null],
      [undefined, null],
    ];
    for (const [given, s] of cases) {
      vi.mocked(crypto.timingSafeEqual).mockClear();
      assetKeyMatches(given, s);
      const calls = vi.mocked(crypto.timingSafeEqual).mock.calls;
      expect(calls, String(given)).toHaveLength(1);
      const [a, b] = calls[0] as [Buffer, Buffer];
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });
});

describe("assetUrlPath", () => {
  it("is the graph-relative route with the key as k", () => {
    expect(assetUrlPath({ id: "1k7f3q9xz2hav4", ext: "png", key: "K".repeat(22) })).toBe(
      `/assets/1k7f3q9xz2hav4.png?k=${"K".repeat(22)}`,
    );
  });
});
