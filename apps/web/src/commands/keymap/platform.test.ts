import { describe, expect, it } from "vitest";
import { detectMobile, detectPlatform, resolveModForPlatform } from "./platform.js";

describe("detectPlatform", () => {
  it("detects mac from platform string", () => {
    expect(
      detectPlatform({ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 0 }),
    ).toBe("mac");
  });

  it("detects iPadOS 13+ (reports as MacIntel with touch points)", () => {
    expect(
      detectPlatform({ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 5 }),
    ).toBe("ios");
  });

  it("detects iPhone from user agent", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe("ios");
  });

  it("detects iPad directly named in the user agent", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0)" })).toBe("ios");
  });

  it("detects Android", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14)" })).toBe("android");
  });

  it("detects Windows", () => {
    expect(detectPlatform({ platform: "Win32", userAgent: "Windows NT 10.0" })).toBe("windows");
  });

  it("falls back to linux", () => {
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "X11; Linux x86_64" })).toBe(
      "linux",
    );
  });

  it("falls back to linux for a completely empty navigator", () => {
    expect(detectPlatform({})).toBe("linux");
  });
});

describe("detectMobile", () => {
  it("is true for ios/android regardless of pointer type", () => {
    expect(detectMobile("ios", false)).toBe(true);
    expect(detectMobile("android", false)).toBe(true);
  });

  it("is true for a touch-primary desktop-OS device", () => {
    expect(detectMobile("windows", true)).toBe(true);
  });

  it("is false for a mouse/keyboard desktop device", () => {
    expect(detectMobile("mac", false)).toBe(false);
    expect(detectMobile("windows", false)).toBe(false);
    expect(detectMobile("linux", false)).toBe(false);
  });
});

describe("resolveModForPlatform (R15)", () => {
  it.each([
    ["mac", "Cmd"],
    ["ios", "Cmd"],
    ["windows", "Ctrl"],
    ["linux", "Ctrl"],
    ["android", "Ctrl"],
  ] as const)("%s -> %s", (platform, expected) => {
    expect(resolveModForPlatform(platform)).toBe(expected);
  });
});
