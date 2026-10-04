/**
 * Settings → Import from Logseq (ADR 031): bring a Logseq graph in without a terminal.
 *
 * Pick the graph folder (desktop and web) or a .zip of it (anywhere, and the only way on a phone,
 * whose Files app can pick a zip but not a folder), choose where it goes, watch it arrive, open it.
 * The server does the work (`../data/logseq-import.ts`); this is the screen around it.
 *
 * Shown to every session that has a server, so the owner always finds it. A session that cannot
 * import says why: a phone's paired token is not `admin`, and a "Just this device" graph has no
 * server for the importer to run on.
 */

import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import { graphEntryUrl, samePathGraphPrefix } from "../data/bootstrap.js";
import {
  cancelImport,
  FINISHED_STATES,
  folderSource,
  graphIdFromName,
  type ImportInfo,
  type ImportJob,
  type ImportSource,
  importAvailability,
  importStatus,
  rememberImportedGraph,
  uploadImport,
  zipSource,
} from "../data/logseq-import.js";
import { platform } from "../platform/index.js";
import "./import.css";

const MB = 1024 * 1024;

function size(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return bytes >= 10 * MB ? `${Math.round(bytes / MB)} MB` : `${(bytes / MB).toFixed(1)} MB`;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function ImportSection(props: { onClose: () => void }): JSX.Element {
  const [availability, { refetch }] = createResource(importAvailability);
  return (
    <section id="set-import" aria-label="Import from Logseq" class="imp">
      <h3>Import from Logseq</h3>
      <Show when={availability()} fallback={<p class="set-note">Checking…</p>}>
        {(a) => {
          const v = a();
          if (v.kind === "local-only") {
            return (
              <p class="set-note">
                This graph lives only on this device, and importing runs on a server. Import the
                graph on your nooklet server (the desktop app has one built in), then add that graph
                here from the graph menu; it syncs down with everything in it.
              </p>
            );
          }
          if (v.kind === "not-admin") {
            return (
              <p class="set-note">
                Importing needs this device to be signed in as the server's owner. Import from the
                desktop app or a browser on the server's own computer; this device sees the new
                graph once you add it.
              </p>
            );
          }
          if (v.kind === "unavailable") {
            return (
              <p class="set-note">
                This server cannot import from the app. On the server, run{" "}
                <code>nooklet import &lt;graph folder&gt;</code>.
              </p>
            );
          }
          if (v.kind === "error") {
            return (
              <p class="set-error" role="alert">
                Could not check whether this server can import: {v.message}
              </p>
            );
          }
          return <Importer info={v.info} onClose={props.onClose} onReset={() => void refetch()} />;
        }}
      </Show>
    </section>
  );
}

type Stage =
  | { kind: "choose" }
  | { kind: "running"; jobId?: string; uploaded: number; total: number; job?: ImportJob }
  | { kind: "finished"; job: ImportJob };

function Importer(props: {
  info: ImportInfo;
  onClose: () => void;
  onReset: () => void;
}): JSX.Element {
  const [source, setSource] = createSignal<ImportSource | null>(null);
  const [target, setTarget] = createSignal<"new" | "current">("new");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const active = props.info.active;
  const [stage, setStage] = createSignal<Stage>(
    active
      ? {
          kind: "running",
          jobId: active.job_id,
          uploaded: active.bytes_received,
          total: active.byte_size ?? active.bytes_received,
          job: active,
        }
      : { kind: "choose" },
  );
  let abort = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(poll));
  if (active && active.state !== "uploading") startPolling(active.job_id);

  // A phone's Files app picks a zip, not a folder; WKWebView on iOS has no folder picker.
  const canPickFolder = platform.name !== "capacitor";
  const graphId = () => graphIdFromName(name());
  const tooBig = () => (source()?.bytes ?? 0) > props.info.max_upload_bytes;

  function pickFolder(files: FileList | null): void {
    setError(null);
    if (!files || files.length === 0) return;
    const picked = folderSource([...files]);
    if ("error" in picked) {
      setSource(null);
      setError(picked.error);
      return;
    }
    setSource(picked);
    if (!name()) setName(picked.name);
  }

  function pickZip(files: FileList | null): void {
    setError(null);
    const file = files?.[0];
    if (!file) return;
    const picked = zipSource(file);
    setSource(picked);
    if (!name()) setName(picked.name);
  }

  function startPolling(jobId: string): void {
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const job = await importStatus(jobId);
        if (FINISHED_STATES.has(job.state)) {
          clearInterval(poll);
          setStage({ kind: "finished", job });
        } else {
          setStage((s) => (s.kind === "running" ? { ...s, job } : s));
        }
      } catch (err) {
        clearInterval(poll);
        setError(`Lost track of the import: ${describeError(err)}`);
      }
    }, 700);
  }

  async function run(e: Event): Promise<void> {
    e.preventDefault();
    const src = source();
    if (!src) return;
    setError(null);
    abort = new AbortController();
    setStage({ kind: "running", uploaded: 0, total: src.bytes });
    try {
      const job = await uploadImport({
        source: src,
        target:
          target() === "new"
            ? { kind: "new", graphId: graphId(), label: name().trim() || graphId() }
            : { kind: "current" },
        chunkBytes: props.info.chunk_bytes,
        signal: abort.signal,
        onJob: (jobId) => setStage((s) => (s.kind === "running" ? { ...s, jobId } : s)),
        onUploaded: (uploaded) =>
          setStage((s) =>
            s.kind === "running" ? { ...s, uploaded, total: Math.max(s.total, uploaded) } : s,
          ),
      });
      setStage((s) => (s.kind === "running" ? { ...s, job } : s));
      startPolling(job.job_id);
    } catch (err) {
      const s = stage();
      if (s.kind === "running" && s.jobId) {
        // The server may have the job half-uploaded; let it go rather than wait for the reaper.
        await cancelImport(s.jobId).catch(() => undefined);
      }
      setStage({ kind: "choose" });
      if (!abort.signal.aborted) setError(describeError(err));
    }
  }

  async function cancel(): Promise<void> {
    const s = stage();
    abort.abort();
    if (s.kind !== "running" || !s.jobId) {
      setStage({ kind: "choose" });
      return;
    }
    try {
      const job = await cancelImport(s.jobId);
      if (FINISHED_STATES.has(job.state)) {
        clearInterval(poll);
        setStage({ kind: "finished", job });
      } else startPolling(s.jobId);
    } catch (err) {
      setError(`Could not cancel: ${describeError(err)}`);
    }
  }

  function openGraph(job: ImportJob): void {
    if (job.graph) {
      const entry = rememberImportedGraph(job.graph);
      location.assign(graphEntryUrl(entry, location));
      return;
    }
    // Into this graph: it is already here and syncing; show it from the top.
    props.onClose();
    location.assign(`${samePathGraphPrefix() ?? ""}/pages`);
  }

  function again(): void {
    setSource(null);
    setName("");
    setError(null);
    setStage({ kind: "choose" });
    props.onReset();
  }

  return (
    <>
      <Show when={stage().kind === "choose"}>
        <form class="imp-form" onSubmit={(e) => void run(e)}>
          <p class="set-note imp-lede">
            Bring in a Logseq graph: its pages, journals, images and settings. Your Logseq folder is
            only read, never changed.
          </p>
          <div class="imp-pick">
            <Show when={canPickFolder}>
              <label class="set-button imp-pick-button">
                Choose graph folder…
                <input
                  type="file"
                  class="imp-file"
                  data-testid="import-folder-input"
                  // Non-standard but in every engine nooklet runs on; not in Solid's JSX types.
                  ref={(el) => el.setAttribute("webkitdirectory", "")}
                  multiple
                  onChange={(e) => pickFolder(e.currentTarget.files)}
                />
              </label>
            </Show>
            <label class="set-button imp-pick-button">
              Choose .zip…
              <input
                type="file"
                class="imp-file"
                data-testid="import-zip-input"
                accept=".zip,application/zip"
                onChange={(e) => pickZip(e.currentTarget.files)}
              />
            </label>
          </div>
          <Show when={source()}>
            {(src) => (
              <p class="imp-picked" data-testid="import-picked">
                <strong>{src().name}</strong>{" "}
                <span class="set-muted">
                  {src().kind === "folder"
                    ? `${count((src() as { pages: number }).pages, "page", "pages")}, ${count((src() as { journals: number }).journals, "journal", "journals")}, ${count((src() as { assets: number }).assets, "file", "files")} in assets, ${size(src().bytes)}`
                    : `zip, ${size(src().bytes)}`}
                </span>
              </p>
            )}
          </Show>
          <Show when={tooBig()}>
            <p class="set-error" role="alert">
              That is {size(source()?.bytes ?? 0)}; this server takes up to{" "}
              {size(props.info.max_upload_bytes)}. Start the server with a larger{" "}
              <code>--import-max-mb</code>, or import on the server with <code>nooklet import</code>
              .
            </p>
          </Show>

          <fieldset class="imp-targets">
            <legend class="set-muted">Import into</legend>
            <label class="imp-target">
              <input
                type="radio"
                name="imp-target"
                value="new"
                checked={target() === "new"}
                onChange={() => setTarget("new")}
              />
              <span>A new graph</span>
            </label>
            <Show when={target() === "new"}>
              <label class="imp-name">
                <span class="set-muted">Name</span>
                <input
                  type="text"
                  data-testid="import-graph-name"
                  autocomplete="off"
                  spellcheck={false}
                  value={name()}
                  placeholder="My Logseq notes"
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </label>
              <p class="set-note imp-address">
                <Show
                  when={graphId()}
                  fallback="Give the graph a name with a letter or digit in it."
                >
                  Its address on this server: <code>/g/{graphId()}</code>
                </Show>
              </p>
            </Show>
            <label class="imp-target">
              <input
                type="radio"
                name="imp-target"
                value="current"
                disabled={!props.info.current_graph.empty}
                checked={target() === "current"}
                onChange={() => setTarget("current")}
              />
              <span>
                This graph
                <span class="set-muted">
                  {props.info.current_graph.empty
                    ? " (it is empty)"
                    : " (only possible while it is empty; this one has notes)"}
                </span>
              </span>
            </label>
          </fieldset>

          <Show when={error()}>
            {(m) => (
              <p class="set-error" role="alert">
                {m()}
              </p>
            )}
          </Show>
          <div class="set-actions">
            <button
              type="submit"
              class="set-button set-button-primary"
              data-testid="import-run"
              disabled={!source() || tooBig() || (target() === "new" && !graphId())}
            >
              Import
            </button>
          </div>
          <p class="set-note">
            From a terminal instead: <code>nooklet import &lt;graph folder&gt;</code>.
          </p>
        </form>
      </Show>

      <Show
        when={stage().kind === "running" ? (stage() as Extract<Stage, { kind: "running" }>) : null}
      >
        {(s) => (
          <div class="imp-run" data-testid="import-progress" aria-live="polite">
            <Steps state={s().job?.state ?? "uploading"} />
            <p class="imp-status">{statusLine(s())}</p>
            <Tally job={s().job} />
            <Show when={error()}>
              {(m) => (
                <p class="set-error" role="alert">
                  {m()}
                </p>
              )}
            </Show>
            <div class="set-actions">
              <button type="button" class="set-button" onClick={() => void cancel()}>
                Cancel import
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show
        when={
          stage().kind === "finished" ? (stage() as Extract<Stage, { kind: "finished" }>).job : null
        }
      >
        {(job) => <Summary job={job()} onOpen={() => openGraph(job())} onAgain={again} />}
      </Show>
    </>
  );
}

const STEPS: Array<{ label: string; states: ImportJob["state"][] }> = [
  { label: "Upload", states: ["uploading"] },
  { label: "Unpack", states: ["extracting"] },
  { label: "Import", states: ["importing"] },
  { label: "Check", states: ["verifying"] },
];

/** Upload, unpack, import, check: a real sequence, so it is shown as one. */
function Steps(props: { state: ImportJob["state"] }): JSX.Element {
  const at = () => STEPS.findIndex((s) => s.states.includes(props.state));
  return (
    <ol class="imp-steps">
      <For each={STEPS}>
        {(step, i) => (
          <li
            class="imp-step"
            classList={{ "imp-step-done": i() < at(), "imp-step-now": i() === at() }}
            aria-current={i() === at() ? "step" : undefined}
          >
            {step.label}
          </li>
        )}
      </For>
    </ol>
  );
}

function statusLine(s: Extract<Stage, { kind: "running" }>): string {
  const job = s.job;
  if (!job || job.state === "uploading") {
    return s.total > 0
      ? `Sending ${size(s.uploaded)} of about ${size(s.total)}`
      : "Preparing the upload…";
  }
  if (job.state === "extracting") {
    return job.unpacked.total > 0
      ? `Unpacking ${job.unpacked.done.toLocaleString()} of ${job.unpacked.total.toLocaleString()} files`
      : "Unpacking…";
  }
  if (job.state === "verifying") return "Checking the imported graph…";
  const p = job.progress;
  if (p.phase === "reading")
    return `Reading ${p.filesRead.toLocaleString()} of ${p.filesTotal.toLocaleString()} files`;
  if (p.phase === "assets")
    return `Copying ${p.assetsDone.toLocaleString()} of ${p.assetsTotal.toLocaleString()} assets`;
  if (p.phase === "pages")
    return `Importing page ${p.pagesDone.toLocaleString()} of ${p.filesTotal.toLocaleString()}`;
  return "Linking references…";
}

/** The four numbers the owner is waiting to see, counting up as they land. */
function Tally(props: { job?: ImportJob }): JSX.Element {
  const p = () => props.job?.progress;
  const r = () => props.job?.result;
  const cells = () => [
    { label: "pages", n: r()?.pages ?? p()?.pagesImported ?? 0 },
    { label: "journals", n: r()?.journals ?? p()?.journalsImported ?? 0 },
    { label: "blocks", n: r()?.blocks ?? p()?.blocksImported ?? 0 },
    { label: "assets", n: r()?.assets ?? p()?.assetsImported ?? 0 },
  ];
  return (
    <dl class="imp-tally" data-testid="import-tally">
      <For each={cells()}>
        {(c) => (
          <div class="imp-tally-cell">
            <dd data-testid={`import-count-${c.label}`}>{c.n.toLocaleString()}</dd>
            <dt>{c.label}</dt>
          </div>
        )}
      </For>
    </dl>
  );
}

function Summary(props: { job: ImportJob; onOpen: () => void; onAgain: () => void }): JSX.Element {
  const job = () => props.job;
  const r = () => job().result;
  const notes = (): string[] => {
    const res = r();
    if (!res) return [];
    const out: string[] = [];
    if (res.format === "db")
      out.push("Read as a Logseq DB-version graph (db.sqlite and its Markdown Mirror).");
    if (res.favorites > 0)
      out.push(`${count(res.favorites, "favourite was", "favourites were")} kept.`);
    if (res.referenced_pages > 0)
      out.push(
        `${count(res.referenced_pages, "page was", "pages were")} created because other pages link to ${res.referenced_pages === 1 ? "it" : "them"}.`,
      );
    if (res.dangling_block_refs > 0)
      out.push(
        `${count(res.dangling_block_refs, "block reference points", "block references point")} at a block that is not in the graph; ${res.dangling_block_refs === 1 ? "it was" : "they were"} kept as written.`,
      );
    if (res.dangling_asset_links > 0)
      out.push(
        `${count(res.dangling_asset_links, "link points", "links point")} at a file missing from assets/.`,
      );
    if (res.pages_skipped > 0)
      out.push(
        `${count(res.pages_skipped, "file was", "files were")} not imported; see the details below.`,
      );
    return out;
  };
  return (
    <div class="imp-done" data-testid="import-summary">
      <Show
        when={job().state === "done"}
        fallback={
          <p
            class={job().state === "cancelled" ? "set-note" : "set-error"}
            role="alert"
            data-testid="import-failed"
          >
            {job().state === "cancelled"
              ? (job().message ?? "Import cancelled. Nothing was created.")
              : (job().message ?? "The import failed.")}
          </p>
        }
      >
        <p class="imp-status set-ok" data-testid="import-done">
          Imported{job().graph ? ` into ${job().graph?.label}` : ""} in{" "}
          {Math.max(1, Math.round((r()?.duration_ms ?? 0) / 1000))} s, and checked.
        </p>
      </Show>
      <Show when={r()}>
        <Tally job={job()} />
        <Show when={notes().length > 0}>
          <ul class="imp-notes">
            <For each={notes()}>{(n) => <li>{n}</li>}</For>
          </ul>
        </Show>
        <Show when={(r()?.warnings_total ?? 0) + (r()?.errors_total ?? 0) > 0}>
          <details class="imp-details">
            <summary>
              {count((r()?.warnings_total ?? 0) + (r()?.errors_total ?? 0), "note", "notes")} from
              the importer
            </summary>
            <ul>
              <For each={[...(r()?.errors ?? []), ...(r()?.warnings ?? [])]}>
                {(w) => <li>{w}</li>}
              </For>
            </ul>
            <Show when={(r()?.warnings.length ?? 0) < (r()?.warnings_total ?? 0)}>
              <p class="set-note">Only the first {r()?.warnings.length} are listed.</p>
            </Show>
          </details>
        </Show>
      </Show>
      <div class="set-actions">
        <Show when={job().state === "done"}>
          <button
            type="button"
            class="set-button set-button-primary"
            data-testid="import-open"
            onClick={props.onOpen}
          >
            {job().graph ? `Open ${job().graph?.label}` : "Show the pages"}
          </button>
        </Show>
        <button type="button" class="set-button" onClick={props.onAgain}>
          {job().state === "done" ? "Import another" : "Try again"}
        </button>
      </div>
    </div>
  );
}
