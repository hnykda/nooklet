/**
 * Assembles the command system and mounts its overlays.
 *
 * The command package (`src/commands/`) is deliberately host-agnostic: it declares seams
 * (`Store`, `PageSource`, `BlockSource`, `NavigationHost`, `AppHost`, `EditorHost`) and ships
 * fakes for its own tests, but never reaches into the data layer or the router. This component is
 * where those seams are filled with the real implementations (`./hosts.ts`, `./editor-host.ts`)
 * and where the palette, slash menu, autocomplete popups and mobile toolbar get mounted — once,
 * above the routes, so they float over whatever view is open.
 *
 * The overlays are controlled components by design: they render a trigger someone else detected.
 * Detection lives here because it depends on the *editor's* caret and text, which this layer can
 * read through `activeEditorHost()` but the command package deliberately cannot.
 *
 * Keyboard dispatch is installed on `document` in the capture phase so a global binding (the
 * palette, navigation) beats a view's own handler. Block-structural keys are NOT handled here —
 * CodeMirror sees those first inside the focused surface (`../editor/keydown.ts`), which is why
 * the structural commands registered below delegate through `EditorHost` instead of
 * reimplementing anything.
 */

import { newId } from "@nooklet/core";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  type AutocompleteMatch,
  AutocompletePopup,
  type CommandContext,
  CommandPalette,
  CommandProvider,
  createCoreCommands,
  createFakeDatePickerHost,
  createPaletteController,
  detectPlatformFromEnvironment,
  type EditorHost,
  MobileKeyboardToolbar,
  matchBlockRefTrigger,
  matchPageRefTrigger,
  matchSlashTrigger,
  matchTagTrigger,
  type SlashMatch,
  SlashMenu,
  useCommands,
} from "../commands/index.js";
import { apiBaseUrl, authToken } from "../data/bootstrap.js";
import { applyOp, resolvePageName } from "../data/store.js";
import { forceSync, initDb } from "../db/client.js";
import {
  buildUiWindowState,
  connectLiveSocket,
  getOrCreateWindowId,
  type LiveSocketHandle,
  liveConsent,
  RemoteFlashOverlay,
  runRemoteCommand,
  setLiveConnected,
} from "../live/index.js";
import { ClientPlugins } from "../plugins/ClientPlugins.js";
import { openSettings as openSettingsPanel } from "../views/SettingsPanel.js";
import { BlockContextMenu } from "./BlockContextMenu.js";
import { activeContextSnapshot, buildContextBase, liveEditorHost } from "./editor-host.js";
import {
  createAppHost,
  createBlockSource,
  createNavigationHost,
  createPageSource,
  createStore,
  pagePath,
} from "./hosts.js";
import { createRefactorHost } from "./refactor-host.js";
import { useTheme } from "./theme.js";

type ContextBase = Omit<CommandContext, "exec" | "args">;

/** Global keydown dispatch, installed once the provider exists. */
function KeyboardDispatch(props: { getContext: () => ContextBase }): null {
  const { dispatcher, buildContext } = useCommands();
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (dispatcher.handleKeyDown(e, buildContext(props.getContext()))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
  });
  return null;
}

/**
 * ADR 015 §2.1/§2.6: connects `/ui/live` only while "let agents view this window" is on, and
 * answers `state.get`/`command.run` through the SAME registry/context this provider already built
 * for keyboard/palette/toolbar dispatch (`./live/command-runner.ts` — never a parallel path). A
 * sibling of `KeyboardDispatch` for the same reason: `useCommands()` only resolves inside
 * `<CommandProvider>`.
 */
