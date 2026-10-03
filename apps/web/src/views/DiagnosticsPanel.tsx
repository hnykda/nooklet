/**
 * "Is this thing actually working?"
 *
 * Exists because every backend failure so far has been invisible: a missing API token rendered as
 * a permanent "Searching…", an unloadable `sqlite-vec` silently downgraded hybrid search to
 * keyword, sync flapped between states with no way to see why, and an embedding backlog looked
 * exactly like semantic search just not finding much. Each of those cost a round of "it's broken"
 * → "it works for me" before anyone could see the actual state.
 *
 * Local state (token, sync) comes from the client; backend state comes from `system.diagnostics`.
 * Opened by clicking the sync indicator in the top bar (`shell/AppShell.tsx#SyncIndicator`), or
 * from Settings → About → "Open diagnostics". There is no palette command for it.
 */

import { createResource, createSignal, type JSX, Show } from "solid-js";
import {
  clearFocusLog,
  focusLogCount,
  focusLogEnabled,
  focusLogText,
  setFocusLogEnabled,
} from "../app/focus-log.js";
import { callOp, describeError } from "../data/api-client.js";
import { apiBaseUrl, bootstrapConfig, hasSyncTarget } from "../data/bootstrap.js";
import { useSyncStatus } from "../data/store.js";
import "./diagnostics.css";

interface Diagnostics {
  graph: { pages: number; blocks: number; ops: number; seq: number };
  search: { fts: boolean; indexed_blocks: number };
  embeddings: {
    sqlite_vec: { loaded: boolean; version: string | null };
    model: string | null;
    dimensions: number | null;
    indexed: number;
    pending: number;
  };
}

function fetchDiagnostics(): Promise<Diagnostics> {
  return callOp<Diagnostics>("system.diagnostics", {});
}

function Row(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="diag-row">
      <span class="diag-label">{props.label}</span>
      <span class="diag-value">{props.children}</span>
    </div>
  );
}

function Status(props: { ok: boolean; children: JSX.Element }): JSX.Element {
  return (
    <span class={props.ok ? "diag-ok" : "diag-bad"}>
      {props.ok ? "●" : "▲"} {props.children}
    </span>
  );
}

export function DiagnosticsPanel(props: { onClose: () => void }): JSX.Element {
  const sync = useSyncStatus();
  // B-571: a device with no sync target has nothing to reach at all — `system.diagnostics` would
  // just fail with a network error every time, which is not the same thing as a real backend
  // problem. Source-gated so the fetch never fires rather than firing a doomed request and
  // softening its error after the fact.
  const target = hasSyncTarget();
  const [backend, { refetch }] = createResource(
    () => (target ? true : undefined),
    fetchDiagnostics,
  );
  const config = bootstrapConfig();
  // Reading an errored resource re-throws, so every read goes through this.
  const data = () => (backend.error !== undefined ? undefined : backend());

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss only; the keyboard way out is the dialog's Close <button>.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above — there is no Escape handler for this panel, the Close button is the keyboard path.
    <div class="diag-backdrop" onClick={props.onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation so a click inside the dialog never reaches the dismissing backdrop. */}
      <div
        class="diag-panel"
        role="dialog"
        aria-label="Diagnostics"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="diag-header">
          <h2>Diagnostics</h2>
          <button type="button" class="diag-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <section>
          <h3>This device</h3>
          <Row label="Server">
            <code>{apiBaseUrl() || location.origin}</code>
          </Row>
          <Row label="Credentials">
            <Show
              when={config.token}
              fallback={<Status ok={false}>no token ({config.reason ?? "unknown"})</Status>}
            >
              <Status ok={true}>token present</Status>
            </Show>
          </Row>
          <Row label="Sync">
            <Show
              when={target}
              fallback={<Status ok={true}>local only — not configured to sync</Status>}
            >
              <Show when={sync()} fallback={<span class="diag-muted">starting…</span>}>
                {(s) => (
                  <Status ok={s().state !== "offline" && s().state !== "error"}>
                    {s().state}
                    {s().pendingCount > 0 ? ` · ${s().pendingCount} queued` : ""}
                    {s().lastError ? ` · ${s().lastError}` : ""}
                  </Status>
                )}
              </Show>
            </Show>
          </Row>
        </section>

        <section>
          <h3>Backend</h3>
          <Show when={!target}>
            <p class="diag-muted">
              This device isn't configured to sync, so there's no server to check.
            </p>
          </Show>
          <Show when={target && backend.loading && data() === undefined}>
            <p class="diag-muted">Checking…</p>
          </Show>
          <Show when={target && backend.error !== undefined}>
            <p class="diag-bad" role="alert">
              Could not reach the API: {describeError(backend.error)}
            </p>
          </Show>
          <Show when={data()}>
            {(d) => (
              <>
                <Row label="Graph">
                  {d().graph.pages} pages · {d().graph.blocks} blocks · {d().graph.ops} ops
                </Row>
                <Row label="Full-text search">
                  <Status ok={d().search.fts}>
                    {d().search.fts
                      ? `${d().search.indexed_blocks} blocks indexed`
                      : "index missing"}
                  </Status>
                </Row>
                <Row label="Vector search">
                  <Status ok={d().embeddings.sqlite_vec.loaded}>
                    {d().embeddings.sqlite_vec.loaded
                      ? `sqlite-vec ${d().embeddings.sqlite_vec.version ?? "?"}`
                      : "not loaded — semantic search falls back to keyword"}
                  </Status>
                </Row>
                <Row label="Embedding model">
                  <Show
                    when={d().embeddings.model}
                    fallback={<span class="diag-muted">none configured</span>}
                  >
                    {d().embeddings.model} ({d().embeddings.dimensions}d)
                  </Show>
                </Row>
                <Row label="Embedding backlog">
                  <Status ok={d().embeddings.pending === 0}>
                    {d().embeddings.indexed} indexed · {d().embeddings.pending} pending
                  </Status>
                </Row>
              </>
            )}
          </Show>
          <Show when={target}>
            <button type="button" class="diag-refresh" onClick={() => refetch()}>
              Refresh
            </button>
          </Show>
        </section>

        <FocusLogSection />
      </div>
    </div>
  );
}

