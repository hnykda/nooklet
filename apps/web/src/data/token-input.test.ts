import { describe, expect, it } from "vitest";
import { normalizeToken, tokenShapeProblem } from "./token-input.js";

const DEVICE = `nk_${"0123456789abcdef".repeat(3)}`;
const ROOT = `nkroot_${"fedcba9876543210".repeat(3)}`;

describe("normalizeToken (B-706)", () => {
  it("leaves a valid token unchanged", () => {
    expect(normalizeToken(DEVICE)).toBe(DEVICE);
    expect(normalizeToken(ROOT)).toBe(ROOT);
  });

  it("strips a trailing dot and other punctuation copied from a sentence", () => {
    expect(normalizeToken(`${DEVICE}.`)).toBe(DEVICE);
    expect(normalizeToken(`${DEVICE},`)).toBe(DEVICE);
    expect(normalizeToken(`${DEVICE});`)).toBe(DEVICE);
    expect(normalizeToken(`(${DEVICE}).`)).toBe(DEVICE);
  });

  it("strips backticks and quotes", () => {
    expect(normalizeToken(`\`${DEVICE}\``)).toBe(DEVICE);
    expect(normalizeToken(`"${DEVICE}".`)).toBe(DEVICE);
    expect(normalizeToken(`“${DEVICE}”`)).toBe(DEVICE);
    expect(normalizeToken(`'${ROOT}'`)).toBe(ROOT);
  });

  it("strips whitespace, a newline included, even inside", () => {
    expect(normalizeToken(`  ${DEVICE}\n`)).toBe(DEVICE);
    expect(normalizeToken(`${DEVICE.slice(0, 20)}\n${DEVICE.slice(20)}`)).toBe(DEVICE);
  });
});

describe("tokenShapeProblem (B-706)", () => {
  it("accepts the shapes the server mints", () => {
    expect(tokenShapeProblem(DEVICE, "device")).toBeUndefined();
    expect(tokenShapeProblem(`vrt_${"a".repeat(48)}`, "device")).toBeUndefined(); // pre-rename
    expect(tokenShapeProblem(ROOT, "root")).toBeUndefined();
  });

  it("says what a device token looks like when it is not one", () => {
    const msg =
      "That doesn't look like a nooklet token — it should start with nk_ and be 51 characters.";
    expect(DEVICE).toHaveLength(51);
    expect(tokenShapeProblem(`${DEVICE}.`, "device")).toBe(msg);
    expect(tokenShapeProblem(DEVICE.slice(0, 50), "device")).toBe(msg);
    expect(tokenShapeProblem("hunter2", "device")).toBe(msg);
  });

  it("names a root token pasted where a device token goes, and the reverse", () => {
    expect(tokenShapeProblem(ROOT, "device")).toContain("root token");
    expect(tokenShapeProblem(ROOT, "device")).toContain("nooklet token create");
    expect(tokenShapeProblem(DEVICE, "root")).toContain("device token");
    expect(tokenShapeProblem(DEVICE, "root")).toContain("nooklet token root");
    expect(ROOT).toHaveLength(55);
    expect(tokenShapeProblem("nkroot_x", "root")).toContain("55 characters");
  });
});
