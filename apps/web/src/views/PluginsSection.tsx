/**
 * Settings → Plugins: a plain, read-only list of the plugins the server has loaded.
 *
 * "Open plugin manager" (`app.openPluginManager`) used to navigate to `/settings/plugins`, a route
 * that has never existed, and left the main area blank (B-98). There is no plugin manager to open
 * and this does not pretend to be one: enabling, disabling and reloading a plugin is a server-side
 * act (`nooklet plugin enable|disable|reload`) with no op behind it, so the section lists what is
 * running and names the command that changes it. The command now opens Settings scrolled to this section.
 *
 * Its own module, beside `SettingsPanel.tsx` rather than inside it, so the panel keeps a one-line
 * hookup for it.
 */

import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import { type InstalledPlugin, listInstalledPlugins } from "../data/plugins.js";

// A signal, not a flag: the section may already be mounted (Settings open underneath the palette)
// when the request arrives, and only a tracked read makes the effect below see it.
const [scrollRequested, setScrollRequested] = createSignal(false);

/** Ask for this section to be scrolled into view the next time it is on screen. Paired with
 * `openSettings()` by `app/CommandLayer.tsx` for `app.openPluginManager`; not importing the panel
 * here keeps the two modules out of an import cycle. */
export function requestPluginsSection(): void {
  setScrollRequested(true);
}

function halves(p: InstalledPlugin): string {
  if (p.hasClient && p.hasServer) return "server + client";
  return p.hasClient ? "client" : "server";
}

export function PluginsSection(): JSX.Element {
  const [plugins] = createResource(listInstalledPlugins);
  // Reading an errored resource re-throws, so every read goes through this.
  const list = (): InstalledPlugin[] => (plugins.error !== undefined ? [] : (plugins() ?? []));
  let sectionEl: HTMLElement | undefined;

  createEffect(() => {
    if (!scrollRequested() || !sectionEl) return;
    setScrollRequested(false);
    sectionEl.scrollIntoView({ block: "start" });
  });

  return (
    <section ref={sectionEl} id="set-plugins" aria-label="Plugins">
      <h3>Plugins</h3>
      <Show when={plugins.loading}>
        <p class="set-muted">Checking…</p>
      </Show>
      <Show when={plugins.error !== undefined}>
        <p class="set-error" role="alert">
          Could not list plugins: {describeError(plugins.error)}
        </p>
      </Show>
      <For each={list()}>
        {(p) => (
          <div class="set-row set-plugin">
            <span class="set-label">{p.name}</span>
            <span class="set-value">
              <code>{p.id}</code> {p.version} · {halves(p)}
            </span>
          </div>
        )}
      </For>
      <Show when={!plugins.loading && plugins.error === undefined && list().length === 0}>
        <p class="set-muted">No plugins are running on this server.</p>
      </Show>
      {/* The restart is not optional: the CLI only writes the `plugin` table, and v1 has no channel
          into a running server (`packages/server/src/cli.ts`, "plugin" case) — without saying so,
          this read as if the change applied at once. */}
      <p class="set-note">
        Active plugins only. Enable, disable or reload one on the server with{" "}
        <code>nooklet plugin list</code>, <code>enable &lt;id&gt;</code>,{" "}
        <code>disable &lt;id&gt;</code> or <code>reload &lt;id&gt;</code>, then restart{" "}
        <code>nooklet serve</code>.
      </p>
    </section>
  );
}
