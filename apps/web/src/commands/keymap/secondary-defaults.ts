/**
 * R64 step 2 / R21: the small, core-defined, non-user-editable list of extra keymap rows beyond
 * each command's own `defaultKeys`.
 */
export interface SecondaryDefault {
  key: string;
  command: string;
  when?: string;
}

export const SECONDARY_DEFAULTS: readonly SecondaryDefault[] = [
  { key: "Delete", command: "block.deleteSelected", when: "blockSelected" },
  // The palette's own default is Cmd+K, but Cmd/Ctrl+Shift+P is what most people's hands already
  // know from VS Code and its descendants, and nothing else claims it here.
  { key: "Cmd+Shift+P", command: "palette.open" },
  { key: "Ctrl+Shift+P", command: "palette.open" },
];
