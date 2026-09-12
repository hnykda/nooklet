/**
 * `/trash` — what has been deleted and can come back (M7 item 8, ADR 022). One row per delete
 * action: a page with the blocks that went with it, or a block subtree on a live page. Restore is
 * one click, no confirmation: it is the un-destructive direction, and the restore is itself an
 * undoable batch. Nothing here expires, and the page says so, because the old tool descriptions
 * once promised a 30-day window that did not exist (docs/BUGS.md B-56).
 *
 * Read from the server (`../data/history.ts`), not the local replica: who deleted something lives
 * in the `changes` audit log, which only the server has.
 */

import { A } from "@solidjs/router";
import { createSignal, For, type JSX, Show } from "solid-js";
import { restoreFromTrash, type TrashItem, useTrash } from "../data/history.js";
import { displayRefName } from "../data/page-title.js";
import { formatWhen } from "./historyText.js";
import { pageRoutePath } from "./navigateTarget.js";
import "./trash.css";

export function TrashView(): JSX.Element {
  const [items, { refetch }] = useTrash();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<{ text: string; page: string } | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function restore(item: TrashItem): Promise<void> {
    setBusy(item.id);
    setError(null);
    try {
      const result = await restoreFromTrash(item.id);
      const what =
        item.kind === "page"
          ? `Restored "${displayRefName(item.title)}"`
          : `Restored the block "${item.title || "(empty)"}"`;
      const n = result.restored.length - 1;
      setNotice({
        text: n > 0 ? `${what} and ${n} block${n === 1 ? "" : "s"} with it.` : `${what}.`,
        page: result.page,
      });
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const count = () => items()?.length ?? 0;

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
          Could not load the trash: {String((items.error as Error).message ?? items.error)}{" "}
          <button type="button" class="trash-retry" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      </Show>

      <Show when={items.loading && items() === undefined}>
        <p class="trash-empty">Loading…</p>
      </Show>

      <Show when={items() && count() === 0}>
        <p class="trash-empty">The trash is empty.</p>
      </Show>

      <ul class="trash-list">
        <For each={items()}>
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
