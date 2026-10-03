/**
 * Starts the client plugin host once the command system exists (ADR 023) and feeds it the two
 * client events it supports. Mounted inside `<CommandProvider>` by `app/CommandLayer.tsx` — plugin
 * slash commands are registry commands, and `useCommands()` only resolves in there. Renders
 * nothing; the plugins' visible output goes through the slash menu, fence renderers and
 * `./StatusItems.tsx`.
 *
 * "The open page" is the `/page/<name>` route's page. The journals stream shows many days at once
 * and has no single current page, so `editor.currentPage()` is `null` there.
 */
import type { Page } from "@nooklet/core";
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { confirmDialog } from "../app/confirm-dialog.js";
import { type EditorHost, useCommands } from "../commands/index.js";
import { contributeSlashItem } from "../commands/slash/contributed.js";
import { apiBaseUrl, appRelativePathname, authToken } from "../data/bootstrap.js";
import { loadPage } from "../data/plugin-lookups.js";
import { blockAfterOps } from "../data/plugin-writes.js";
import { applyOps, resolvePageName, serverCaughtUpVersion, stampedFor } from "../data/store.js";
import { requestBlockFocus } from "../editor/focus-request.js";
import { registerFenceRenderer } from "../editor/render/PluginFence.js";
import { pageRoutePath, pathToPageName } from "../routes/page-path.js";
import { BUILTIN_CLIENT_PLUGINS } from "./builtins.js";
import { createClientPluginHost } from "./host.js";
import { addStatusItem } from "./StatusItems.js";

export function ClientPlugins(props: { editor: EditorHost; mobile: boolean }): null {
  const { registry } = useCommands();
  const navigate = useNavigate();
  const location = useLocation();
  // Re-resolved on every page-table change anywhere in the graph; only a change to THIS page (or a
  // different page) counts, or every page created elsewhere would read as "the open page changed".
  const [page, setPage] = createSignal<Page | null>(null, {
    equals: (a, b) =>
      a?.id === b?.id &&
      a?.name === b?.name &&
      JSON.stringify(a?.properties) === JSON.stringify(b?.properties),
  });

  const host = createClientPluginHost({
    registry,
    editor: props.editor,
    navigate: (path) => navigate(path),
    pageNameForId: resolvePageName,
    pagePath: pageRoutePath,
    currentPage: page,
    baseUrl: apiBaseUrl,
    getToken: authToken,
    hostVersion: __APP_VERSION__,
    platform: props.mobile ? "mobile" : "desktop",
    theme: () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    contributeSlashItem,
    registerFenceRenderer,
    addStatusItem,
    blockAfterOps,
    applyOps,
    focusBlock: requestBlockFocus,
    confirm: (message) =>
      confirmDialog({ title: message, message: [], confirmLabel: "OK", cancelLabel: "Cancel" }),
  });
  onMount(() => void host.start(BUILTIN_CLIENT_PLUGINS));
  onCleanup(() => void host.stop());

  const routePageName = createMemo(() => {
    // ADR 025: `location.pathname` may carry this page's own `/g/<slug>` prefix.
    const match = /^\/page\/(.+)$/.exec(appRelativePathname(location.pathname));
    return match?.[1] ? pathToPageName(match[1]) : null;
  });

  // Resolve the route's page, again whenever pages change (created after navigating to it, renamed).
  createEffect(() => {
    const name = routePageName();
    stampedFor(name, ["page", "page_prop"]);
    if (name === null) {
      setPage(null);
      return;
    }
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    void loadPage({ name }).then((p) => {
      if (!stale) setPage(p);
    });
  });

  // `page.opened` once per page; `page.changed` on that and on every later change to what
  // `currentPage()` answers — the page's rows, leaving it for no page, and the push queue draining
  // so a listener reading through the server sees the edit.
  let openedId: string | null | undefined;
  createEffect(() => {
    const current = page();
    const id = current?.id ?? null;
    if (current) {
      stampedFor(null, [], current.id);
      serverCaughtUpVersion();
    }
    // Plugin handlers run synchronously here; untracked, so a signal one of them happens to read
    // never becomes a dependency of this effect (and re-fires every plugin's handlers with it).
    untrack(() => {
      if (id !== openedId) {
        openedId = id;
        if (current) host.emit("page.opened", { page: current });
      }
      host.emit("page.changed", { page: current });
    });
  });

  return null;
}
