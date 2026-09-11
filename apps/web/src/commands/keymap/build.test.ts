import { describe, expect, it } from "vitest";
import type { Command, KeybindingsFile, ResolvedBinding } from "../types.js";
import { buildKeymap } from "./build.js";

function cmd(overrides: Partial<Command> & Pick<Command, "id" | "defaultKeys">): Command {
  return {
    title: overrides.id,
    category: "Block",
    run: () => {},
    ...overrides,
  };
}

// The R21/R64 secondary default (`Delete -> block.deleteSelected`) is unconditional in every
// `buildKeymap` call, independent of the `commands` array under test — strip it out so each test
// below can focus on the rows it's actually exercising.
function withoutSecondaryDefaults(rows: ResolvedBinding[]): ResolvedBinding[] {
  return rows.filter((r) => r.source !== "secondary");
}

const duplicate = cmd({
  id: "block.duplicate",
  defaultKeys: { mac: "Cmd+Shift+D", other: "Ctrl+Shift+D" },
  when: "editorFocused || blockSelected",
});

describe("buildKeymap — base defaults (R64 step 1)", () => {
  it("emits the mac slot on mac and the other slot elsewhere", () => {
    const mac = withoutSecondaryDefaults(buildKeymap([duplicate], [], { platform: "mac" }));
    expect(mac).toEqual([
      {
        key: "Cmd+Shift+D",
        command: "block.duplicate",
        when: duplicate.when,
        source: "base",
        order: 0,
      },
    ]);

    const win = withoutSecondaryDefaults(buildKeymap([duplicate], [], { platform: "windows" }));
    expect(win[0]?.key).toBe("Ctrl+Shift+D");
  });

  it("omits a command with no default key on the resolved platform slot", () => {
    const mobileOnlyToggle = cmd({ id: "task.toggleDone", defaultKeys: {} });
    expect(
      withoutSecondaryDefaults(buildKeymap([mobileOnlyToggle], [], { platform: "mac" })),
    ).toEqual([]);
  });

  it("omits a base row on ios/android with no hardware keyboard (R14)", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [], { platform: "ios", hasHardwareKeyboard: false }),
    );
    expect(rows).toEqual([]);
  });

  it("includes the mac-slot row on ios WITH a hardware keyboard", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [], { platform: "ios", hasHardwareKeyboard: true }),
    );
    expect(rows.map((r) => r.key)).toEqual(["Cmd+Shift+D"]);
  });

  it("includes the other-slot row on android WITH a hardware keyboard", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [], { platform: "android", hasHardwareKeyboard: true }),
    );
    expect(rows.map((r) => r.key)).toEqual(["Ctrl+Shift+D"]);
  });
});

describe("buildKeymap — secondary defaults (R21/R64 step 2)", () => {
  it("adds the Delete -> block.deleteSelected row unconditionally", () => {
    const rows = buildKeymap([], [], { platform: "mac" });
    expect(rows).toContainEqual({
      key: "Delete",
      command: "block.deleteSelected",
      when: "blockSelected",
      source: "secondary",
      order: 0,
    });
  });

  it("binds the VS Code palette chord as well as the command's own default", () => {
    const rows = buildKeymap([], [], { platform: "mac" });
    const palette = rows.filter((r) => r.command === "palette.open").map((r) => r.key);
    expect(palette).toContain("Cmd+Shift+P");
  });
});

describe("buildKeymap — user additions (R65)", () => {
  it("appends a new candidate row without removing the existing default", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [{ key: "Ctrl+D", command: "block.duplicate" }], {
        platform: "mac",
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(["Cmd+Shift+D", "Ctrl+D"]);
  });

  it("a Ctrl-spelled key (no Mod) applies literally on every platform, including mac (R63 worked example)", () => {
    const mac = buildKeymap([duplicate], [{ key: "Ctrl+D", command: "block.duplicate" }], {
      platform: "mac",
    });
    const win = buildKeymap([duplicate], [{ key: "Ctrl+D", command: "block.duplicate" }], {
      platform: "windows",
    });
    expect(mac.filter((r) => r.command === "block.duplicate").at(-1)?.key).toBe("Ctrl+D");
    expect(win.filter((r) => r.command === "block.duplicate").at(-1)?.key).toBe("Ctrl+D");
  });

  it("a Cmd-spelled key (no Mod) applies only on mac", () => {
    const withCmd: KeybindingsFile = [{ key: "Cmd+D", command: "block.duplicate" }];
    const mac = buildKeymap([duplicate], withCmd, { platform: "mac" });
    const win = buildKeymap([duplicate], withCmd, { platform: "windows" });
    expect(mac.some((r) => r.key === "Cmd+D")).toBe(true);
    expect(win.some((r) => r.key === "Cmd+D")).toBe(false);
  });

  it("a Mod-spelled key resolves per-platform", () => {
    const withMod: KeybindingsFile = [{ key: "Mod+Alt+D", command: "block.duplicate" }];
    expect(
      buildKeymap([duplicate], withMod, { platform: "mac" })
        .filter((r) => r.command === "block.duplicate")
        .at(-1)?.key,
    ).toBe("Cmd+Alt+D");
    expect(
      buildKeymap([duplicate], withMod, { platform: "windows" })
        .filter((r) => r.command === "block.duplicate")
        .at(-1)?.key,
    ).toBe("Ctrl+Alt+D");
  });

  it("a platform-pair object picks the slot matching the current platform", () => {
    const rows: KeybindingsFile = [
      { key: { mac: "Cmd+J", other: "Ctrl+Alt+J" }, command: "nav.todayJournal" },
    ];
    expect(withoutSecondaryDefaults(buildKeymap([], rows, { platform: "mac" }))[0]?.key).toBe(
      "Cmd+J",
    );
    expect(withoutSecondaryDefaults(buildKeymap([], rows, { platform: "linux" }))[0]?.key).toBe(
      "Ctrl+Alt+J",
    );
  });

  it("an omitted `when` inherits the target command's own `when`, not 'always'", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [{ key: "Ctrl+D", command: "block.duplicate" }], {
        platform: "mac",
      }),
    );
    expect(rows.at(-1)?.when).toBe(duplicate.when);
  });

  it("an explicit `when` on the user row replaces the command's own `when` for that binding only", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap(
        [duplicate],
        [{ key: "Ctrl+D", command: "block.duplicate", when: "blockSelected" }],
        {
          platform: "mac",
        },
      ),
    );
    expect(rows.at(-1)?.when).toBe("blockSelected");
    // The base default row is untouched.
    expect(rows[0]?.when).toBe(duplicate.when);
  });

  it("a two-step Mod chord resolves per platform", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([], [{ key: "Mod+K Mod+S", command: "app.openSettings" }], { platform: "mac" }),
    );
    expect(rows[0]?.key).toBe("Cmd+K Cmd+S");
  });
});

