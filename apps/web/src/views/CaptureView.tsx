/**
 * The quick-capture UI (PLAN.md §14, research/08-mobile.md §4: "the #1 mobile use case"): a
 * deliberately minimal screen — one textarea, one save action — that appends text to today's
 * journal without ever fetching a page tree or mounting the outliner/command layer
 * (`../capture/quickCaptureService.ts`'s doc comment spells out the "without loading the graph"
 * requirement precisely).
 *
 * Mounted outside `AppShell`/`CommandLayer` (`../App.tsx`'s router root checks the path) so
 * opening `/capture` never pays for the palette/slash-menu/toolbar machinery or the editor's
 * CodeMirror surface — the "fast to open" requirement. It still goes through the exact same
 * local-write path (`../data/store.ts#applyOps`, via `submitQuickCapture`) as every other write,
 * so it works offline (ADR 005) for free — there is no separate "offline capture" code path.
 */
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { submitQuickCapture } from "../capture/quickCaptureService.js";
import "./capture.css";

export interface CaptureViewProps {
  /** Prefill from Android `share_target`/shortcut query params (`../routes/CaptureRoute.tsx`). */
  initialText?: string;
  /** Injectable for tests; defaults to the real local-write path. */
  submit?: (text: string) => Promise<{ pageId: string } | null>;
  /** Called after a successful save (tests, and a future "open journal" affordance hook). */
  onSaved?: (pageId: string) => void;
}

type Status = "idle" | "saving" | "saved" | "error";

export function CaptureView(props: CaptureViewProps): JSX.Element {
  const [text, setText] = createSignal(props.initialText ?? "");
  const [status, setStatus] = createSignal<Status>("idle");
  let textareaEl: HTMLTextAreaElement | undefined;

  onMount(() => {
    // Tapping a shortcut/share-target/FAB is a real navigation, not a synchronous trusted event
    // in the sense research/08 §3.4 means, so this focus() is not guaranteed to raise the iOS
    // keyboard — "one tap is the floor" there. Free on Android/desktop, harmless everywhere.
    textareaEl?.focus();
  });

  async function save(): Promise<void> {
    const value = text();
    if (value.trim() === "" || status() === "saving") return;
    setStatus("saving");
    try {
      const submit = props.submit ?? submitQuickCapture;
      const result = await submit(value);
      if (!result) {
        setStatus("idle");
        return;
      }
      setText("");
      setStatus("saved");
      props.onSaved?.(result.pageId);
      textareaEl?.focus();
    } catch {
      setStatus("error");
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <div class="capture-shell">
      <div class="capture-topbar">
        <span class="capture-title">Quick capture</span>
        <a class="capture-link" href="/journals">
          Journal
        </a>
      </div>
      <textarea
        ref={textareaEl}
        class="capture-input"
        placeholder="Capture a thought…"
        autofocus
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          if (status() !== "idle") setStatus("idle");
        }}
        onKeyDown={onKeyDown}
      />
      <div class="capture-actions">
        <button
          type="button"
          class="capture-save"
          disabled={text().trim() === "" || status() === "saving"}
          onClick={() => void save()}
        >
          {status() === "saving" ? "Saving…" : "Save to journal"}
        </button>
        {/* A visible, un-timed confirmation (BUILD item 3: "confirm the write visibly") — stays
            until the next edit/capture rather than auto-dismissing, so a quick glance after
            backgrounding the app still shows it worked. */}
        <Show when={status() === "saved"}>
          <span class="capture-confirm" role="status">
            Saved to today's journal.
          </span>
        </Show>
        <Show when={status() === "error"}>
          <span class="capture-error" role="alert">
            Could not save — try again.
          </span>
        </Show>
      </div>
    </div>
  );
}
