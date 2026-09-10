/**
 * Imperative open/close/toggle control for `<CommandPalette>`, shared by the `palette.open`
 * (R40) and `nav.switchPage` (R41) commands and the component itself. Kept as a plain
 * signal-backed object (not JSX) so the commands in `registrations/nav.ts` can depend on it
 * without importing solid-js's component runtime.
 */
import { createSignal } from "solid-js";
import type { PaletteMode, PaletteState } from "../types.js";

export interface PaletteController {
  state(): PaletteState;
  isOpen(): boolean;
  /** Open in `mode` (default "mixed"), resetting the query. Re-opens/refocuses if already open. */
  open(mode?: PaletteMode): void;
  close(): void;
  /** R40: pressing Cmd/Ctrl+K again while already open closes it. */
  toggle(mode?: PaletteMode): void;
  setQuery(query: string): void;
  setMode(mode: PaletteMode): void;
}

export function createPaletteController(): PaletteController {
  const [open, setOpen] = createSignal(false);
  const [state, setState] = createSignal<PaletteState>({ mode: "mixed", query: "" });

  return {
    state,
    isOpen: open,
    open(mode = "mixed") {
      setState({ mode, query: "" });
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle(mode = "mixed") {
      if (open()) {
        setOpen(false);
        return;
      }
      setState({ mode, query: "" });
      setOpen(true);
    },
    setQuery(query) {
      setState((s) => ({ ...s, query }));
    },
    setMode(mode) {
      setState((s) => ({ ...s, mode }));
    },
  };
}
