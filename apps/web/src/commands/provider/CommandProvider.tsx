/**
 * `<CommandProvider>` (BUILD item 6): exposes the registry, the compiled keymap, the palette
 * controller, and a ready-to-call `exec`/`buildContext` pair to the rest of the app via Solid
 * context. Does not render anything visible itself — mount `<CommandPalette>`/`<SlashMenu>`/
 * `<AutocompletePopup>`/`<MobileKeyboardToolbar>` (this package's other components) wherever the
 * app's layout wants them; see this package's summary for exactly what the integrator needs to
 * mount and where.
 */
import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  type JSX,
  useContext,
} from "solid-js";
import { buildKeymap } from "../keymap/build.js";
import { detectConflicts } from "../keymap/conflicts.js";
import { createDispatcher, type Dispatcher } from "../keymap/dispatch.js";
import { detectPlatformFromEnvironment } from "../keymap/platform.js";
import { createPaletteController, type PaletteController } from "../palette/palette-controller.js";
import { popupTakesKey } from "../popup-keys.js";
import { createMruStore, type MruStorageAdapter, type MruStore } from "../ranking/mru.js";
import { type CommandRegistry, createCommandRegistry } from "../registry.js";
import type {
  Command,
  CommandContext,
  KeybindingsFile,
  KeymapConflict,
  ResolvedBinding,
  WhenContext,
} from "../types.js";
import { createCommandContext } from "./executor.js";

export interface CommandProviderValue {
  registry: CommandRegistry;
  mru: MruStore;
  palette: PaletteController;
  dispatcher: Dispatcher;
  /** The assembled runtime keymap for the current platform (R64), recomputed whenever
   * `setKeybindings` is called. */
  bindings: Accessor<ResolvedBinding[]>;
  /** Informational conflict list (R67) for a settings UI. */
  conflicts: Accessor<KeymapConflict[]>;
  /** Replace the user `keybindings.json` rows (e.g. after the settings UI saves an edit). */
  setKeybindings: (rows: KeybindingsFile) => void;
  /** Build a full `CommandContext` from a fresh `WhenContext` + focus/selection/surface/store
   * snapshot. Callers (the editor, the toolbar, this package's own popups) construct this snapshot
   * themselves per the Definitions section ("computed fresh before every keydown dispatch and
   * before every palette/menu render") — this just wires up `exec` on top of it. */
  buildContext: (base: Omit<CommandContext, "exec" | "args">) => CommandContext;
}

const CommandsContext = createContext<CommandProviderValue>();

export interface CommandProviderProps {
  /** Every command to register at startup — typically `createCoreCommands(...)` plus any
   * plugin-contributed commands. Registered once, when the provider is created. */
  commands: Command[];
  /** Initial `keybindings.json` contents (the synced setting, R68) — omit for defaults only. */
  keybindings?: KeybindingsFile;
  /** Override platform detection (tests, or a host that already knows it). Defaults to sniffing
   * `navigator`. */
  platform?: WhenContext["platform"];
  hasHardwareKeyboard?: boolean;
  /** Storage backing the MRU list (R71) — defaults to `localStorage` when available. */
  mruStorage?: MruStorageAdapter;
  /** Share an externally-created palette controller. The host needs one *before* the provider
   * exists, because `createCoreCommands` takes it as a dependency (so `palette.open()` from a
   * command and the Cmd+K binding drive the same instance). Omit and one is created here. */
  palette?: PaletteController;
  children?: JSX.Element;
}

export function CommandProvider(props: CommandProviderProps): JSX.Element {
  const registry = createCommandRegistry();
  for (const command of props.commands) registry.register(command);

  const mru = createMruStore(props.mruStorage);
  const palette = props.palette ?? createPaletteController();

  const [keybindings, setKeybindings] = createSignal<KeybindingsFile>(props.keybindings ?? []);
  const platform = props.platform ?? detectPlatformFromEnvironment().platform;
  const hasHardwareKeyboard = props.hasHardwareKeyboard ?? true;

  const bindings = createMemo(() =>
    buildKeymap(registry.list(), keybindings(), { platform, hasHardwareKeyboard }),
  );
  const conflicts = createMemo(() => detectConflicts(bindings()));

  const dispatcher = createDispatcher({ getBindings: () => bindings(), popupTakesKey });

  function buildContext(base: Omit<CommandContext, "exec" | "args">): CommandContext {
    return createCommandContext(base, registry, mru);
  }

  const value: CommandProviderValue = {
    registry,
    mru,
    palette,
    dispatcher,
    bindings,
    conflicts,
    setKeybindings,
    buildContext,
  };

  return <CommandsContext.Provider value={value}>{props.children}</CommandsContext.Provider>;
}

export function useCommands(): CommandProviderValue {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("useCommands() called outside <CommandProvider>");
  return value;
}
