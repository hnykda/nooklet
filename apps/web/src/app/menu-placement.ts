/**
 * Where a pointer-anchored menu goes so all of it is on screen (B-351).
 *
 * The block context menu used to clamp its top to `innerHeight - 320`, a guess at its own height
 * that went stale the moment entries were added: at ~510px, a right-click in the lower half of the
 * window put the last entries below the bottom edge. This takes the menu's MEASURED size instead,
 * so the next entry added cannot reintroduce it.
 *
 * Vertical: open downward from the pointer when that fits, else upward (the menu's bottom at the
 * pointer, the way native menus flip), else pinned to the bottom margin — and when even the whole
 * viewport is too short, pinned to the top margin, where the menu's own `max-height` lets it
 * scroll. Horizontal: from the pointer rightward, shifted left as far as needed.
 *
 * `viewport.height` is the USABLE height, not the window's: on a phone the keyboard toolbar is
 * fixed over the bottom of the window while editing (and a long-press starts editing), and a menu
 * footer under it is as hidden as one below the edge. `usableViewport` measures that.
 */

export interface MenuPlacement {
  left: number;
  top: number;
  /** The tallest the menu may be and still fit; past it the menu scrolls. */
  maxHeight: number;
}

export function placeMenu(
  pointer: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): MenuPlacement {
  const maxLeft = viewport.width - menu.width - margin;
  const left = Math.max(margin, Math.min(pointer.x, maxLeft));

  let top: number;
  if (pointer.y + menu.height <= viewport.height - margin) top = pointer.y;
  else if (pointer.y - menu.height >= margin) top = pointer.y - menu.height;
  else top = viewport.height - menu.height - margin;
  return { left, top: Math.max(margin, top), maxHeight: Math.max(0, viewport.height - 2 * margin) };
}

/** The window, less whatever fixed chrome covers its bottom edge: the mobile keyboard toolbar
 * (`commands/styles.css` `.cmd-toolbar`, `bottom: var(--kb)`), whose top is therefore also the top
 * of the on-screen keyboard when one is open. */
export function usableViewport(): { width: number; height: number } {
  const toolbarTop = document.querySelector(".cmd-toolbar")?.getBoundingClientRect().top;
  const height =
    toolbarTop !== undefined && toolbarTop > 0
      ? Math.min(window.innerHeight, toolbarTop)
      : window.innerHeight;
  return { width: window.innerWidth, height };
}
