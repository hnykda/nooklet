/** Aggregates every core command this package registers (BUILD item 7). */
import type { EditorHost } from "../hosts/editor-host.js";
import type { AppHost, NavigationHost } from "../hosts/nav-host.js";
import type { PaletteController } from "../palette/palette-controller.js";
import type { Command } from "../types.js";
import { createAppCommands } from "./app.js";
import type { DatePickerHost } from "./date-picker-host.js";
import { createFormatCommands } from "./format.js";
import { createInsertCommands } from "./insert.js";
import { createNavCommands } from "./nav.js";
import { createStructuralCommands } from "./structural.js";
import { createTaskCommands } from "./task.js";
import { createTemplateCommands } from "./templates.js";

export interface CoreCommandDeps {
  editor: EditorHost;
  navigation: NavigationHost;
  app: AppHost;
  palette: PaletteController;
  datePicker: DatePickerHost;
  now?: () => number;
}

/** Every command core registers at startup (E.1-E.6 of the spec). Structural `Block`-category
 * commands and `edit.paste` are thin delegates to `deps.editor`; navigation/app-level/formatting/
 * insert/task-state commands have real, spec-faithful logic here. */
export function createCoreCommands(deps: CoreCommandDeps): Command[] {
  return [
    ...createStructuralCommands({ editor: deps.editor }),
    ...createTaskCommands({ datePicker: deps.datePicker }),
    ...createNavCommands({
      navigation: deps.navigation,
      palette: deps.palette,
      editor: deps.editor,
    }),
    ...createFormatCommands({ editor: deps.editor }),
    ...createInsertCommands({ editor: deps.editor, now: deps.now }),
    ...createTemplateCommands({ editor: deps.editor }),
    ...createAppCommands({ app: deps.app }),
  ];
}

export { createAppCommands } from "./app.js";
export { createFakeDatePickerHost, type DatePickerHost } from "./date-picker-host.js";
export { createFormatCommands } from "./format.js";
export { createInsertCommands } from "./insert.js";
export { createNavCommands } from "./nav.js";
export { createStructuralCommands } from "./structural.js";
export { createTaskCommands } from "./task.js";
export {
  type CompletionResult,
  completeTask,
  nextCycleMarker,
  type TaskSnapshot,
} from "./task-logic.js";
export { createTemplateCommands } from "./templates.js";
