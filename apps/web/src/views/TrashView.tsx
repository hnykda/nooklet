/**
 * `/trash` — what has been deleted and can come back (M7 item 8, ADR 022). One row per delete
 * action: a page with the blocks that went with it, or a block subtree on a live page. Restore is
 * one click, no confirmation: it is the un-destructive direction, and the restore is itself an
 * undoable batch. Nothing here expires, and the page says so, because the old tool descriptions
 * once promised a 30-day window that did not exist (docs/BUGS.md B-56).
 *
 * Read from the server (`../data/history.ts`), not the local replica: who deleted something lives
 * in the `changes` audit log, which only the server has.
 *
 * A page restore the server refuses with `conflict` — its name is taken — opens
 * `TrashRenameForm` on that row instead of ending in an error line (B-255).
 */

import { A } from "@solidjs/router";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { ApiError, describeError } from "../data/api-client.js";
import { restoreFromTrash, type TrashItem, useTrash } from "../data/history.js";
import { displayRefName } from "../data/page-title.js";
import { formatWhen } from "./historyText.js";
import { pageRoutePath } from "./navigateTarget.js";
import { suggestedRestoreName, TrashRenameForm } from "./TrashRenameForm.js";
import "./trash.css";

export function TrashView(): JSX.Element {
  const [items, { refetch }] = useTrash();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<{ text: string; page: string } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** The row whose restore was refused for its name, and why. */
  const [conflict, setConflict] = createSignal<{ id: string; reason: string } | null>(null);
  // The name in the rename form lives here, not in the form: see `TrashRenameForm.tsx`.
  const [renameTo, setRenameTo] = createSignal("");
  const [selectName, setSelectName] = createSignal(false);

  async function restore(item: TrashItem, newName?: string): Promise<void> {
    setBusy(item.id);
    setError(null);
    try {
      const result = await restoreFromTrash(item.id, newName);
      setConflict(null);
      const what =
        item.kind === "page"
          ? `Restored "${displayRefName(newName ?? item.title)}"`
          : `Restored the block "${item.title || "(empty)"}"`;
      const n = result.restored.length - 1;
      setNotice({
        text: n > 0 ? `${what} and ${n} block${n === 1 ? "" : "s"} with it.` : `${what}.`,
        page: result.page,
      });
      refetch();
    } catch (err) {
      if (item.kind === "page" && err instanceof ApiError && err.code === "conflict") {
        setConflict({ id: item.id, reason: err.message });
        if (newName === undefined) {
          setRenameTo(suggestedRestoreName(item.title));
          setSelectName(true);
        }
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(null);
    }
  }

  // Reading an errored resource re-throws (B-10/B-80's lesson): an unguarded `items()` in the count
  // or a `when` threw inside render, so a failed load stayed on "Loading…" and the error line below
  // never showed (B-131). Every read goes through this.
  const list = (): TrashItem[] | undefined => (items.error !== undefined ? undefined : items());
  const count = () => list()?.length ?? 0;

  // The list refetches on every graph change and each fetch builds new objects, and `<For>` is
  // keyed by reference — so without this every row, and an open rename form with it, was torn
  // down and rebuilt whenever anything anywhere was edited. An unchanged item keeps its object.
  let previous = new Map<string, TrashItem>();
  const rows = createMemo((): TrashItem[] => {
    const next = items.error === undefined ? (items() ?? []) : [];
    const kept = new Map<string, TrashItem>();
    const out = next.map((item) => {
      const old = previous.get(item.id);
      const same =
        old !== undefined &&
        old.title === item.title &&
        old.page === item.page &&
        old.blockCount === item.blockCount &&
        old.deletedAt === item.deletedAt &&
        old.deletedBy?.batchId === item.deletedBy?.batchId;
      const chosen = same ? old : item;
      kept.set(item.id, chosen);
      return chosen;
    });
    previous = kept;
    return out;
  });

  return (
    <div class="trash-view">
      <header class="trash-header">
        <h1>
          Trash <span class="trash-count">{count()}</span>
        </h1>
        <p class="trash-note">
          Deleted pages and blocks stay here until you restore them. Nothing expires.
        </p>
      </header>

      <Show when={notice()}>
        {(n) => (
          <p class="trash-notice" role="status">
            {n().text}{" "}
            <A href={pageRoutePath(n().page)} class="trash-notice-link">
              Open {displayRefName(n().page)}
            </A>
          </p>
        )}
      </Show>

      <Show when={error()}>
        {(e) => (
          <p class="trash-error" role="alert">
            Could not restore: {e()}
          </p>
        )}
      </Show>

      <Show when={items.error}>
        <p class="trash-error" role="alert">
          Could not load the trash: {describeError(items.error)}{" "}
          <button type="button" class="trash-retry" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      </Show>

      <Show when={items.loading && list() === undefined}>
        <p class="trash-empty">Loading…</p>
      </Show>

      <Show when={list() && count() === 0}>
        <p class="trash-empty">The trash is empty.</p>
      </Show>

      <ul class="trash-list">
        <For each={rows()}>
          {(item) => (
            <li class={`trash-row trash-row-${item.kind}`} data-id={item.id}>
              <span class="trash-kind">{item.kind}</span>
              <div class="trash-main">
                <div class="trash-title">
                  {item.kind === "page" ? displayRefName(item.title) : item.title || "(empty)"}
                </div>
                <div class="trash-meta">
                  <Show when={item.kind === "block"}>
                    on{" "}
                    <A href={pageRoutePath(item.page)} class="trash-page-link">
                      {displayRefName(item.page)}
                    </A>
                    {" · "}
                  </Show>
                  {item.blockCount} block{item.blockCount === 1 ? "" : "s"}
                  {" · deleted "}
                  <time dateTime={item.deletedAt}>{formatWhen(item.deletedAt)}</time>
                  <Show when={item.deletedBy}>
                    {(by) => (
                      <>
                        {" by "}
                        <span class="trash-actor">{by().actor}</span>
                        <span class="trash-origin">{by().origin}</span>
                      </>
                    )}
                  </Show>
                </div>
                <Show when={conflict()?.id === item.id}>
                  <TrashRenameForm
                    reason={conflict()?.reason ?? ""}
                    name={renameTo()}
                    onName={(name) => {
                      setRenameTo(name);
                      setSelectName(false);
                    }}
                    busy={busy() === item.id}
                    selectOnMount={selectName()}
                    onRestore={(name) => void restore(item, name)}
                    onCancel={() => setConflict(null)}
                  />
                </Show>
              </div>
              <button
                type="button"
                class="trash-restore"
                disabled={busy() !== null}
                onClick={() => void restore(item)}
              >
                {busy() === item.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
