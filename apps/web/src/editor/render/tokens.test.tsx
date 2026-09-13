// @vitest-environment jsdom
import { classifyBlockContent, tokenizeContent } from "@nooklet/core";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockContentView, type RenderCtx } from "./tokens.js";

afterEach(cleanup);

function renderContent(content: string, ctx: Partial<RenderCtx> = {}) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content, ...ctx }} />);
}

describe("BlockContentView — content kinds (markdown-grammar.md §2.7 / §4)", () => {
  it("paragraph -> <p class=vr-paragraph>", () => {
    const { container } = renderContent("hello world");
    const p = container.querySelector("p.vr-paragraph");
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe("hello world");
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("heading level %i -> <h%i class=vr-heading>", (level) => {
    const { container } = renderContent(`${"#".repeat(level)} Title`);
    const h = container.querySelector(`h${level}.vr-heading`);
    expect(h).not.toBeNull();
    expect(h?.textContent).toBe("Title");
  });

  it("heading with a trailing paragraph line renders both", () => {
    const { container } = renderContent("## Status\nNumbered:");
    expect(container.querySelector("h2.vr-heading")?.textContent).toBe("Status");
    expect(container.querySelector("p.vr-paragraph")?.textContent).toBe("Numbered:");
  });

  it("fence -> <pre class=vr-fence data-lang> with plain <code> (no highlighter wired)", () => {
    const { container } = renderContent("```js\nconst x = 1;\n```");
    const pre = container.querySelector("pre.vr-fence");
    expect(pre?.getAttribute("data-lang")).toBe("js");
    expect(pre?.querySelector("code")?.textContent).toBe("const x = 1;");
  });

  it("fence uses the highlightCode seam when provided", () => {
    const { container } = renderContent("```js\nx\n```", {
      highlightCode: () => '<span class="tok">x</span>',
    });
    expect(container.querySelector("pre.vr-fence code")?.innerHTML).toBe(
      '<span class="tok">x</span>',
    );
  });

  // B-224: every outliner row renders through here, and the lines of a multi-line block ran
  // together ("plain firstplain second") — `classifyBlockContent` gives one token array per line
  // and nothing put the line break back between them. This test used to assert exactly that
  // run-together text for a quote.
  it("a multi-line paragraph keeps a <br> at each newline, with the newline's own offsets", () => {
    const content = "Poznámka: **žluťoučký kůň**\nsecond line\n\nfourth";
    const { container } = renderContent(content);
    const p = container.querySelector("p.vr-paragraph") as HTMLElement;
    const brs = [...p.querySelectorAll("br")];
    expect(brs.map((br) => [br.dataset.from, br.dataset.to])).toEqual([
      ["27", "28"],
      ["39", "40"],
      ["40", "41"],
    ]);
    for (const br of brs) expect(content[Number(br.dataset.from)]).toBe("\n");
    // The break sits between the lines, not after them.
    expect(p.firstElementChild?.tagName).not.toBe("BR");
    expect(p.lastElementChild?.tagName).not.toBe("BR");
    expect(p.textContent).toBe("Poznámka: žluťoučký kůňsecond linefourth");
  });

  it("quote -> <blockquote class=vr-quote>, one <br> between its lines", () => {
    const { container } = renderContent("> line one\n> line two");
    const bq = container.querySelector("blockquote.vr-quote") as HTMLElement;
    expect(bq.textContent).toBe("line oneline two");
    const brs = [...bq.querySelectorAll("br")];
    expect(brs.map((br) => br.dataset.from)).toEqual(["10"]);
  });

  it("a single-line paragraph has no <br>", () => {
    const { container } = renderContent("just one line");
    expect(container.querySelector("br")).toBeNull();
  });

  it("table -> <table class=vr-table> with header/body/alignment", () => {
    const { container } = renderContent("a|b\n-|-:\n1|2");
    const table = container.querySelector("table.vr-table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody td")).toHaveLength(2);
    const rightAligned = table?.querySelectorAll("th")[1] as HTMLElement;
    expect(rightAligned.style.textAlign).toBe("right");
  });

  it("hr -> <hr class=vr-hr>", () => {
    const { container } = renderContent("---");
    expect(container.querySelector("hr.vr-hr")).not.toBeNull();
  });
});

describe("BlockContentView — inline tokens (markdown-grammar.md §4 rendering contract)", () => {
  it("wikilink -> a.vr-page-ref, alias overrides displayed text", () => {
    const { container } = renderContent("[[Client X]]");
    const a = container.querySelector("a.vr-page-ref");
    expect(a?.getAttribute("href")).toBe("/page/Client%20X");
    expect(a?.textContent).toBe("Client X");

    cleanup();
    const { container: c2 } = renderContent("[[Target|Alias]]");
    expect(c2.querySelector("a.vr-page-ref")?.textContent).toBe("Alias");
  });

  it("wikilink click calls onNavigate({kind:'page'}) instead of following href", () => {
    const onNavigate = vi.fn();
    const { container } = renderContent("[[Client X]]", { onNavigate });
    const a = container.querySelector("a.vr-page-ref") as HTMLAnchorElement;
    a.click();
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Client X" });
  });

  it("tag -> a.vr-tag, plain and multi-word forms", () => {
    const { container } = renderContent("#meeting");
    expect(container.querySelector("a.vr-tag")?.textContent).toBe("#meeting");

    cleanup();
    const { container: c2 } = renderContent("#[[multi word tag]]");
    expect(c2.querySelector("a.vr-tag")?.textContent).toBe("#[[multi word tag]]");
  });

  it("blockRef with no resolver -> muted ((id)) placeholder, class vr-block-ref", () => {
    const { container } = renderContent("((1k7f3q9xz2hav4))");
    const span = container.querySelector("span.vr-block-ref");
    expect(span?.textContent).toBe("((1k7f3q9xz2hav4))");
  });

  it("blockRef with a resolver -> renders the target's own tokens", () => {
    const { container } = renderContent("((1k7f3q9xz2hav4))", {
      resolveBlockRef: () => ({ content: "**bold** target" }),
    });
    const span = container.querySelector("span.vr-block-ref");
    expect(span?.querySelector("strong")?.textContent).toBe("bold");
  });

  it("embed page/block/null render distinct placeholders", () => {
    const { container } = renderContent("{{embed [[Page]]}}");
    expect(container.querySelector(".vr-embed.vr-embed-page")).not.toBeNull();

    cleanup();
    const { container: c2 } = renderContent("{{embed ((1k7f3q9xz2hav4))}}");
    expect(c2.querySelector(".vr-embed.vr-embed-block")).not.toBeNull();

    cleanup();
    const { container: c3 } = renderContent("{{embed nonsense}}");
    expect(c3.querySelector(".vr-embed.vr-embed-error")).not.toBeNull();
  });

  it("generic macro -> .vr-macro-unknown with literal text", () => {
    const { container } = renderContent("{{video https://example.com/x}}");
    expect(container.querySelector(".vr-macro-unknown")?.textContent).toBe(
      "{{video https://example.com/x}}",
    );
  });

  it("linkToPage idiom [label]([[Page]]) -> a.vr-page-ref with the label as content", () => {
    const { container } = renderContent("[see this]([[Client X]])");
    const a = container.querySelector("a.vr-page-ref");
    expect(a?.textContent).toBe("see this");
  });

  it("linkToBlock idiom [label](((id)))", () => {
    const { container } = renderContent("[see this](((1k7f3q9xz2hav4)))");
    expect(container.querySelector("span.vr-block-ref")?.textContent).toBe("see this");
  });

  it("markdown link -> a.vr-link, target=_blank rel=noopener", () => {
    const { container } = renderContent("[example](https://example.com)");
    const a = container.querySelector("a.vr-link") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener");
    expect(a.textContent).toBe("example");
  });

  it("autolink -> a.vr-link.vr-autolink, href text visible", () => {
    const { container } = renderContent("see https://example.com/a for more");
    const a = container.querySelector("a.vr-link.vr-autolink");
    expect(a?.textContent).toBe("https://example.com/a");
  });

  it("image -> img.vr-image with alt/src, lazy loading", () => {
    const { container } = renderContent("![a diagram](assets/1.png)");
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.alt).toBe("a diagram");
    // The stored path is relative; the rendered one is rooted at the server's /assets route, so
    // the picture loads from /page/Some Page as well as from / (B-51).
    expect(img.getAttribute("src")).toBe("/assets/1.png");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("image with an absolute URL is left exactly as written", () => {
    const { container } = renderContent("![x](https://example.com/x.png)");
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/x.png");
  });

  it("a link to an asset (a PDF, say) is rooted the same way", () => {
    const { container } = renderContent("[the report](../assets/r.pdf)");
    const a = container.querySelector("a.vr-link") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/assets/r.pdf");
  });

  it("strong/em/strike/highlight/code render their native/marked elements", () => {
    const { container } = renderContent("**b** *i* ~~s~~ ==h== `c`");
    expect(container.querySelector("strong")?.textContent).toBe("b");
    expect(container.querySelector("em")?.textContent).toBe("i");
    expect(container.querySelector("s")?.textContent).toBe("s");
    expect(container.querySelector("mark.vr-highlight")?.textContent).toBe("h");
    expect(container.querySelector("code.vr-inline-code")?.textContent).toBe("c");
  });

  it("math with no renderer loaded -> plain $tex$ text, class vr-math", () => {
    const { container } = renderContent("$E=mc^2$ today");
    expect(container.querySelector(".vr-math")?.textContent).toBe("$E=mc^2$");
  });

  it("checkbox -> disabled <input type=checkbox>, checked reflects [x]", () => {
    const { container } = renderContent("[ ] todo and [x] done");
    const boxes = container.querySelectorAll<HTMLInputElement>("input.vr-checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.disabled).toBe(true);
    expect(boxes[0]?.checked).toBe(false);
    expect(boxes[1]?.checked).toBe(true);
  });

  it("[x](url) is a link, not a checkbox (link precedence at '[')", () => {
    const { container } = renderContent("[x](https://example.com)");
    expect(container.querySelector("input.vr-checkbox")).toBeNull();
    expect(container.querySelector("a.vr-link")?.textContent).toBe("x");
  });

  it("every rendered token carries data-from/data-to for click-to-caret mapping", () => {
    const content = "hello **world**";
    const { container } = renderContent(content);
    const strongEl = container.querySelector("strong");
    expect(strongEl?.getAttribute("data-from")).toBe(
      String(tokenizeContent(content).find((t) => t.kind === "strong")?.start),
    );
  });
});
