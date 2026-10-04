// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_DRAFT_KEY, CaptureView } from "./CaptureView.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

  it("a prefill is never saved on its own: nothing is written until Save (ADR 033)", async () => {
    const submit = vi.fn(async () => ({ pageId: "p" }));
    render(() => <CaptureView initialText="from a link" submit={submit} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save to journal"));
    await screen.findByText("Saved to today's journal.");
    expect(submit).toHaveBeenCalledWith("from a link");
  });

  it("Cancel discards the prefill without writing", () => {
    const submit = vi.fn();
    const onCancel = vi.fn();
    render(() => <CaptureView initialText="from a link" submit={submit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("with no graph: says so, cannot save, and keeps the text as a draft", () => {
    const submit = vi.fn();
    const onSetUpGraph = vi.fn();
    render(() => (
      <CaptureView
        initialText="first thought"
        noGraph
        submit={submit}
        onSetUpGraph={onSetUpGraph}
      />
    ));
    expect(screen.getByText(/no graph on this device yet/)).toBeTruthy();
    expect(screen.queryByText("Save to journal")).toBeNull();
    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(localStorage.getItem(CAPTURE_DRAFT_KEY)).toBe("first thought");
    fireEvent.input(textarea, { target: { value: "first thought, edited" } });
    expect(localStorage.getItem(CAPTURE_DRAFT_KEY)).toBe("first thought, edited");
    fireEvent.click(screen.getByText("Set up a graph"));
    expect(onSetUpGraph).toHaveBeenCalledTimes(1);
  });

  it("restores a kept draft once there is a graph, and clears it after saving", async () => {
    localStorage.setItem(CAPTURE_DRAFT_KEY, "kept from before");
    const submit = vi.fn(async () => ({ pageId: "p" }));
    render(() => <CaptureView submit={submit} />);
    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("kept from before");
    fireEvent.click(screen.getByText("Save to journal"));
    await screen.findByText("Saved to today's journal.");
    expect(localStorage.getItem(CAPTURE_DRAFT_KEY)).toBeNull();
  });

  it("a new prefill does not overwrite a kept draft: both are kept", () => {
    localStorage.setItem(CAPTURE_DRAFT_KEY, "older");
    render(() => <CaptureView initialText="newer" />);
    const textarea = screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("older\nnewer");
  });
});
