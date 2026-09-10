/** `nav.openPage`/`nav.revealBlock` (ADR 015 §2.4) — the one gap the live-UI-control channel
 * needed: jumping straight to a known page/block with no picker. */
import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeNavigationHost } from "../hosts/nav-host.js";
import { createPaletteController } from "../palette/palette-controller.js";
import { createNavCommands } from "./nav.js";

function setup() {
  const navigation = createFakeNavigationHost();
  const editor = createFakeEditorHost();
  const palette = createPaletteController();
  const commands = createNavCommands({ navigation, palette, editor });
  return { navigation, commands };
}

describe("nav.openPage", () => {
  it("has no default keybinding and is always enabled (when: 'true')", () => {
    const { commands } = setup();
    const cmd = commands.find((c) => c.id === "nav.openPage");
    expect(cmd?.defaultKeys).toEqual({});
    expect(cmd?.when).toBe("true");
  });

  it("calls navigation.openPageByRef with the given page and blockId", async () => {
    const { commands, navigation } = setup();
    const cmd = commands.find((c) => c.id === "nav.openPage");
    // biome-ignore lint/suspicious/noExplicitAny: test-only minimal CommandContext stub
    await cmd?.run({ args: { page: "Projects/Aurora", blockId: "1k7f3qa2m9xzr7" } } as any);
    expect(navigation.calls).toEqual([
      { method: "openPageByRef", arg: { ref: "Projects/Aurora", blockId: "1k7f3qa2m9xzr7" } },
    ]);
  });

  it("does nothing when no page arg is given (never navigates blindly)", async () => {
    const { commands, navigation } = setup();
    const cmd = commands.find((c) => c.id === "nav.openPage");
    // biome-ignore lint/suspicious/noExplicitAny: test-only minimal CommandContext stub
    await cmd?.run({ args: undefined } as any);
    expect(navigation.calls).toEqual([]);
  });
});

describe("nav.revealBlock", () => {
  it("has no default keybinding and is always enabled", () => {
    const { commands } = setup();
    const cmd = commands.find((c) => c.id === "nav.revealBlock");
    expect(cmd?.defaultKeys).toEqual({});
    expect(cmd?.when).toBe("true");
  });

  it("calls navigation.revealBlock with the given blockId", async () => {
    const { commands, navigation } = setup();
    const cmd = commands.find((c) => c.id === "nav.revealBlock");
    // biome-ignore lint/suspicious/noExplicitAny: test-only minimal CommandContext stub
    await cmd?.run({ args: { blockId: "1k7f3qa2m9xzr7" } } as any);
    expect(navigation.calls).toEqual([{ method: "revealBlock", arg: "1k7f3qa2m9xzr7" }]);
  });
});
