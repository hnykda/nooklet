/**
 * "Every row the palette shows does something" — for the palette a person sees first, with nothing
 * focused (the exposure audit's §1.9 row: five of its 18 rows did nothing when chosen).
 *
 * Each command the palette would list in that state is run exactly as a palette row runs it — no
 * `args` — against the fake hosts, and must reach at least one of them. A command that does
 * nothing without a payload must say so with `requiresArgs`, which keeps it out of the palette
 * (B-105). This cannot prove the REAL host behind a delegate works (that is what the e2e specs are
 * for: `e2e/tests/commands.spec.ts`), but it does catch a registration that is dead on arrival.
 */
import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeAppHost, createFakeNavigationHost } from "../hosts/nav-host.js";
import { createFakeStore } from "../hosts/store.js";
import { createPaletteController } from "../palette/palette-controller.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { matchesWhen } from "../when/index.js";
import { createFakeDatePickerHost } from "./date-picker-host.js";
import { createCoreCommands } from "./index.js";
import { createFakeRefactorHost } from "./refactor.js";
import { createFakeShelfHost } from "./shelf.js";

function setup() {
  const editor = createFakeEditorHost(undefined);
  const navigation = createFakeNavigationHost();
  const app = createFakeAppHost();
  const palette = createPaletteController();
  const datePicker = createFakeDatePickerHost();
  const refactor = createFakeRefactorHost({ page: "Current", pick: "Target" });
  const shelf = createFakeShelfHost();
  const commands = createCoreCommands({
    editor,
    navigation,
    app,
    palette,
    datePicker,
    refactor: refactor.host,
    shelf,
  });
  const effects = (): number =>
    editor.structuralCalls.length +
    navigation.calls.length +
    app.calls.length +
    datePicker.calls.length +
    refactor.calls.length +
    shelf.calls.length +
    (palette.isOpen() ? 1 : 0);
  return { commands, effects, palette };
}

const NOTHING_FOCUSED: Omit<CommandContext, "exec" | "args"> = {
  ...DEFAULT_WHEN_CONTEXT,
  focusedBlockId: null,
  selectedBlockIds: [],
  surface: null,
  store: createFakeStore(),
};

describe("palette rows with nothing focused", () => {
  const { commands } = setup();
  const listed = commands.filter((c) => matchesWhen(c.when, NOTHING_FOCUSED));

  it.each(listed.map((c) => [c.id, c.requiresArgs === true] as const))(
    "%s: does something when chosen, or is requiresArgs and never listed",
    async (id, requiresArgs) => {
      const fresh = setup();
      const command = fresh.commands.find((c) => c.id === id);
      const ctx: CommandContext = { ...NOTHING_FOCUSED, exec: async () => {} };
      await command?.run(ctx);
      if (requiresArgs) expect(fresh.effects()).toBe(0);
      else expect(fresh.effects(), `${id} ran with no args and reached no host`).toBeGreaterThan(0);
    },
  );

  it("nav.openPage and nav.revealBlock are requiresArgs (B-105)", () => {
    for (const id of ["nav.openPage", "nav.revealBlock"]) {
      expect(commands.find((c) => c.id === id)?.requiresArgs).toBe(true);
    }
  });
});
