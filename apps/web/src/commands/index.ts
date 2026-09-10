/**
 * Public surface of the command system (`apps/web/src/commands/`). See this package's summary
 * (delivered alongside the task) for exactly what needs mounting in `App.tsx` and the editor
 * integration seams (`EditorHost`, `Store`, `PageSource`/`BlockSource`, `NavigationHost`/
 * `AppHost`).
 */

export {
  AutocompletePopup,
  type AutocompletePopupProps,
  type AutocompleteVariant,
} from "./autocomplete/AutocompletePopup.js";
// ── Autocomplete popups ──────────────────────────────────────────────────────────────────────────
export {
  type AutocompleteMatch,
  computeBlockRefQuery,
  computePageRefQuery,
  computeTagQuery,
  matchBlockRefTrigger,
  matchPageRefTrigger,
  matchTagTrigger,
} from "./autocomplete/trigger.js";
// ── Editor / storage / navigation seams (BUILD item 4/5) ────────────────────────────────────────
export {
  createFakeEditorHost,
  type EditorHost,
  type EditorSelection,
  type LinkAtCaret,
  type ReplaceRangeSpec,
} from "./hosts/editor-host.js";
export {
  type AppHost,
  createFakeAppHost,
  createFakeNavigationHost,
  type NavigationHost,
} from "./hosts/nav-host.js";
export {
  type BlockSource,
  type BlockSummary,
  createFakeBlockSource,
  createFakePageSource,
  type PageSource,
  type PageSummary,
} from "./hosts/page-source.js";
export { createFakeStore } from "./hosts/store.js";
// ── Keybinding resolution ────────────────────────────────────────────────────────────────────────
export {
  type BuildKeymapOptions,
  baseKeyFromEvent,
  buildKeymap,
  chordSteps,
  createDispatcher,
  type DispatchableKeyboardEvent,
  type Dispatcher,
  type DispatcherDeps,
  detectConflicts,
  detectMobile,
  detectPlatform,
  detectPlatformFromEnvironment,
  formatKey,
  isChord,
  type KeyboardEventLike,
  KeyNotationError,
  keyTokenFromEvent,
  type ModifierFlags,
  type NavigatorLike,
  parseSingleToken,
  resolveKeyToken,
  resolveModForPlatform,
  resolveSingleKeyToken,
  SECONDARY_DEFAULTS,
  type SecondaryDefault,
} from "./keymap/index.js";
export { CommandPalette, type CommandPaletteProps } from "./palette/CommandPalette.js";
// ── Command palette ──────────────────────────────────────────────────────────────────────────────
export { createPaletteController, type PaletteController } from "./palette/palette-controller.js";
export {
  CommandProvider,
  type CommandProviderProps,
  type CommandProviderValue,
  useCommands,
} from "./provider/CommandProvider.js";
// ── Provider / context ───────────────────────────────────────────────────────────────────────────
export { createCommandContext } from "./provider/executor.js";
export { createMruStore, type MruStorageAdapter, type MruStore } from "./ranking/mru.js";
// ── Ranking (palette / slash menu / autocomplete) ───────────────────────────────────────────────
export { normalizeForMatch } from "./ranking/normalize.js";
export { type RankableItem, type RankOptions, rankItems } from "./ranking/rank.js";
// ── Concrete core commands (BUILD item 7) ───────────────────────────────────────────────────────
export {
  type CompletionResult,
  type CoreCommandDeps,
  completeTask,
  createAppCommands,
  createCoreCommands,
  createFakeDatePickerHost,
  createFormatCommands,
  createInsertCommands,
  createNavCommands,
  createStructuralCommands,
  createTaskCommands,
  type DatePickerHost,
  nextCycleMarker,
  type TaskSnapshot,
} from "./registrations/index.js";
// ── Command registry ─────────────────────────────────────────────────────────────────────────────
export {
  CommandRegistrationError,
  type CommandRegistry,
  createCommandRegistry,
} from "./registry.js";
// ── Slash menu ───────────────────────────────────────────────────────────────────────────────────
export { SLASH_ITEMS } from "./slash/items.js";
export { SlashMenu, type SlashMenuProps } from "./slash/SlashMenu.js";
export { computeSlashQuery, matchSlashTrigger, type SlashMatch } from "./slash/trigger.js";
// ── Mobile keyboard toolbar ──────────────────────────────────────────────────────────────────────
export {
  MobileKeyboardToolbar,
  type MobileKeyboardToolbarProps,
  TOOLBAR_BUTTONS,
} from "./toolbar/MobileToolbar.js";
// ── Core types (Command, WhenContext, CommandContext, keymap/palette shapes) ────────────────────
export * from "./types.js";
// ── `when`-clause language ───────────────────────────────────────────────────────────────────────
export {
  areProvablyDisjoint,
  compileWhen,
  evaluateWhen,
  matchesWhen,
  parseWhen,
  WhenClauseError,
} from "./when/index.js";