function LiveConnection(props: { getContext: () => ContextBase; editor: EditorHost }): null {
  const { registry, buildContext } = useCommands();
  const location = useLocation();
  const [deviceId, setDeviceId] = createSignal<string | undefined>();
  const [viewEnabled, setViewEnabled] = createSignal(liveConsent.get().viewEnabled);
  const windowId = getOrCreateWindowId(
    typeof sessionStorage === "undefined" ? undefined : sessionStorage,
  );

  onMount(() => {
    void initDb().then(({ deviceId: id }) => setDeviceId(id));
    const unsubscribe = liveConsent.subscribe((s) => setViewEnabled(s.viewEnabled));
    onCleanup(unsubscribe);
  });

  let handle: LiveSocketHandle | undefined;
  createEffect(() => {
    const id = deviceId();
    if (!viewEnabled() || !id) {
      handle?.stop();
      handle = undefined;
      setLiveConnected(false);
      return;
    }
    if (handle) return; // already connected/connecting for this (viewEnabled, deviceId) pair
    handle = connectLiveSocket({
      baseUrl: apiBaseUrl(),
      deviceId: id,
      windowId,
      client: "nooklet-web",
      // Dev-only stand-in until device pairing (PLAN.md §6) ships a real per-device token — same
      // as `../data/api-client.ts`'s own `getToken`. `/ui/live` authenticates like `/sync/live`
      // (ADR 015 §2.1): a `can_sync` device token, not a separate MCP credential.
      getToken: authToken,
      getControlEnabled: () => liveConsent.get().controlEnabled,
      // TODO(views): resolve the current route to a real {id, name} once a cheap local lookup
      // exists here; ui_state's own state.get round trip already reports the page accurately, so
      // this only affects ui_windows' listing, not correctness of what an agent sees when it asks.
      getPage: () => null,
      getFocused: () => document.hasFocus(),
      onConnectedChange: setLiveConnected,
      buildState: () => {
        const selection = props.editor.getSelection();
        return buildUiWindowState({
          windowId,
          deviceId: id,
          focused: document.hasFocus(),
          editor: activeContextSnapshot(),
          cursor: selection ? { anchor: selection.start, head: selection.end } : null,
          page: null,
          zoomRootBlockId: new URLSearchParams(location.search).get("block"),
          panels: {
            sidebarOpen: document.body.classList.contains("sidebar-open"),
            activeView: location.pathname.split("/")[1] || "journals",
            dialogOpen: null,
          },
        });
      },
      runCommand: (commandId, args) =>
        runRemoteCommand(
          {
            registry,
            buildContext,
            contextBase: props.getContext,
            isControlEnabled: () => liveConsent.get().controlEnabled,
            forceSync,
          },
          commandId,
          args,
        ),
    });
  });

  onCleanup(() => handle?.stop());

  return null;
}

interface Triggers {
  slash: SlashMatch | null;
  page: AutocompleteMatch | null;
  tag: AutocompleteMatch | null;
  block: AutocompleteMatch | null;
}

const NO_TRIGGERS: Triggers = { slash: null, page: null, tag: null, block: null };

