/**
 * Settings.
 *
 * Two things were broken and this fixes both. `app.openSettings` was a registered command with a
 * keybinding (Cmd/Ctrl+,) whose host implementation navigated to `/settings` — a route that does
 * not exist, so the shortcut opened a blank screen. And `system.diagnostics` reported
 * `"model": null` on every install, because the only way to register an embedding model was
 * `nooklet embed model <name>` at a terminal: multilingual semantic search, a headline feature,
 * silently degraded to keyword for everyone who never read the CLI help.
 *
 * So this panel's centre of gravity is the embeddings section, not the theme toggle. It is
 * deliberately explicit about the off state — semantic search being off is a fact worth stating,
 * not an absence to be inferred — and about the one case where it cannot be turned on at all
 * (`sqlite_vec.loaded === false`), where it offers no switch rather than a switch that does
 * nothing.
 *
 * Structure follows `./DiagnosticsPanel.tsx`: a modal over a dismissing backdrop, resources read
 * through a guard (reading an errored Solid resource re-throws), and a module-level open/close
 * signal at the bottom so any surface can raise it. Opened from the help menu (`shell/HelpMenu.tsx`)
 * and from the `app.openSettings` command.
 */

import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch as SolidSwitch,
} from "solid-js";
import { type ThemePreference, useTheme } from "../app/theme.js";
import { callOp, describeError } from "../data/api-client.js";
import {
  CONTENT_WIDTHS,
  contentWidth,
  customCss,
  setContentWidth,
  setCustomCss,
  setTextSize,
  TEXT_SIZES,
  textSize,
} from "../data/appearance.js";
import { apiBaseUrl, bootstrapConfig } from "../data/bootstrap.js";
import {
  journalTitleFormat,
  journalTitleOptions,
  setJournalTitleFormat,
} from "../data/page-title.js";
import { chooseTaskWorkflow, taskWorkflow } from "../data/task-workflow.js";
import { listTemplates, setJournalTemplate, type TemplateSummary } from "../data/templates.js";
import { DevicesSection } from "./DevicesSection.js";
import { openDiagnostics } from "./DiagnosticsPanel.js";
import { PluginsSection } from "./PluginsSection.js";
import { scrollSectionIntoView } from "./scroll-section.js";
import "./settings.css";

/** Injected at build time (`vite.config.ts`), same as `shell/HelpMenu.tsx`. */
const APP_VERSION: string = __APP_VERSION__;

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
/** Multilingual by design: this graph is half Czech, and an English-only model would quietly
 * answer worse on half of it (docs/research/06-embeddings.md §1.2). */
const DEFAULT_MODEL = "bge-m3";

interface ModelState {
  id: number;
  provider: string;
  model: string;
  dimensions: number;
  indexed: number;
  pending: number;
  errors: number;
}

interface EmbeddingsStatus {
  sqlite_vec: { loaded: boolean; version: string | null; error: string | null };
  configured: { provider: string; model: string; host: string };
  active: ModelState | null;
  switching_to: ModelState | null;
  queued: number;
  provider: {
    reachable: boolean | null;
    error: string | null;
    model_available: boolean | null;
    available_models: string[] | null;
  };
}

interface Diagnostics {
  storage?: { data_dir: string; graph_id: string };
}

