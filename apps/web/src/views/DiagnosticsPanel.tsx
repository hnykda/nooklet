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
 * Opened from the sidebar, or with the `app.diagnostics` command.
 */

import { createResource, createSignal, type JSX, Show } from "solid-js";
import { callOp } from "../data/api-client.js";
import { apiBaseUrl, bootstrapConfig } from "../data/bootstrap.js";
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
  const [backend, { refetch }] = createResource(fetchDiagnostics);
  const config = bootstrapConfig();
  // Reading an errored resource re-throws, so every read goes through this.
  const data = () => (backend.error !== undefined ? undefined : backend());

  return (
    <div class="diag-backdrop" onClick={props.onClose}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop-dismiss; the dialog below stops propagation so a click inside never closes it. */}
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
            <Show when={sync()} fallback={<span class="diag-muted">starting…</span>}>
              {(s) => (
                <Status ok={s().state !== "offline" && s().state !== "error"}>
                  {s().state}
                  {s().pendingCount > 0 ? ` · ${s().pendingCount} queued` : ""}
                  {s().lastError ? ` · ${s().lastError}` : ""}
                </Status>
              )}
            </Show>
          </Row>
        </section>

        <section>
          <h3>Backend</h3>
          <Show when={backend.loading && data() === undefined}>
            <p class="diag-muted">Checking…</p>
          </Show>
          <Show when={backend.error !== undefined}>
            <p class="diag-bad" role="alert">
              Could not reach the API: {String(backend.error)}
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
          <button type="button" class="diag-refresh" onClick={() => refetch()}>
            Refresh
          </button>
        </section>
      </div>
    </div>
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
