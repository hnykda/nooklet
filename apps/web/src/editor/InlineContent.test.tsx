// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineContent } from "./InlineContent.js";

afterEach(cleanup);

describe("InlineContent (the required public component, reused for snippets/search hits)", () => {
  it("renders inline tokens for a raw content string", () => {
    const { container } = render(() => <InlineContent content="hello **world** #tag" />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(container.querySelector("a.vr-tag")?.textContent).toBe("#tag");
  });

  it("forwards onNavigate to ref clicks", () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <InlineContent content="[[Some Page]]" onNavigate={onNavigate} />
    ));
    (container.querySelector("a.vr-page-ref") as HTMLAnchorElement).click();
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Some Page" });
  });
});