function Row(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="set-row">
      <span class="set-label">{props.label}</span>
      <span class="set-value">{props.children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------------------------

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function AppearanceSection(): JSX.Element {
  const theme = useTheme();
  // `useTheme()` holds a plain module variable, not a signal, so the panel keeps its own copy to
  // render the selected state from. It is the only writer while it is open.
  const [pref, setPref] = createSignal<ThemePreference>(theme.get());

  return (
    <section>
      <h3>Appearance</h3>
      <Row label="Theme">
        {/* No `role="group"`: each button carries its own name and `aria-pressed`, and the row's
            own "Theme" label is what names the set. A `<fieldset>` would be the semantic wrapper
            but cannot live inside `Row`'s `<span>`. */}
        <div class="set-segmented">
          <For each={THEMES}>
            {(option) => (
              <button
                type="button"
                class="set-segment"
                aria-pressed={pref() === option.value}
                onClick={() => {
                  theme.set(option.value);
                  setPref(option.value);
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Row>
      <p class="set-note">“System” follows the OS and keeps following it. Stored per device.</p>

      {/* ADR 018: a journal page is stored under its ISO name (`2026-09-07`) and only *shown* in
          the reader's format. The value and its storage belong to `data/page-title.ts` — this is
          the picker over it, nothing more. */}
      <Row label="Journal date format">
        <select
          id="set-journal-format"
          value={journalTitleFormat()}
          onChange={(e) => setJournalTitleFormat(e.currentTarget.value)}
          aria-label="Journal date format"
        >
          <For each={journalTitleOptions()}>
            {(preset) => <option value={preset.pattern}>{preset.label}</option>}
          </For>
        </select>
      </Row>
      <p class="set-note">
        How journal days are titled on screen. The stored name stays the ISO date, so links, search
        and the markdown mirror are unaffected.
      </p>

      {/* M7 appearance basics (research/13 §4.2 item 6). Values and storage belong to
          `data/appearance.ts`; the tokens they move live in `styles/shell.css`. */}
      <Row label="Text size">
        <div class="set-segmented">
          <For each={TEXT_SIZES}>
            {(option) => (
              <button
                type="button"
                class="set-segment"
                aria-pressed={textSize() === option.value}
                onClick={() => setTextSize(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Row>
      <Row label="Content width">
        <div class="set-segmented">
          <For each={CONTENT_WIDTHS}>
            {(option) => (
              <button
                type="button"
                class="set-segment"
                aria-pressed={contentWidth() === option.value}
                onClick={() => setContentWidth(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Row>
      <p class="set-note">
        Reading sizes and the width of the page column. Stored per device, like the theme.
      </p>
      <label class="set-field set-field-block" for="set-custom-css">
        <span>Custom CSS</span>
        <textarea
          id="set-custom-css"
          rows={5}
          spellcheck={false}
          autocomplete="off"
          placeholder={".vr-outliner { font-family: Georgia, serif; }"}
          value={customCss()}
          onInput={(e) => setCustomCss(e.currentTarget.value)}
        />
      </label>
      <p class="set-note">
        Applied as you type, on this device only. Whatever you write here is yours to break — clear
        the box to undo it.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Search & embeddings
// ---------------------------------------------------------------------------------------------

/**
 * The provider form. Its own component so its fields are seeded once, from whatever the server
 * says is configured, at the moment it is opened — a parent-owned signal would either be stale or
 * would fight the user's typing every time the status resource refetched.
 */
function ProviderForm(props: {
  initial: EmbeddingsStatus["configured"];
  onSaved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [provider, setProvider] = createSignal(
    props.initial.provider === "openai-compat" ? "openai-compat" : "ollama",
  );
  const [host, setHost] = createSignal(props.initial.host || DEFAULT_OLLAMA_HOST);
  const [model, setModel] = createSignal(props.initial.model || DEFAULT_MODEL);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callOp("embeddings.configure", {
        provider: provider(),
        host: host().trim(),
        model: model().trim(),
      });
      props.onSaved();
    } catch (err) {
      // Whatever went wrong, it ends here as text on screen. The failure this replaces was a
      // button that stayed on "Testing…" forever.
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="set-form" onSubmit={(e) => void submit(e)}>
      <label class="set-field" for="set-provider">
        <span>Provider</span>
        <select
          id="set-provider"
          value={provider()}
          onChange={(e) => setProvider(e.currentTarget.value)}
        >
          <option value="ollama">Ollama</option>
          <option value="openai-compat">OpenAI-compatible</option>
        </select>
      </label>
      <label class="set-field" for="set-host">
        <span>Server URL</span>
        <input
          id="set-host"
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={host()}
          placeholder={DEFAULT_OLLAMA_HOST}
          onInput={(e) => setHost(e.currentTarget.value)}
        />
      </label>
      <label class="set-field" for="set-model">
        <span>Model</span>
        <input
          id="set-model"
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={model()}
          placeholder={DEFAULT_MODEL}
          onInput={(e) => setModel(e.currentTarget.value)}
        />
      </label>

      <Show when={error()}>
        {(message) => (
          <p class="set-error" role="alert">
            Could not turn on semantic search: {message()}
          </p>
        )}
      </Show>

      <div class="set-actions">
        <button type="submit" class="set-button set-button-primary" disabled={busy()}>
          {busy() ? "Testing connection…" : "Test connection & enable"}
        </button>
        <button type="button" class="set-button" onClick={props.onCancel} disabled={busy()}>
          Cancel
        </button>
      </div>
      <p class="set-note">
        nooklet asks the server for the model’s vector size before storing anything, so a wrong URL
        or an unpulled model fails here rather than halfway through indexing.
      </p>
    </form>
  );
}

function Progress(props: { state: ModelState }): JSX.Element {
  return (
    <>
      <Row label="Model">
        {props.state.provider}:{props.state.model} · {props.state.dimensions}d
      </Row>
      <Row label="Indexed">
        <span class={props.state.pending === 0 ? "set-ok" : "set-muted"}>
          {props.state.indexed} embedded
        </span>
        {props.state.pending > 0 ? ` · ${props.state.pending} pending` : ""}
        <Show when={props.state.errors > 0}>
          <span class="set-bad"> · {props.state.errors} failed</span>
        </Show>
      </Row>
    </>
  );
}

// A signal, not a flag — the same reason as `PluginsSection.tsx`'s: Settings may already be open
// when the request arrives, and only a tracked read lets the section's effect see it.
const [embeddingsScrollRequested, setEmbeddingsScrollRequested] = createSignal(false);

function EmbeddingsSection(): JSX.Element {
  const [status, { refetch }] = createResource(() =>
    callOp<EmbeddingsStatus>("embeddings.status", {}),
  );
  let sectionEl: HTMLElement | undefined;
  // Held while the panel fills in (`./scroll-section.ts`); stopped by the component, not the
  // effect, which clearing the request re-runs.
  let stopHold = (): void => {};
  onCleanup(() => stopHold());
  createEffect(() => {
    if (!embeddingsScrollRequested() || !sectionEl) return;
    setEmbeddingsScrollRequested(false);
    stopHold();
    stopHold = scrollSectionIntoView(sectionEl);
  });
  // Reading an errored resource re-throws, so every read goes through this.
  const data = (): EmbeddingsStatus | undefined =>
    status.error !== undefined ? undefined : status();
  const [formOpen, setFormOpen] = createSignal(false);
  const [action, setAction] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const reindex = async (): Promise<void> => {
    setAction("Queueing…");
    setActionError(null);
    try {
      const res = await callOp<{ queued: number }>("embeddings.reindex", {});
      setAction(`Queued ${res.queued} item(s); indexing runs in the background.`);
      void refetch();
    } catch (err) {
      setAction(null);
      setActionError(describeError(err));
    }
  };

  return (
    <section ref={sectionEl} id="set-embeddings">
      <h3>Search &amp; embeddings</h3>

      <Show when={status.loading && data() === undefined}>
        <p class="set-muted">Checking…</p>
      </Show>
      <Show when={status.error !== undefined}>
        <p class="set-error" role="alert">
          Could not read the search settings: {describeError(status.error)}
        </p>
      </Show>

      <Show when={data()}>
        {(d) => (
          <SolidSwitch>
            {/* No sqlite-vec means no vector storage at all. Saying so, with the reason, beats
                offering a switch that would appear to work and change nothing. */}
            <Match when={!d().sqlite_vec.loaded}>
              <p class="set-bad" role="status">
                Semantic search cannot run on this server: the <code>sqlite-vec</code> extension did
                not load.
              </p>
              <p class="set-note">
                {d().sqlite_vec.error ?? "No reason reported."} Search still works — it stays
                keyword-only until the extension loads.
              </p>
            </Match>

            {/* Configured and live. */}
            <Match when={d().active}>
              {(active) => (
                <>
                  <Row label="Semantic search">
                    <span class="set-ok">● On</span>
                  </Row>
                  <Row label="Server">
                    <code>{d().configured.host}</code>
                  </Row>
                  <Progress state={active()} />
                  <Show when={d().provider.reachable === false}>
                    <p class="set-error" role="status">
                      The embedding server is not answering right now ({d().provider.error}). New
                      and edited blocks will not be indexed until it is back.
                    </p>
                  </Show>
                </>
              )}
            </Match>

            {/* Registered, still backfilling: it activates itself when the queue drains. */}
            <Match when={d().switching_to}>
              {(pendingModel) => (
                <>
                  <Row label="Semantic search">
                    <span class="set-muted">● Indexing…</span>
                  </Row>
                  <Row label="Server">
                    <code>{d().configured.host}</code>
                  </Row>
                  <Progress state={pendingModel()} />
                  <p class="set-note">
                    It turns on by itself once every page and block has been embedded. {d().queued}{" "}
                    still queued.
                  </p>
                </>
              )}
            </Match>

            {/* The state every install starts in. */}
            <Match when={true}>
              <Row label="Semantic search">
                <span class="set-muted">○ Off</span>
              </Row>
              <p class="set-note">
                Search is keyword-only. Turning this on lets nooklet find notes by meaning, across
                languages, using an embedding model you run yourself — nothing leaves this machine.
              </p>
              <Show when={!formOpen()}>
                <button
                  type="button"
                  class="set-button set-button-primary"
                  onClick={() => setFormOpen(true)}
                >
                  Turn on semantic search…
                </button>
              </Show>
            </Match>
          </SolidSwitch>
        )}
      </Show>

      <Show when={data() && formOpen()}>
        {(_) => (
          <ProviderForm
            initial={data()?.configured ?? { provider: "ollama", host: "", model: "" }}
            onSaved={() => {
              setFormOpen(false);
              void refetch();
            }}
            onCancel={() => setFormOpen(false)}
          />
        )}
      </Show>

      <Show when={data() && !formOpen() && (data()?.active || data()?.switching_to)}>
        <div class="set-actions">
          <button type="button" class="set-button" onClick={() => void refetch()}>
            Refresh
          </button>
          <button type="button" class="set-button" onClick={() => setFormOpen(true)}>
            Change model…
          </button>
          <button type="button" class="set-button" onClick={() => void reindex()}>
            Re-index everything
          </button>
        </div>
        <Show when={action()}>{(message) => <p class="set-note">{message()}</p>}</Show>
        <Show when={actionError()}>
          {(message) => (
            <p class="set-error" role="alert">
              Could not start re-indexing: {message()}
            </p>
          )}
        </Show>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// About / storage
// ---------------------------------------------------------------------------------------------

function AboutSection(props: { onClose: () => void }): JSX.Element {
  const config = bootstrapConfig();
  const [diag] = createResource(() => callOp<Diagnostics>("system.diagnostics", {}));
  const storage = (): Diagnostics["storage"] =>
    diag.error !== undefined ? undefined : diag()?.storage;

  return (
    <section>
      <h3>About</h3>
      <Row label="Server">
        <code>{apiBaseUrl() || location.origin}</code>
      </Row>
      <Row label="Graph">
        <code>{storage()?.graph_id ?? config.graphId ?? "unknown"}</code>
      </Row>
      <Show when={storage()?.data_dir}>
        {(dir) => (
          <Row label="Data directory">
            <code>{dir()}</code>
          </Row>
        )}
      </Show>
      <Row label="Version">nooklet {APP_VERSION}</Row>
      <p class="set-note">
        Index sizes, sync state and backend health live in Diagnostics rather than here.
      </p>
      <button
        type="button"
        class="set-button"
        onClick={() => {
          props.onClose();
          openDiagnostics();
        }}
      >
        Open diagnostics
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

/**
 * ADR 019: the journal template is chosen by writing `journal-template:: true` on one template
 * block. The setting IS that property — it syncs with the graph, the server reads it when an
 * agent creates a day, and an agent can set it with `block_update` — so this is a picker over
 * graph data, not a preference. `data/templates.ts` owns the read and the write; the list is
 * fetched when the panel opens and again after a change, which is as live as a modal needs.
 */
function TemplatesSection(): JSX.Element {
  const [templates, { refetch }] = createResource(listTemplates);
  const [error, setError] = createSignal<string | null>(null);
  // Reading an errored resource re-throws, so every read goes through this.
  const list = (): TemplateSummary[] => (templates.error !== undefined ? [] : (templates() ?? []));
  const currentId = (): string => list().find((t) => t.journal)?.id ?? "";

  const choose = async (id: string): Promise<void> => {
    setError(null);
    try {
      await setJournalTemplate(id === "" ? null : id);
      await refetch();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section>
      <h3>Templates</h3>
      <Row label="Journal template">
        <select
          id="set-journal-template"
          aria-label="Journal template"
          onChange={(e) => void choose(e.currentTarget.value)}
        >
          <option value="" selected={currentId() === ""}>
            None
          </option>
          <For each={list()}>
            {(t) => (
              <option value={t.id} selected={t.id === currentId()}>
                {t.name}
              </option>
            )}
          </For>
        </select>
      </Row>
      <Show when={error()}>
        {(message) => (
          <p class="set-error" role="alert">
            Could not change the journal template: {message()}
          </p>
        )}
      </Show>
      <p class="set-note">
        Inserted at the top of every new journal day — one started here or one an agent creates
        through the API. Any block with <code>template:: name</code> is a template; insert one
        anywhere with <code>/template</code>. <code>&lt;% today %&gt;</code>,{" "}
        <code>&lt;% yesterday %&gt;</code>, <code>&lt;% tomorrow %&gt;</code> and{" "}
        <code>&lt;% time %&gt;</code> are filled in on insert.
      </p>
      <Show when={!templates.loading && templates.error === undefined && list().length === 0}>
        <p class="set-muted">No templates in this graph yet.</p>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

/** B-608: Logseq's `:preferred-workflow`. The value and where it comes from belong to
 * `data/task-workflow.ts`; this is the picker over it. */
function TasksSection(): JSX.Element {
  return (
    <section>
      <h3>Tasks</h3>
      <Row label="Task workflow">
        <select
          id="set-task-workflow"
          aria-label="Task workflow"
          value={taskWorkflow()}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "now" || v === "todo") chooseTaskWorkflow(v);
          }}
        >
          <option value="now">LATER → NOW → DONE</option>
          <option value="todo">TODO → DOING → DONE</option>
        </select>
      </Row>
      <p class="set-note">
        What Cmd/Ctrl+Enter starts a task as, and which pair the slash menu offers first — Logseq's{" "}
        <code>:preferred-workflow</code>. A LATER or TODO task always cycles within its own pair.
        Until you choose, it follows the graph: its imported Logseq setting, or the markers it
        already uses. Stored per device.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export function SettingsPanel(props: { onClose: () => void }): JSX.Element {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop-dismiss; the dialog below stops propagation so a click inside never closes it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is not needed to reach this — the close button is the keyboard path out.
    <div class="set-backdrop" onClick={props.onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation; it is not an action. */}
      <div
        class="set-panel"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="set-header">
          <h2>Settings</h2>
          <button type="button" class="set-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <AppearanceSection />
        <TasksSection />
        <TemplatesSection />
        <EmbeddingsSection />
        <DevicesSection />
        <PluginsSection />
        <AboutSection onClose={props.onClose} />
      </div>
    </div>
  );
}

/** Module-level open/close, so any surface (help menu, `app.openSettings`) can raise it. */
const [open, setOpen] = createSignal(false);
export const settingsOpen = open;
export function openSettings(): void {
  setOpen(true);
}
/** Open Settings scrolled to "Search & embeddings" — where the Search view sends someone whose
 * search fell back to keyword because semantic search is not set up, or is failing (B-520). */
export function openEmbeddingsSettings(): void {
  setEmbeddingsScrollRequested(true);
  setOpen(true);
}
export function closeSettings(): void {
  setOpen(false);
}
