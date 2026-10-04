/**
 * The icon for each task state, one table for every place a task is drawn (outliner row, shelf,
 * journal agenda, query results, read-only outlines, the Tasks view).
 *
 * B-651: these were text glyphs (`☐ ◐ ◔ ☑ ☒`). The empty box is the one users see most, and on the
 * owner's iPhone it read as a missing-glyph box ("tofu") rather than a checkbox: a bare rectangle
 * at text size, drawn by whatever font had it, at a different weight from the text around it.
 * Lucide's squares are drawn the same everywhere, with rounded corners and the stroke weight of
 * every other icon in the app, so the empty one reads as a control. They inherit colour from the
 * row (`currentColor`), so the per-state colours in `editor.css` still apply.
 */
// One file per icon, not the `lucide-solid` barrel (B-140): every surface that draws a task pulls
// this in, and the barrel is ~1,500 modules.
import Square from "lucide-solid/icons/square";
import SquareCheck from "lucide-solid/icons/square-check";
import SquareDot from "lucide-solid/icons/square-dot";
import SquarePause from "lucide-solid/icons/square-pause";
import SquareX from "lucide-solid/icons/square-x";
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

const ICONS: Record<string, typeof Square> = {
  TODO: Square,
  LATER: Square,
  NOW: SquareDot,
  DOING: SquareDot,
  WAITING: SquarePause,
  DONE: SquareCheck,
  CANCELED: SquareX,
};

/** `aria-checked` for a marker drawn as a checkbox: in progress is "mixed", the ARIA state made
 * for "partly done". */
export function markerChecked(marker: string): "true" | "false" | "mixed" {
  if (marker === "DONE" || marker === "CANCELED") return "true";
  if (marker === "NOW" || marker === "DOING") return "mixed";
  return "false";
}

export function TaskMarkerIcon(props: { marker: string }): JSX.Element {
  return (
    <Dynamic
      component={ICONS[props.marker] ?? Square}
      class="task-marker-icon"
      data-marker-icon={props.marker}
      // Sized from the text, not in px, so it follows Settings → text size and every surface's
      // own font size.
      size="1.1em"
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}