export function CommandLayer(props: { children?: JSX.Element }): JSX.Element {
  const navigate = useNavigate();
  const theme = useTheme();
  const { platform, mobile } = detectPlatformFromEnvironment();

  // Created here, not by the provider: `createCoreCommands` needs it as a dependency, so both
  // the commands and the provider must share one instance.
  const palette = createPaletteController();
  // `liveEditorHost`, NOT `activeEditorHost()`: this is evaluated once, and a snapshot taken here
  // would pin every editor command to the no-op host that exists before any block has focus.
  const editor = liveEditorHost;
  const store = createStore();
  const pages = createPageSource();
  const blocks = createBlockSource();

  const navigation = createNavigationHost({
    navigate: (path) => navigate(path),
    pageNameForId: resolvePageName,
  });

  const app = createAppHost({
    navigate: (path) => navigate(path),
    toggleSidebar: () => document.body.classList.toggle("sidebar-open"),
    // Undo/redo belong to the focused editor's document-level history (ADR 006), reached through
    // the same structural delegation every other block command uses.
    undo: () => void editor.runStructuralCommand("edit.undo", {} as CommandContext),
    redo: () => void editor.runStructuralCommand("edit.redo", {} as CommandContext),
    setTheme: theme.set,
    getTheme: theme.get,
    // `app.openSettings` (Cmd/Ctrl+,) raises the shell-level panel `AppShell` renders. It used to
    // navigate to `/settings`, a route that does not exist, so the keybinding opened nothing.
    openSettings: openSettingsPanel,
  });

  const getContext = (): ContextBase => buildContextBase(store, platform, mobile);

  const [triggers, setTriggers] = createSignal<Triggers>(NO_TRIGGERS);
  const [caretPos, setCaretPos] = createSignal({ top: 0, left: 0 });
  // Escape closes a popup but leaves the text that opened it, and the next keyup re-detects that
  // text and reopens it — so Escape did nothing you could see (part of B-65). A dismissal is
  // therefore remembered per trigger kind by the offset it was opened at, and a re-detection at
  // the same offset stays closed until the trigger moves or goes away: type `[[` again and it
  // opens again, keep typing inside the old one and it stays shut, as in Logseq.
  const dismissedAt: Partial<Record<keyof Triggers, number>> = {};
  const dismiss = (): void => {
    const t = triggers();
    for (const kind of ["slash", "page", "tag", "block"] as const) {
      const match = t[kind];
      if (match) dismissedAt[kind] = match.from;
    }
    setTriggers(NO_TRIGGERS);
  };

  // Re-detect after any key that could have changed the text before the caret. Reading the
  // editor's own selection keeps this honest — there is no second copy of "what is typed".
  onMount(() => {
    const onKeyUp = (): void => {
      const sel = editor.getSelection();
      if (!sel) {
        setTriggers(NO_TRIGGERS);
        return;
      }
      const before = sel.content.slice(0, sel.start);
      const next: Triggers = {
        slash: matchSlashTrigger(before),
        page: matchPageRefTrigger(before),
        tag: matchTagTrigger(before),
        block: matchBlockRefTrigger(before),
      };
      for (const kind of ["slash", "page", "tag", "block"] as const) {
        const match = next[kind];
        const at = dismissedAt[kind];
        if (at === undefined) continue;
        if (match && match.from === at) next[kind] = null;
        else delete dismissedAt[kind];
      }
      setTriggers(next);
      const rect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect();
      if (rect && (rect.top || rect.left)) setCaretPos({ top: rect.bottom, left: rect.left });
    };
    document.addEventListener("keyup", onKeyUp, true);
    // A pointer can also change what is under the caret — most importantly a click away, which
    // ends editing (B-74): with no editor there is no trigger, and the popup must go with it.
    // Re-detecting only on keyup left it hanging over the page until the next keystroke.
    //
    // Two things this must not do. It must not run for a click INSIDE the popup — the caret has
    // not moved, and re-detecting rebuilds the trigger object, which re-renders every row between
    // `pointerup` and `click`, so the row that was clicked no longer exists when the click
    // arrives and nothing is inserted. And it must not run synchronously even for a click
    // elsewhere: `click` fires after `pointerup` in the same task, so the re-detection is
    // deferred a macrotask, by which time whatever the click did to the editor has happened.
    const onPointerUp = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      if (target?.closest(".cmd-popup, .ctx-menu")) return;
      setTimeout(onKeyUp, 0);
    };
    document.addEventListener("pointerup", onPointerUp, true);
    onCleanup(() => {
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerup", onPointerUp, true);
    });
  });

  const commands = createCoreCommands({
    editor,
    navigation,
    app,
    // The palette controller is created by the provider; commands that open it go through the
    // same instance, so `palette.open()` from a command and Cmd+K agree.
    palette,
    datePicker: createFakeDatePickerHost(),
    now: () => Date.now(),
    // M7 refactors (ADR 020): server ops behind the context menu and the palette.
    refactor: createRefactorHost({
      navigate: (path) => navigate(path),
      closePalette: () => palette.close(),
    }),
  });

  const anyAutocomplete = createMemo(() => {
    const t = triggers();
    if (t.page) return { variant: "page" as const, trigger: t.page };
    if (t.tag) return { variant: "tag" as const, trigger: t.tag };
    if (t.block) return { variant: "block" as const, trigger: t.block };
    return null;
  });

  return (
    <CommandProvider commands={commands} platform={platform} palette={palette}>
      <KeyboardDispatch getContext={getContext} />
      <LiveConnection getContext={getContext} editor={editor} />
      <ClientPlugins editor={editor} mobile={mobile} />
      <RemoteFlashOverlay />
      {props.children}
      <CommandPalette
        pages={pages}
        getContext={getContext}
        onSelectPage={(p) => navigation.openPage(p.id)}
        onCreatePage={(name) => {
          // Create it and go there in one step. `page.create` is the same op the API uses, so a
          // page made this way is indistinguishable from one an agent or an import produced.
          // `journalDay: null` — a page typed into the palette is an ordinary page. A journal day
          // is reached through the calendar or the journal stream, which own that mapping.
          void applyOp(newId(), {
            kind: "page.create",
            name,
            journalDay: null,
            createdAt: Date.now(),
          });
          navigate(pagePath(name));
        }}
      />
      <Show when={triggers().slash}>
        {(t) => (
          <SlashMenu
            editor={editor}
            trigger={t()}
            position={caretPos()}
            getContext={getContext}
            onDismiss={dismiss}
          />
        )}
      </Show>
      <Show when={anyAutocomplete()}>
        {(a) => (
          <AutocompletePopup
            variant={a().variant}
            editor={editor}
            trigger={a().trigger}
            position={caretPos()}
            pages={pages}
            blocks={blocks}
            onDismiss={dismiss}
          />
        )}
      </Show>
      <BlockContextMenu getContext={getContext} />
      <MobileKeyboardToolbar getContext={getContext} />
    </CommandProvider>
  );
}
