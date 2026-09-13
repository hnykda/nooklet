/**
 * The short notice a locked page (`./readOnly.ts`) shows when a click, key or gesture would have
 * edited it. A fixed toast rather than an inline line, so refusing a click does not shift the rows
 * under the pointer; one per `BlockTree`, shown only by the tree that refused.
 *
 * The same toast carries the tree's other refusals with their own text — a Backspace/Delete merge
 * that would have had to drop one of two values (B-340). One toast, so two refusals in a row
 * replace each other instead of stacking.
 */

import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { READ_ONLY_NOTICE } from "./readOnly.js";
import "./read-only.css";

const VISIBLE_MS = 3000;

export function createReadOnlyNotice(): {
  show: (text?: string) => void;
  View: () => JSX.Element;
} {
  const [visible, setVisible] = createSignal(false);
  const [message, setMessage] = createSignal(READ_ONLY_NOTICE);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return {
    show(text = READ_ONLY_NOTICE) {
      setMessage(text);
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), VISIBLE_MS);
    },
    View: () => (
      <Show when={visible()}>
        <p class="vr-readonly-notice" role="status">
          {message()}
        </p>
      </Show>
    ),
  };
}
