import { afterEach, describe, expect, it } from "vitest";
import { claimPopupKeys, dispatchPopupKey, isPopupOpen, popupTakesKey } from "./popup-keys.js";

const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

describe("popupTakesKey (B-203)", () => {
  it("nothing is the popup's while no popup is open", () => {
    expect(isPopupOpen()).toBe(false);
    expect(popupTakesKey(key("Enter"))).toBe(false);
  });

  it("a popup the editor feeds takes its keys only without Cmd/Ctrl/Alt", () => {
    release = claimPopupKeys(() => true, { editorFed: true });
    expect(popupTakesKey(key("Enter"))).toBe(true);
    expect(popupTakesKey(key("Tab"))).toBe(true);
    expect(popupTakesKey(key("Enter", { altKey: true }))).toBe(false); // nav.followLink's
    expect(popupTakesKey(key("Enter", { metaKey: true }))).toBe(false);
    expect(popupTakesKey(key("ArrowUp", { altKey: true }))).toBe(false);
    expect(popupTakesKey(key("b", { metaKey: true }))).toBe(false); // never a popup key
  });

  it("an overlay with its own input takes its keys with modifiers too", () => {
    release = claimPopupKeys(() => true);
    expect(popupTakesKey(key("Enter", { metaKey: true }))).toBe(true);
    expect(popupTakesKey(key("ArrowUp", { altKey: true }))).toBe(true);
  });

  it("releasing an older claim leaves a newer one standing", () => {
    const handler = () => true;
    const first = claimPopupKeys(handler);
    release = claimPopupKeys(handler, { editorFed: true });
    first();
    expect(isPopupOpen()).toBe(true);
    expect(dispatchPopupKey("Enter")).toBe(true);
  });
});
