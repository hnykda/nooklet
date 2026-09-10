// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureView } from "./CaptureView.js";

afterEach(() => cleanup());

describe("CaptureView", () => {
  it("disables save while the textarea is empty", () => {
    render(() => <CaptureView />);
    expect((screen.getByText("Save to journal") as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms the write visibly and clears the textarea on success (fake data seam)", async () => {
    const submit = vi.fn(async (text: string) => {
      expect(text).toBe("buy milk");
      return { pageId: "today-page" };
    });
    render(() => <CaptureView submit={submit} />);

    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "buy milk" } });
    fireEvent.click(screen.getByText("Save to journal"));

    await screen.findByText("Saved to today's journal.");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");
  });

  it("calls onSaved with the journal page id after a successful save", async () => {
    const onSaved = vi.fn();
    const submit = vi.fn(async () => ({ pageId: "p-42" }));
    render(() => <CaptureView submit={submit} onSaved={onSaved} />);

    fireEvent.input(screen.getByPlaceholderText("Capture a thought…"), {
      target: { value: "note" },
    });
    fireEvent.click(screen.getByText("Save to journal"));

    await screen.findByText("Saved to today's journal.");
    expect(onSaved).toHaveBeenCalledWith("p-42");
  });

  it("shows a visible error and keeps the text when the write fails", async () => {
    const submit = vi.fn(async () => {
      throw new Error("offline and no local write path — should not happen, but must not crash");
    });
    render(() => <CaptureView submit={submit} />);

    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "keep me" } });
    fireEvent.click(screen.getByText("Save to journal"));

    await screen.findByText("Could not save — try again.");
    expect(textarea.value).toBe("keep me");
  });

  it("submits on Enter (without Shift) the same way the save button does", async () => {
    const submit = vi.fn(async () => ({ pageId: "p-1" }));
    render(() => <CaptureView submit={submit} />);

    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "enter capture" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText("Saved to today's journal.");
    expect(submit).toHaveBeenCalledWith("enter capture");
  });

  it("Shift+Enter does not submit (leaves room for a newline)", () => {
    const submit = vi.fn();
    render(() => <CaptureView submit={submit} />);
    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("prefills from initialText (share_target/shortcut query params via CaptureRoute)", () => {
    render(() => <CaptureView initialText="shared text" />);
    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("shared text");
  });
});
