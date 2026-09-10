import { describe, expect, it } from "vitest";
import {
  baseKeyFromEvent,
  chordSteps,
  isChord,
  KeyNotationError,
  keyTokenFromEvent,
  resolveKeyToken,
  resolveSingleKeyToken,
} from "./notation.js";

describe("resolveSingleKeyToken — Mod resolution and platform mapping (R14-R15)", () => {
  it("resolves Mod to Cmd on mac", () => {
    expect(resolveSingleKeyToken("Mod+Enter", "mac")).toBe("Cmd+Enter");
  });

  it.each(["windows", "linux", "android"] as const)("resolves Mod to Ctrl on %s", (platform) => {
    expect(resolveSingleKeyToken("Mod+Enter", platform)).toBe("Ctrl+Enter");
  });

  it("resolves Mod to Cmd on ios (hardware keyboard assumed for a resolved token)", () => {
    expect(resolveSingleKeyToken("Mod+Enter", "ios")).toBe("Cmd+Enter");
  });

  it("leaves an explicit Cmd/Ctrl untouched regardless of platform", () => {
    expect(resolveSingleKeyToken("Ctrl+D", "mac")).toBe("Ctrl+D");
    expect(resolveSingleKeyToken("Cmd+D", "windows")).toBe("Cmd+D");
  });

  it("reorders modifiers into canonical Mod, Alt, Shift order", () => {
    expect(resolveSingleKeyToken("Shift+Mod+Alt+D", "mac")).toBe("Cmd+Alt+Shift+D");
  });

  it("resolves a plain (unmodified) key unchanged", () => {
    expect(resolveSingleKeyToken("Enter", "mac")).toBe("Enter");
  });

  it.each(["Foo+D", "Mod+", "+D", "Mod+Shift+Q1"])("rejects malformed token %s", (token) => {
    expect(() => resolveSingleKeyToken(token, "mac")).toThrow(KeyNotationError);
  });

  it("accepts every named key and allowed punctuation base key", () => {
    for (const base of [
      "Enter",
      "Escape",
      "Tab",
      "Backspace",
      "Delete",
      "Up",
      "Down",
      "Left",
      "Right",
      "Space",
      "Home",
      "End",
      ".",
      ",",
      "[",
      "]",
      "\\",
      "/",
      "A",
      "0",
    ]) {
      expect(() => resolveSingleKeyToken(`Mod+${base}`, "mac")).not.toThrow();
    }
  });
});

describe("resolveKeyToken — chords", () => {
  it("resolves each step of a chord independently", () => {
    expect(resolveKeyToken("Mod+K Mod+S", "mac")).toBe("Cmd+K Cmd+S");
    expect(resolveKeyToken("Mod+K Mod+S", "windows")).toBe("Ctrl+K Ctrl+S");
  });

  it("tolerates surrounding/extra whitespace", () => {
    expect(resolveKeyToken("  Mod+K   Mod+S  ", "mac")).toBe("Cmd+K Cmd+S");
  });
});

describe("isChord / chordSteps", () => {
  it("identifies a single-step token as not a chord", () => {
    expect(isChord("Cmd+Enter")).toBe(false);
    expect(chordSteps("Cmd+Enter")).toEqual(["Cmd+Enter"]);
  });

  it("identifies a multi-step token as a chord", () => {
    expect(isChord("Cmd+K Cmd+S")).toBe(true);
    expect(chordSteps("Cmd+K Cmd+S")).toEqual(["Cmd+K", "Cmd+S"]);
  });
});

describe("keyTokenFromEvent / baseKeyFromEvent — event to canonical token", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("maps arrow keys to Up/Down/Left/Right", () => {
    expect(keyTokenFromEvent({ ...base, key: "ArrowUp" })).toBe("Up");
    expect(keyTokenFromEvent({ ...base, key: "ArrowDown" })).toBe("Down");
    expect(keyTokenFromEvent({ ...base, key: "ArrowLeft" })).toBe("Left");
    expect(keyTokenFromEvent({ ...base, key: "ArrowRight" })).toBe("Right");
  });

  it("maps space to 'Space'", () => {
    expect(keyTokenFromEvent({ ...base, key: " " })).toBe("Space");
  });

  it("uppercases a plain letter", () => {
    expect(keyTokenFromEvent({ ...base, key: "a" })).toBe("A");
  });

  it("keeps digits and allowed punctuation literal", () => {
    expect(keyTokenFromEvent({ ...base, key: "1" })).toBe("1");
    expect(keyTokenFromEvent({ ...base, key: "." })).toBe(".");
  });

  it("combines modifiers in canonical order from event flags", () => {
    expect(
      keyTokenFromEvent({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "d" }),
    ).toBe("Cmd+Shift+D");
    expect(
      keyTokenFromEvent({
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        key: "Enter",
      }),
    ).toBe("Ctrl+Alt+Enter");
  });

  it("returns null for a bare modifier keypress", () => {
    expect(baseKeyFromEvent({ key: "Shift" })).toBeNull();
    expect(baseKeyFromEvent({ key: "Control" })).toBeNull();
    expect(baseKeyFromEvent({ key: "Alt" })).toBeNull();
    expect(baseKeyFromEvent({ key: "Meta" })).toBeNull();
  });

  it("returns null for a key outside this notation's vocabulary", () => {
    expect(baseKeyFromEvent({ key: "F5" })).toBeNull();
    expect(baseKeyFromEvent({ key: "Dead" })).toBeNull();
  });
});
