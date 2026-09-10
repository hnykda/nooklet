import { describe, expect, it } from "vitest";
import {
  fileNameToPageName,
  namespaceAncestors,
  namespaceParent,
  normalizePageName,
  pageNameToFileName,
} from "./page-name.js";

describe("page names", () => {
  it("normalizes", () => {
    expect(normalizePageName("  Foo   Bar ")).toBe("foo bar");
    expect(normalizePageName("Čeština")).toBe("čeština");
  });

  it("handles namespaces", () => {
    expect(namespaceParent("a/b/c")).toBe("a/b");
    expect(namespaceParent("a")).toBeNull();
    expect(namespaceAncestors("a/b/c")).toEqual(["a/b", "a"]);
  });

  it("converts names to triple-lowbar file names and back", () => {
    expect(pageNameToFileName("a/b/c")).toBe("a___b___c");
    expect(pageNameToFileName('what? "q": 100%')).toBe("what%3F %22q%22%3A 100%25");
    expect(pageNameToFileName(".hidden")).toBe("%2Ehidden");
    for (const name of [
      "a/b/c",
      'what? "q": 100%',
      "@dan schwarz",
      "tea ☕️",
      ".hidden",
      "C# notes",
    ]) {
      expect(fileNameToPageName(pageNameToFileName(name))).toBe(name);
    }
    expect(fileNameToPageName("a%2Fb")).toBe("a/b");
  });
});