describe("buildKeymap — user removals (R66)", () => {
  it("removes every row for that key+command regardless of when, when the removal omits when", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap([duplicate], [{ key: "Cmd+Shift+D", command: "-block.duplicate" }], {
        platform: "mac",
      }),
    );
    expect(rows).toEqual([]);
  });

  it("removes only the exact-when row when the removal row specifies when", () => {
    const rows = withoutSecondaryDefaults(
      buildKeymap(
        [duplicate],
        [
          { key: "Cmd+Shift+D", command: "block.duplicate", when: "blockSelected" },
          { key: "Cmd+Shift+D", command: "-block.duplicate", when: "blockSelected" },
        ],
        { platform: "mac" },
      ),
    );
    // Only the base default (when: editorFocused || blockSelected) remains; the added
    // blockSelected-only row was removed by its exact-when match.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.when).toBe(duplicate.when);
  });

  it("a removal row with no matching row is a no-op, not an error", () => {
    expect(() =>
      buildKeymap([], [{ key: "Cmd+Z", command: "-nonexistent.command" }], { platform: "mac" }),
    ).not.toThrow();
    expect(
      withoutSecondaryDefaults(
        buildKeymap([], [{ key: "Cmd+Z", command: "-nonexistent.command" }], { platform: "mac" }),
      ),
    ).toEqual([]);
  });

  it("removes only rows matching this platform's resolved key (a Cmd-only removal leaves other platforms' row intact)", () => {
    const both = cmd({ id: "x.y", defaultKeys: { mac: "Cmd+Enter", other: "Ctrl+Enter" } });
    const macRows = withoutSecondaryDefaults(
      buildKeymap([both], [{ key: "Cmd+Enter", command: "-x.y" }], { platform: "mac" }),
    );
    const winRows = withoutSecondaryDefaults(
      buildKeymap([both], [{ key: "Cmd+Enter", command: "-x.y" }], { platform: "windows" }),
    );
    expect(macRows).toEqual([]);
    expect(winRows).toHaveLength(1); // Cmd+Enter removal never applied on windows in the first place.
  });
});

describe("buildKeymap — the spec's worked keybindings.json example", () => {
  it("matches the documented row-by-row behavior", () => {
    const commands: Command[] = [
      duplicate,
      cmd({ id: "nav.todayJournal", defaultKeys: { mac: "Cmd+J", other: "Ctrl+J" } }),
      cmd({ id: "app.openSettings", defaultKeys: { mac: "Cmd+,", other: "Ctrl+," } }),
      cmd({ id: "task.setMarkerDone", defaultKeys: {} }),
    ];
    const userRows: KeybindingsFile = [
      { key: "Mod+Shift+D", command: "-block.duplicate" },
      { key: "Ctrl+D", command: "block.duplicate" },
      { key: { mac: "Cmd+J", other: "Ctrl+Alt+J" }, command: "nav.todayJournal" },
      { key: "Mod+K Mod+S", command: "app.openSettings" },
      { key: "Mod+Shift+Enter", command: "task.setMarkerDone", when: "editorFocused" },
    ];

    const mac = buildKeymap(commands, userRows, { platform: "mac" });
    const macKeys = mac.map((r) => `${r.key}:${r.command}`);
    // Row 1 removed the mac default Cmd+Shift+D for block.duplicate.
    expect(macKeys).not.toContain("Cmd+Shift+D:block.duplicate");
    // Row 2's Ctrl+D applies on mac too.
    expect(macKeys).toContain("Ctrl+D:block.duplicate");
    // Row 3 gives nav.todayJournal Cmd+J on mac (same as its own default, but from the user row).
    expect(mac.filter((r) => r.command === "nav.todayJournal").map((r) => r.key)).toContain(
      "Cmd+J",
    );
    // Row 4 coexists alongside the default Cmd+,.
    expect(macKeys).toContain("Cmd+K Cmd+S:app.openSettings");
    expect(macKeys).toContain("Cmd+,:app.openSettings");
    // Row 5 adds a brand-new binding, narrowed to editorFocused.
    const doneRow = mac.find((r) => r.command === "task.setMarkerDone");
    expect(doneRow?.key).toBe("Cmd+Shift+Enter");
    expect(doneRow?.when).toBe("editorFocused");

    const win = buildKeymap(commands, userRows, { platform: "windows" });
    // Row 3 gives Windows a DIFFERENT key than the default Ctrl+J.
    expect(win.filter((r) => r.command === "nav.todayJournal").map((r) => r.key)).toEqual([
      "Ctrl+J",
      "Ctrl+Alt+J",
    ]);
  });
});
