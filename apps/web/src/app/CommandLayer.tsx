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

import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
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
  MobileKeyboardToolbar,
  matchBlockRefTrigger,
  matchPageRefTrigger,
  matchSlashTrigger,
  matchTagTrigger,
  type SlashMatch,
  SlashMenu,
  useCommands,
} from "../commands/index.js";
import { resolveBlockPageName } from "../data/store.js";
import { activeEditorHost, buildContextBase } from "./editor-host.js";
import {
  createAppHost,
  createBlockSource,
  createNavigationHost,
  createPageSource,
  createStore,
} from "./hosts.js";
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
  const editor = activeEditorHost();
  const store = createStore();
  const pages = createPageSource();
  const blocks = createBlockSource();

  const navigation = createNavigationHost({
    navigate: (path) => navigate(path),
    pageNameForId: resolveBlockPageName,
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
  });

  const getContext = (): ContextBase => buildContextBase(store, platform, mobile);

  const [triggers, setTriggers] = createSignal<Triggers>(NO_TRIGGERS);
  const [caretPos, setCaretPos] = createSignal({ top: 0, left: 0 });
  const dismiss = (): void => {
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
      setTriggers({
        slash: matchSlashTrigger(before),
        page: matchPageRefTrigger(before),
        tag: matchTagTrigger(before),
        block: matchBlockRefTrigger(before),
      });
      const rect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect();
      if (rect && (rect.top || rect.left)) setCaretPos({ top: rect.bottom, left: rect.left });
    };
    document.addEventListener("keyup", onKeyUp, true);
    onCleanup(() => document.removeEventListener("keyup", onKeyUp, true));
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
      {props.children}
      <CommandPalette
        pages={pages}
        getContext={getContext}
        onSelectPage={(p) => navigation.openPage(p.id)}
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
      <MobileKeyboardToolbar getContext={getContext} />
    </CommandProvider>
  );
}
