// @vitest-environment jsdom
/**
 * Appearance settings: attributes on `<html>` rather than sizes in JS, a `<style>` that is
 * replaced rather than appended to, and defaults that leave no trace in storage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Fresh module per test: the values are module-level signals seeded from localStorage at import,
 *  and the import itself applies them to the document. */
async function load(): Promise<typeof import("./appearance.js")> {
  vi.resetModules();
  return import("./appearance.js");
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.textSize;
  delete document.documentElement.dataset.measure;
  for (const el of document.querySelectorAll("#nooklet-custom-css")) el.remove();
});

describe("text size and content width", () => {
  it("default leaves no attribute and no stored key; a choice sets both", async () => {
    const m = await load();
    expect(m.textSize()).toBe("default");
    expect(document.documentElement.dataset.textSize).toBeUndefined();

    m.setTextSize("large");
    expect(m.textSize()).toBe("large");
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect(localStorage.getItem("nooklet.appearance.textSize")).toBe("large");

    m.setTextSize("default");
    expect(document.documentElement.dataset.textSize).toBeUndefined();
    expect(localStorage.getItem("nooklet.appearance.textSize")).toBeNull();

    m.setContentWidth("wide");
    expect(document.documentElement.dataset.measure).toBe("wide");
    expect(localStorage.getItem("nooklet.appearance.contentWidth")).toBe("wide");
    m.setContentWidth("normal");
    expect(document.documentElement.dataset.measure).toBeUndefined();
  });

  it("applies the stored choice at import and ignores an unknown one", async () => {
    localStorage.setItem("nooklet.appearance.textSize", "larger");
    localStorage.setItem("nooklet.appearance.contentWidth", "enormous");
    const m = await load();
    expect(m.textSize()).toBe("larger");
    expect(document.documentElement.dataset.textSize).toBe("larger");
    expect(m.contentWidth()).toBe("normal");
    expect(document.documentElement.dataset.measure).toBeUndefined();
  });
});

describe("custom CSS", () => {
  it("lives in exactly one <style>, replaced on every change and removed when emptied", async () => {
    const m = await load();
    expect(document.querySelectorAll("#nooklet-custom-css")).toHaveLength(0);

    m.setCustomCss("body { color: red }");
    m.setCustomCss("body { color: blue }");
    const styles = document.querySelectorAll("#nooklet-custom-css");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe("body { color: blue }");
    expect(localStorage.getItem("nooklet.appearance.customCss")).toBe("body { color: blue }");

    m.setCustomCss("   ");
    expect(document.querySelectorAll("#nooklet-custom-css")).toHaveLength(0);
    expect(localStorage.getItem("nooklet.appearance.customCss")).toBeNull();
  });

  it("is on the page from import when stored", async () => {
    localStorage.setItem("nooklet.appearance.customCss", ".x { margin: 0 }");
    const m = await load();
    expect(m.customCss()).toBe(".x { margin: 0 }");
    expect(document.querySelector("#nooklet-custom-css")?.textContent).toBe(".x { margin: 0 }");
  });
});