/**
 * The focus log (`../app/focus-log.ts`): switch it on here, go and lose focus, come back and copy
 * the log. Here and not behind a console command because the desktop app ships without a web
 * inspector, and the desktop app is where the focus bug it exists for happens (B-42).
 */
function FocusLogSection(): JSX.Element {
  // Read when asked for, not live: the log grows on every focus event, including the ones this
  // panel causes, and re-rendering a few megabytes of text on each would be its own bug.
  const [shown, setShown] = createSignal<string | null>(null);
  const [copyState, setCopyState] = createSignal<string>("");
  let textarea: HTMLTextAreaElement | undefined;

  async function copy(): Promise<void> {
    const text = focusLogText();
    setShown(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("Copied");
    } catch {
      // No clipboard permission (or no API): the text is in the box below, selected, for Cmd+C.
      textarea?.focus();
      textarea?.select();
      setCopyState("Select all in the box below and copy");
    }
  }

  return (
    <section class="diag-focus-log">
      <h3>Focus log</h3>
      <p class="diag-muted">
        Records where keyboard focus goes — for editor focus that disappears while you type. No text
        you type is recorded. It keeps recording across reloads until you switch it off.
      </p>
      <label class="diag-toggle">
        <input
          type="checkbox"
          checked={focusLogEnabled()}
          onChange={(e) => setFocusLogEnabled(e.currentTarget.checked)}
        />
        Record focus changes
      </label>
      <Row label="Entries">{focusLogCount()}</Row>
      <div class="diag-actions">
        <button type="button" class="diag-refresh" onClick={() => void copy()}>
          Copy log
        </button>
        <button type="button" class="diag-refresh" onClick={() => setShown(focusLogText())}>
          Show log
        </button>
        <button
          type="button"
          class="diag-refresh"
          onClick={() => {
            clearFocusLog();
            setShown(null);
            setCopyState("");
          }}
        >
          Clear
        </button>
        <Show when={copyState()}>
          <span class="diag-muted" role="status">
            {copyState()}
          </span>
        </Show>
      </div>
      <Show when={shown()}>
        {(text) => (
          <textarea
            ref={textarea}
            class="diag-log"
            readOnly
            rows={12}
            aria-label="Focus log"
            value={text()}
          />
        )}
      </Show>
    </section>
  );
}

/** Module-level open/close, so any surface (sidebar button, command) can raise it. */
const [open, setOpen] = createSignal(false);
export const diagnosticsOpen = open;
export function openDiagnostics(): void {
  setOpen(true);
}
export function closeDiagnostics(): void {
  setOpen(false);
}
