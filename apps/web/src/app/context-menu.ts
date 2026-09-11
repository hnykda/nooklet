/**
 * The channel a right-clicked block uses to ask for a context menu.
 *
 * Same shape and the same reason as `./editor-host.ts`: the menu has to be rendered by
 * `CommandLayer`, because only there does `useCommands()` resolve and only there is there a
 * command context to execute against — but the right-click happens deep inside a `BlockRowView`,
 * which must stay pure presentation. A module-level signal is the seam between them.
 */

import { createSignal } from "solid-js";

export interface BlockMenuRequest {
  blockId: string;
  x: number;
  y: number;
}

const [request, setRequest] = createSignal<BlockMenuRequest | null>(null);

/** Ask for the block context menu at viewport coordinates `x`/`y`. */
export function openBlockMenu(req: BlockMenuRequest): void {
  setRequest(req);
}

export function closeBlockMenu(): void {
  setRequest(null);
}

export const blockMenuRequest = request;
