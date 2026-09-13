// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaggedPage } from "../data/api-client.js";
import { TaggedPages } from "./TaggedPages.js";

afterEach(() => cleanup());

const pages: TaggedPage[] = [
  { id: "p1", page: "Adam", source: "property" },
  { id: "p2", page: "Zuzana", source: "property" },
];

describe("TaggedPages (B-111)", () => {
  it("renders nothing when no page carries the tag", () => {
    const { container } = render(() => (
      <TaggedPages target="Person" pages={[]} total={0} onNavigate={() => {}} />
    ));
    expect(container.querySelector(".tagged-pages")).toBeNull();
  });

  it("lists the pages under a counted heading and navigates to one", () => {
    const onNavigate = vi.fn();
    render(() => <TaggedPages target="Person" pages={pages} total={2} onNavigate={onNavigate} />);

    const section = screen.getByRole("region", { name: "Pages tagged Person" });
    expect(section.querySelector(".reference-count")?.textContent).toBe("2");
    expect([...section.querySelectorAll(".tagged-page-link")].map((b) => b.textContent)).toEqual([
      "Adam",
      "Zuzana",
    ]);
    expect(screen.queryByText(/Showing/)).toBeNull();

    fireEvent.click(screen.getByText("Zuzana"));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Zuzana" });
  });

  it("collapses, and says when the list is a window onto a longer one", () => {
    render(() => <TaggedPages target="Journal" pages={pages} total={825} onNavigate={() => {}} />);
    // The count is the real total, and the shortfall is spelled out rather than implied.
    expect(screen.getByText("825")).toBeTruthy();
    expect(screen.getByText("Showing 2 of 825.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Pages tagged Journal/ }));
    expect(screen.queryByText("Adam")).toBeNull();
  });
});
