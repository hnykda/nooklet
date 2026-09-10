/**
 * R64 step 2 / R21: the small, core-defined, non-user-editable list of extra keymap rows beyond
 * each command's own `defaultKeys`. Per the spec this is currently exactly one row.
 */
export interface SecondaryDefault {
  key: string;
  command: string;
  when?: string;
}

export const SECONDARY_DEFAULTS: readonly SecondaryDefault[] = [
  { key: "Delete", command: "block.deleteSelected", when: "blockSelected" },
];
