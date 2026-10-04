/** Where a fixed-position menu goes: under `anchor`, as wide as a phone drawer allows, and no
 * taller than the space left below it (it scrolls past that). Shared by the graph menus
 * (`GraphSwitcher.tsx`, `DesktopGraphMenu.tsx`). */
export function placeUnder(
  anchor: { left: number; bottom: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.min(288, viewport.width - 2 * margin);
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  const top = anchor.bottom + 4;
  return { left, top, width, maxHeight: Math.max(160, viewport.height - top - margin) };
}
