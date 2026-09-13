/**
 * An ordinary page's editable title (B-350): a one-row `<textarea>` that grows to fit its value.
 *
 * It was an `<input>`, and an input cannot wrap. A name longer than the space left in the title
 * row was cut mid-word with nothing to say so — on a 390px phone "Deciding on a Bike" read
 * "Deciding on a", and at desktop width a 36-character name lost its end. Page names in a real
 * graph run long (`RPG on Harry Potter theme with Robin`, `hls__The_Logic_of_…`), so the title has
 * to be able to take a second line.
 *
 * A page name is still one line of text: Enter commits (it never inserts a break), and a pasted
 * line break becomes a space. The height is set from `scrollHeight` whenever the value or the
 * field's width changes, not with `field-sizing: content`, which the Mac app's WebKit does not
 * reliably have.
 */

import { createEffect, type JSX, onCleanup, onMount } from "solid-js";
import "./page-title.css";

export function PageTitleField(props: {
  value: string;
  readOnly: boolean;
  onInput: (value: string) => void;
  onCommit: () => void;
}): JSX.Element {
  let el: HTMLTextAreaElement | undefined;

  const fit = (): void => {
    if (!el) return;
    // `auto` first: `scrollHeight` never reports less than the current height, so a title that
    // just got shorter would otherwise keep its old number of lines.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  createEffect(() => {
    // Tracked so a rename from elsewhere, or a reverted draft, re-measures too.
    void props.value;
    fit();
  });

  onMount(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    // The row narrows when the sidebar or shelf opens and widens on rotation; the same name then
    // needs a different number of lines. Only width matters — reacting to the height this sets
    // would loop — and the fit waits a frame, because resizing an observed element inside its own
    // callback is what raises "ResizeObserver loop completed with undelivered notifications".
    let width = -1;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? -1;
      if (next === width) return;
      width = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(el);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });

  return (
    <textarea
      ref={el}
      class="page-title-input"
      rows={1}
      value={props.value}
      onInput={(e) => {
        const raw = e.currentTarget.value;
        const oneLine = raw.replace(/[\r\n]+/g, " ");
        if (oneLine !== raw) e.currentTarget.value = oneLine;
        props.onInput(oneLine);
        fit();
      }}
      onBlur={() => props.onCommit()}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
      readOnly={props.readOnly}
      aria-label="Page title"
    />
  );
}
