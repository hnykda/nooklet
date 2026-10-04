import { describe, expect, it } from "vitest";
import {
  appLinkPath,
  capturePath,
  formatCapture,
  MAX_FIELD_CHARS,
  parseAppLink,
} from "./capture-link.js";

describe("parseAppLink", () => {
  it("reads text, url and title from a capture link", () => {
    expect(
      parseAppLink(
        "nooklet://capture?text=buy%20milk&url=https%3A%2F%2Fexample.com%2Fa&title=An%20article",
      ),
    ).toEqual({
      kind: "capture",
      fields: { text: "buy milk", url: "https://example.com/a", title: "An article" },
    });
  });

  it("accepts the hand-typed spellings nooklet:///capture and nooklet:capture", () => {
    expect(parseAppLink("nooklet:///capture?text=a")).toEqual({
      kind: "capture",
      fields: { text: "a" },
    });
    expect(parseAppLink("nooklet:capture?text=a")).toEqual({
      kind: "capture",
      fields: { text: "a" },
    });
  });

  it("keeps diacritics and newlines intact", () => {
    const text = "Plánování zahradních úprav\ndruhý řádek";
    expect(parseAppLink(`nooklet://capture?text=${encodeURIComponent(text)}`)).toEqual({
      kind: "capture",
      fields: { text },
    });
  });

  it("drops blank fields and opens an empty capture screen for a bare link", () => {
    expect(parseAppLink("nooklet://capture?text=%20%20&url=")).toEqual({
      kind: "capture",
      fields: {},
    });
    expect(parseAppLink("nooklet://capture")).toEqual({ kind: "capture", fields: {} });
  });

  it("caps an oversized field from an untrusted link", () => {
    const huge = "x".repeat(MAX_FIELD_CHARS + 50);
    const parsed = parseAppLink(`nooklet://capture?text=${huge}`);
    expect(parsed?.kind === "capture" && parsed.fields.text?.length).toBe(MAX_FIELD_CHARS);
  });

  it("knows the quick-action links", () => {
    expect(parseAppLink("nooklet://today")).toEqual({ kind: "today" });
    expect(parseAppLink("nooklet://search")).toEqual({ kind: "search" });
    expect(parseAppLink("NOOKLET://Today/")).toEqual({ kind: "today" });
  });

  it("ignores pairing links, other schemes and garbage, so other subscribers can have them", () => {
    expect(parseAppLink("nooklet://connect?url=https%3A%2F%2Fx&code=abc")).toBeUndefined();
    expect(parseAppLink("https://example.com/capture?text=a")).toBeUndefined();
    expect(parseAppLink("not a url")).toBeUndefined();
  });
});

describe("appLinkPath / capturePath", () => {
  it("maps each link to the route it opens", () => {
    expect(appLinkPath({ kind: "today" })).toBe("/journals");
    expect(appLinkPath({ kind: "search" })).toBe("/search");
    expect(appLinkPath({ kind: "capture", fields: {} })).toBe("/capture");
  });

  it("round-trips the fields through the /capture query", () => {
    const path = capturePath({ text: "a & b", url: "https://example.com/?q=1", title: "T" });
    const q = new URL(path, "http://x").searchParams;
    expect(new URL(path, "http://x").pathname).toBe("/capture");
    expect(q.get("text")).toBe("a & b");
    expect(q.get("url")).toBe("https://example.com/?q=1");
    expect(q.get("title")).toBe("T");
  });
});

describe("formatCapture", () => {
  it("shared text is the text", () => {
    expect(formatCapture({ text: "  walk the dog  " })).toBe("walk the dog");
  });

  it("a URL with a title becomes a markdown link", () => {
    expect(formatCapture({ url: "https://example.com/a", title: "An article" })).toBe(
      "[An article](https://example.com/a)",
    );
  });

  it("a bare URL is the URL", () => {
    expect(formatCapture({ url: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("a URL shared as text (Android, Shortcuts) with a title still becomes a link", () => {
    expect(formatCapture({ text: "https://example.com/a", title: "An article" })).toBe(
      "[An article](https://example.com/a)",
    );
  });

  it("text plus a link: the text, then the link", () => {
    expect(
      formatCapture({ text: "read later", url: "https://example.com/a", title: "An article" }),
    ).toBe("read later [An article](https://example.com/a)");
  });

  it("does not repeat a URL the text already contains", () => {
    expect(
      formatCapture({ text: "see https://example.com/a now", url: "https://example.com/a" }),
    ).toBe("see https://example.com/a now");
  });

  it("text that equals the title is not written twice", () => {
    expect(formatCapture({ text: "An article", url: "https://e.com", title: "An article" })).toBe(
      "[An article](https://e.com)",
    );
  });

  it("escapes brackets in a title and keeps it on one line", () => {
    expect(formatCapture({ url: "https://e.com", title: "[draft] notes\non x" })).toBe(
      "[\\[draft\\] notes on x](https://e.com)",
    );
  });

  it("percent-encodes characters that would end the link target early", () => {
    expect(formatCapture({ url: "https://e.com/a_(b) c", title: "T" })).toBe(
      "[T](https://e.com/a_%28b%29%20c)",
    );
  });

  it("a title alone becomes the text; nothing at all is empty", () => {
    expect(formatCapture({ title: "Only a subject" })).toBe("Only a subject");
    expect(formatCapture({})).toBe("");
  });
});
