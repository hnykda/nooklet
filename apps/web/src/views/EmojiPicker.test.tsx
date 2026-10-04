// @vitest-environment jsdom
/**
 * B-647: the page-icon picker. The real emoji list is loaded (the `virtual:emoji-data` plugin is in
 * the Vite config the tests run under), so these search what a person would search.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker.js";

function setup(current?: string) {
  const onPick = vi.fn();
  const onRemove = vi.fn();
  const onClose = vi.fn();
  render(() => (
    <EmojiPicker current={current} onPick={onPick} onRemove={onRemove} onClose={onClose} />
  ));
  const search = screen.getByRole("combobox", { name: "Search emoji" }) as HTMLInputElement;
  return { onPick, onRemove, onClose, search };
}

const type = (el: HTMLInputElement, value: string) => fireEvent.input(el, { target: { value } });
const key = (el: HTMLElement, k: string) => fireEvent.keyDown(el, { key: k });
const activeLabel = (search: HTMLInputElement) =>
  document
    .getElementById(search.getAttribute("aria-activedescendant") ?? "")
    ?.getAttribute("aria-label");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("EmojiPicker", () => {
  it("focuses the search field, and typing a name searches instead of inserting letters", async () => {
    const { search, onPick } = setup();
    expect(document.activeElement).toBe(search);
    type(search, "rocket");
    await waitFor(() => expect(activeLabel(search)).toBe("rocket"));
    key(search, "Enter");
    expect(onPick).toHaveBeenCalledWith("🚀");
  });

  it("arrows move through the results; Up from the top row returns to the field", async () => {
    const { search, onPick } = setup();
    type(search, "heart");
    await waitFor(() => expect(activeLabel(search)).toBeTruthy());
    const first = activeLabel(search);
    key(search, "ArrowRight");
    const second = activeLabel(search);
    expect(second).not.toBe(first);
    key(search, "ArrowLeft");
    expect(activeLabel(search)).toBe(first);
    key(search, "ArrowUp");
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    key(search, "ArrowDown");
    key(search, "ArrowRight");
    key(search, "Enter");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).not.toBe("");
  });

  it("offers a typed or pasted emoji as itself", () => {
    const { search, onPick } = setup();
    type(search, "🇨🇿 and words");
    expect(screen.getByText("Use what you typed")).toBeTruthy();
    key(search, "Enter");
    expect(onPick).toHaveBeenCalledWith("🇨🇿");
  });

  it("browsing shows categories and recents; Enter with nothing highlighted picks nothing", async () => {
    localStorage.setItem("nooklet.emoji-recents", JSON.stringify(["🌱"]));
    const { search, onPick } = setup();
    await waitFor(() => expect(screen.getByText("smileys & emotion")).toBeTruthy());
    expect(screen.getByText("Recently used")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Emoji categories" })).toBeTruthy();
    key(search, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    key(search, "ArrowDown");
    key(search, "Enter");
    expect(onPick).toHaveBeenCalledWith("🌱");
  });

  it("a click on a cell picks it", async () => {
    const { search, onPick } = setup();
    type(search, "rocket");
    const cell = await screen.findByRole("option", { name: "rocket" });
    fireEvent.click(cell);
    expect(onPick).toHaveBeenCalledWith("🚀");
  });

  it("Escape clears the query first, then closes", () => {
    const { search, onClose } = setup();
    type(search, "rock");
    key(search, "Escape");
    expect(search.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    key(search, "Escape");
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("offers Remove only when there is an icon", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Remove icon" })).toBeNull();
    cleanup();
    const { onRemove } = setup("🚀");
    fireEvent.click(screen.getByRole("button", { name: "Remove icon" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("a press outside closes it, without taking focus", () => {
    const { onClose } = setup();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
