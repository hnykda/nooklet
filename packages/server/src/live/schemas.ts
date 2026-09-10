/**
 * Shared Zod shapes for the `ui.*` ops (ADR 015 §2.3/§2.5), matching `../ops/schemas.ts`'s house
 * style: wire JSON is `snake_case`, every field carries a `.describe()`.
 */

import { z } from "zod";
import { BlockId } from "../ops/schemas.js";

export const WindowPage = z.object({
  id: z.string().describe("Page id"),
  name: z.string().describe("Page name, or a journal day's ISO date"),
});

/**
 * The state a live window reports back for `state.get` (ADR 015 §2.3): almost verbatim the
 * client's own `WhenContext`/`CommandContext`, serialized — see `apps/web/src/live/state-snapshot.ts`
 * for the client-side builder this schema documents the wire shape of.
 */
export const UiWindowState = z.object({
  window_id: z.string().describe("This window's session id"),
  device_id: z.string().describe("The device (sync replica) this window belongs to"),
  focused: z.boolean().describe("This window is the frontmost one on its device, if knowable"),
  page: WindowPage.nullable().describe(
    "The page currently open, or null if none (e.g. a blank tab)",
  ),
  zoom_root_block_id: BlockId.nullable().describe(
    "Non-null when the view is zoomed into one block",
  ),
  focus: z.object({
    mode: z
      .enum(["editing", "block_selection", "none"])
      .describe("editorFocused / blockSelected / neither, per the WhenContext this mirrors"),
    block_id: BlockId.nullable().describe("Focused block, or the selection anchor"),
    selected_block_ids: z.array(BlockId).describe("[] unless mode is block_selection"),
    cursor: z
      .object({
        anchor: z.number().int().describe("Offset into the focused block's content"),
        head: z.number().int().describe("Offset into the focused block's content"),
      })
      .nullable()
      .describe("Null unless mode is editing"),
  }),
  viewport: z.object({
    first_visible_block_id: BlockId.nullable(),
    last_visible_block_id: BlockId.nullable(),
    scroll_top: z.number().describe("Pixels scrolled from the top of the page's scroll container"),
  }),
  panels: z.object({
    sidebar_open: z.boolean(),
    active_view: z.string().describe('e.g. "page", "journals", "search", "tasks"'),
    dialog_open: z.string().nullable().describe('e.g. "command-palette", or null'),
  }),
  updated_at: z.string().describe("ISO-8601, when this snapshot was taken"),
});

export const WindowSummary = z.object({
  window_id: z.string(),
  device_id: z.string(),
  device_label: z.string().optional().describe("The device's own name, when known"),
  focused: z.boolean().describe("This window is the frontmost one on its device, if knowable"),
  page: WindowPage.nullable(),
  control_enabled: z
    .boolean()
    .describe(
      "The human has allowed command execution against this window; false means only reads work",
    ),
  connected_at: z.string().describe("ISO-8601"),
  last_active_at: z.string().describe("ISO-8601, last hello/focus update from this window"),
});

export const OtherWindow = z.object({
  window_id: z.string(),
  page: z.string().nullable().describe("The other window's page name, or null"),
});
