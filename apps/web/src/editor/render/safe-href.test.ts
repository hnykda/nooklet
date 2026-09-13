/**
 * B-268: a markdown link's URL is content — typed, synced from another device, or written by an
 * MCP agent — and `[me](javascript:…)` became a live `href`.
 */
import { describe, expect, it } from "vitest";
import { isSafeHref, safeHref } from "./safe-href.js";

describe("isSafeHref", () => {
  it("allows the web, mail, phone, app schemes and anything relative", () => {
    for (const href of [
      "https://example.com",
      "http://example.com/a?b#c",
      "mailto:someone@example.com",
      "tel:+420123456789",
      "zotero://select/items/ABC",
      "/assets/r.pdf",
      "../assets/r.pdf",
      "assets/1.png",
      "#section",
      "//example.com/x",
      "page name with: a colon later",
    ]) {
      expect(isSafeHref(href), href).toBe(true);
    }
  });

  it("refuses schemes that run script or smuggle a document, however they are spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "\u0001javascript:alert(1)",
      "javascript:alert(1)\u0000 ",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/uuid",
      "filesystem:https://example.com/temporary/x",
    ]) {
      expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
    }
  });
});

describe("safeHref", () => {
  it("passes a safe href through unchanged and drops an unsafe one", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("javascript:document.title='PWNED'")).toBeUndefined();
  });
});
