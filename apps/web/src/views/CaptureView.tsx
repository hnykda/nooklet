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
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { submitQuickCapture } from "../capture/quickCaptureService.js";
import { platform } from "../platform/index.js";
import "./capture.css";

export interface CaptureViewProps {
  /** Prefill from `/capture?text=…&url=…&title=…` (`../routes/CaptureRoute.tsx`): the PWA
   * `share_target`, and every `nooklet://capture` link (ADR 033). Only ever a prefill: nothing is
   * written until the person saves, because anything can open such a link. */
  initialText?: string;
  /** No graph on this device yet (a first launch): say so, keep the text as a draft that is
   * restored here once a graph exists, and offer the way to set one up instead of saving. */
  noGraph?: boolean;
  /** "Set up a graph" from the no-graph notice. */
  onSetUpGraph?: () => void;
  /** Cancel: the text is discarded and nothing is written. */
  onCancel?: () => void;
  /** Injectable for tests; defaults to the real local-write path. */
  submit?: (text: string) => Promise<{ pageId: string } | null>;
  /** Called after a successful save (tests, and a future "open journal" affordance hook). */
  onSaved?: (pageId: string) => void;
}

type Status = "idle" | "saving" | "saved" | "error";

/** Where the capture screen keeps text it could not save yet (no graph on this device). */
export const CAPTURE_DRAFT_KEY = "nooklet.captureDraft";

function readDraft(): string {
  try {
    return globalThis.localStorage?.getItem(CAPTURE_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(value: string): void {
  try {
    if (value.trim() === "") globalThis.localStorage?.removeItem(CAPTURE_DRAFT_KEY);
    else globalThis.localStorage?.setItem(CAPTURE_DRAFT_KEY, value);
  } catch {
    // Storage unavailable: the text is still on screen.
  }
}

/** A kept draft and a new prefill are both the person's text: neither replaces the other. */
function initialValue(prefill: string | undefined): string {
  const draft = readDraft();
  if (!prefill) return draft;
  if (draft.trim() === "" || draft.includes(prefill)) return draft || prefill;
  return `${draft}\n${prefill}`;
}

export function CaptureView(props: CaptureViewProps): JSX.Element {
  const [text, setText] = createSignal(initialValue(props.initialText));
  // A prefill that arrives while there is no graph must survive the app being closed.
  if (props.noGraph) writeDraft(text());
  const [status, setStatus] = createSignal<Status>("idle");
  let textareaEl: HTMLTextAreaElement | undefined;

  // B-802: this screen is mounted outside `AppShell`, which is what normally starts the keyboard
  // watcher. Without it `--kb` stays 0 in the iOS app (KeyboardResize.None), and the keyboard
  // covers the Save button.
  onMount(() => {
    const keyboard = platform.startKeyboardWatcher();
    onCleanup(() => keyboard.stop());
  });

  onMount(() => {
    // Tapping a shortcut/share-target/FAB is a real navigation, not a synchronous trusted event
    // in the sense research/08 §3.4 means, so this focus() is not guaranteed to raise the iOS
    // keyboard — "one tap is the floor" there. Free on Android/desktop, harmless everywhere.
    textareaEl?.focus();
  });

  async function save(): Promise<void> {
    const value = text();
    if (props.noGraph || value.trim() === "" || status() === "saving") return;
    setStatus("saving");
    try {
      const submit = props.submit ?? submitQuickCapture;
      const result = await submit(value);
      if (!result) {
        setStatus("idle");
        return;
      }
      setText("");
      writeDraft("");
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
      <Show when={props.noGraph}>
        <div class="capture-no-graph" role="status">
          <p>
            There's no graph on this device yet, so this can't be saved. Your text is kept here: set
            up a graph, and it will be waiting on this screen.
          </p>
          <button type="button" class="capture-save" onClick={() => props.onSetUpGraph?.()}>
            Set up a graph
          </button>
        </div>
      </Show>
      <textarea
        ref={textareaEl}
        class="capture-input"
        placeholder="Capture a thought…"
        autofocus
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          if (props.noGraph) writeDraft(e.currentTarget.value);
          if (status() !== "idle") setStatus("idle");
        }}
        onKeyDown={onKeyDown}
      />
      <div class="capture-actions">
        <Show when={!props.noGraph}>
          <button
            type="button"
            class="capture-save"
            disabled={text().trim() === "" || status() === "saving"}
            onClick={() => void save()}
          >
            {status() === "saving" ? "Saving…" : "Save to journal"}
          </button>
        </Show>
        <Show when={props.onCancel && text().trim() !== ""}>
          <button
            type="button"
            class="capture-cancel"
            onClick={() => {
              setText("");
              writeDraft("");
              props.onCancel?.();
            }}
          >
            Cancel
          </button>
        </Show>
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
