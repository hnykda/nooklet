import { describe, expect, it } from "vitest";
import { compareHlc, formatHlc, Hlc, HlcDriftError, isHlc, parseHlc } from "./hlc.js";

describe("hlc", () => {
  it("formats and parses", () => {
    const s = formatHlc({
      wall: Date.UTC(2026, 8, 10, 12, 34, 56, 789),
      counter: 3,
      device: "a1b2c3d4",
    });
    expect(s).toBe("2026-09-10T12:34:56.789Z-0003-a1b2c3d4");
    expect(isHlc(s)).toBe(true);
    expect(parseHlc(s)).toEqual({
      wall: Date.UTC(2026, 8, 10, 12, 34, 56, 789),
      counter: 3,
      device: "a1b2c3d4",
    });
  });

  it("is monotonic even when the wall clock stalls or goes backwards", () => {
    let t = 1000;
    const c = new Hlc("aaaaaaaa", undefined, () => t);
    const a = c.next();
    const b = c.next();
    t = 500;
    const d = c.next();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, d)).toBe(-1);
    expect(parseHlc(d).wall).toBe(1000);
  });

  it("absorbs remote clocks", () => {
    let t = 1000;
    const c = new Hlc("aaaaaaaa", undefined, () => t);
    c.receive(formatHlc({ wall: 5000, counter: 7, device: "bbbbbbbb" }));
    const n = c.next();
    expect(parseHlc(n)).toMatchObject({ wall: 5000, counter: 8 });
    t = 6000;
    expect(parseHlc(c.next())).toMatchObject({ wall: 6000, counter: 0 });
  });

  it("rejects remote clocks too far in the future", () => {
    const c = new Hlc("aaaaaaaa", undefined, () => 1000);
    expect(() =>
      c.receive(formatHlc({ wall: 1000 + 61_000, counter: 0, device: "bbbbbbbb" })),
    ).toThrow(HlcDriftError);
  });

  it("orders by wall, then counter, then device", () => {
    const w = 1000;
    const a = formatHlc({ wall: w, counter: 1, device: "aaaaaaaa" });
    const b = formatHlc({ wall: w, counter: 1, device: "bbbbbbbb" });
    const c = formatHlc({ wall: w, counter: 2, device: "aaaaaaaa" });
    const d = formatHlc({ wall: w + 1, counter: 0, device: "aaaaaaaa" });
    expect([d, c, b, a].sort(compareHlc)).toEqual([a, b, c, d]);
  });
});
