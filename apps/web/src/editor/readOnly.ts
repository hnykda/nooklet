/**
 * The read-only page lock (audit §2 #17): a page whose properties say `read-only:: true` renders
 * as usual but its blocks never enter edit mode, cannot be selected, and refuse the writes a click
 * or a gesture would otherwise make (task marker, drag, swipe) with a short notice.
 *
 * What it is NOT: a permission. It is how this client chooses to present a page. The HTTP API,
 * MCP tools, sync from another device, and the markdown mirror are not bound by it, and an agent
 * can edit a locked page like any other (docs/spec/markdown-grammar.md OUT-21a). It guards against
 * a stray keystroke, not against anyone.
 *
 * Deliberately still allowed on a locked page: collapsing and expanding (reading a long page needs
 * it; it is view state, even though it syncs), selecting TEXT to copy it, the context menu's
 * timestamps, and the page's own properties — which is where the lock is lifted.
 */

export const READ_ONLY_PROPERTY = "read-only";

/** Only an explicit `true` locks, in any case and with stray spaces. Anything else — `false`,
 * `no`, an empty value — leaves the page editable: a lock nobody meant to set is worse than none. */
export function isReadOnlyValue(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() === "true";
}

export const READ_ONLY_NOTICE =
  "This page is read-only. Remove read-only:: true from its properties to edit it.";
