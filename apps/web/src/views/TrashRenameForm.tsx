/**
 * The way out of a refused page restore (B-255). `trash.restore` answers `conflict` when a live
 * page already has the deleted page's name, and takes `new_name` to restore under another one.
 * The Trash view used to print the refusal and stop — the row stayed, and the only way forward
 * was to leave, rename or delete the other page, and come back. This form sits on the refused
 * row: the server's reason, a name to restore under (prefilled, since "X (restored)" is almost
 * always fine), and Cancel.
 *
 * The name is held by the view, not here: the trash list refetches whenever the graph changes,
 * and a row that is rebuilt rebuilds this form — with local state, text typed a moment earlier
 * would silently go back to the suggestion and be restored under a name nobody chose (the e2e
 * test hit exactly that).
 */

import { type JSX, onMount } from "solid-js";
import "./trash-rename.css";

export function suggestedRestoreName(title: string): string {
  return `${title} (restored)`;
}

export function TrashRenameForm(props: {
  /** Why the restore was refused, as the server said it. */
  reason: string;
  name: string;
  onName: (name: string) => void;
  busy: boolean;
  /** Select the whole name on mount — true only right after the refusal, not on a rebuild. */
  selectOnMount: boolean;
  onRestore: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  let input: HTMLInputElement | undefined;
  onMount(() => {
    input?.focus();
    if (props.selectOnMount) input?.select();
  });
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    const n = props.name.trim();
    if (n !== "" && !props.busy) props.onRestore(n);
  };
  return (
    <form class="trash-rename" onSubmit={submit}>
      <p class="trash-rename-reason" role="alert">
        {props.reason}. Restore it under another name:
      </p>
      <div class="trash-rename-row">
        <input
          ref={input}
          type="text"
          class="trash-rename-input"
          aria-label="Name to restore the page under"
          value={props.name}
          onInput={(e) => props.onName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onCancel();
          }}
        />
        <button
          type="submit"
          class="trash-rename-submit"
          disabled={props.busy || props.name.trim() === ""}
        >
          {props.busy ? "Restoring…" : "Restore under this name"}
        </button>
        <button type="button" class="trash-rename-cancel" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
