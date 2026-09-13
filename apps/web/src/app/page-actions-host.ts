/**
 * The real `PageActionsHost` (`../commands/registrations/page-actions.ts`): page names resolved
 * against the local replica, then handed to the effects in `./page-actions.ts`.
 */

import type { PageActionsHost } from "../commands/registrations/page-actions.js";
import { deletePage, findPageToDelete, previewPageDelete } from "../data/page-delete.js";
import { findPageIdByName } from "../data/page-export.js";
import { confirmDialog } from "./confirm-dialog.js";
import {
  announce,
  copyPageMarkdown,
  exportPageMarkdown,
  printPage,
  togglePageFavorite,
} from "./page-actions.js";
import { deletePageWithConfirm } from "./page-delete.js";
import { currentPageNameFromPath } from "./refactor-host.js";

export function createPageActionsHost(deps: {
  closePalette: () => void;
  navigate: (path: string) => void;
}): PageActionsHost {
  return {
    currentPageName: () => currentPageNameFromPath(window.location.pathname),
    async copyPageMarkdown(page) {
      // The lookup is passed as a promise, NOT awaited here: the clipboard write has to start in
      // this same tick (`./page-actions.ts#copyPageMarkdown`).
      await copyPageMarkdown(findPageIdByName(page));
    },
    async exportPageMarkdown(page) {
      await exportPageMarkdown(findPageIdByName(page));
    },
    async toggleFavorite(page) {
      await togglePageFavorite(findPageIdByName(page));
    },
    printPage() {
      // From the palette: close it first, or the dialog opens over a palette that is still on
      // screen (the print stylesheet hides it on paper, but not behind the dialog). A no-op from
      // the title row, where the palette is not open.
      deps.closePalette();
      printPage();
    },
    async deletePage(page) {
      // The palette waits for a command before closing; the dialog must not open under it.
      deps.closePalette();
      await deletePageWithConfirm(page, {
        findPage: findPageToDelete,
        preview: previewPageDelete,
        confirm: confirmDialog,
        remove: deletePage,
        navigate: deps.navigate,
        notify: announce,
      });
    },
  };
}
