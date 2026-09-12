/**
 * Generates `docs/wiki/pages/Keyboard shortcuts.md` from the real command registrations.
 *
 * A hand-written shortcut list is wrong the first time a binding changes, so this runs the same
 * `createCoreCommands` the app runs (with the fake hosts the unit tests use) and writes what it
 * finds. Secondary default bindings come from the keymap module, exactly as the app's own
 * shortcuts dialog assembles them (`apps/web/src/shell/HelpMenu.tsx`).
 *
 * The registrations import client modules that read `import.meta.env` at load time, which only
 * exists under Vite — so the modules are loaded through Vite's SSR module loader rather than
 * plain Node. `vite` is resolved from `apps/web`, so this runs from any directory:
 *
 *   node docs/wiki/tools/generate-shortcuts.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(here, "..", "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const OUT = join(here, "..", "pages", "Keyboard shortcuts.md");

async function loadVite() {
  const require = createRequire(join(webRoot, "package.json"));
  const pkgPath = require.resolve("vite/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const dot = pkg.exports?.["."];
  const entry =
    (typeof dot === "string" ? dot : (dot?.import?.default ?? dot?.default)) ??
    pkg.module ??
    pkg.main;
  return import(pathToFileURL(join(dirname(pkgPath), entry)).href);
}

const vite = await loadVite();
const server = await vite.createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom",
  logLevel: "error",
});

let commands;
let SECONDARY_DEFAULTS;
try {
  const registrations = await server.ssrLoadModule("/src/commands/registrations/index.ts");
  const hosts = await server.ssrLoadModule("/src/commands/hosts/index.ts");
  const palette = await server.ssrLoadModule("/src/commands/palette/palette-controller.ts");
  const datePicker = await server.ssrLoadModule("/src/commands/registrations/date-picker-host.ts");
  const keymap = await server.ssrLoadModule("/src/commands/keymap/secondary-defaults.ts");
  SECONDARY_DEFAULTS = keymap.SECONDARY_DEFAULTS;
  commands = registrations.createCoreCommands({
    editor: hosts.createFakeEditorHost(),
    navigation: hosts.createFakeNavigationHost(),
    app: hosts.createFakeAppHost(),
    palette: palette.createPaletteController(),
    datePicker: datePicker.createFakeDatePickerHost(),
  });
} finally {
  await server.close();
}

const today = new Date().toISOString().slice(0, 10);

/** Table cells: `|` is a cell separator, so `||` in a `when` clause must be escaped. */
function cell(s) {
  return (s ?? "—").replace(/\|/g, "\\|");
}

const secondaryByCommand = new Map();
for (const row of SECONDARY_DEFAULTS) {
  const list = secondaryByCommand.get(row.command) ?? [];
  list.push(row.key);
  secondaryByCommand.set(row.command, list);
}

/** Category order matches the spec's section order (E.1–E.6), not alphabetical. */
const CATEGORY_ORDER = ["Block", "Task", "Navigation", "Formatting", "Insert", "App"];
const byCategory = new Map();
for (const c of commands) {
  const list = byCategory.get(c.category) ?? [];
  list.push(c);
  byCategory.set(c.category, list);
}
const categories = [
  ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
  ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
];

const hasKey = (c) => Boolean(c.defaultKeys.mac || c.defaultKeys.other);
const bound = commands.filter(hasKey);

const lines = [];
lines.push("type:: reference");
lines.push(
  "summary:: Every command nooklet registers, with its default keys on macOS and on Windows/Linux. Generated from the code, not written by hand.",
);
lines.push("tags:: reference");
lines.push("");
lines.push(
  `- **Generated on ${today}** from \`apps/web/src/commands/registrations/*.ts\` by \`docs/wiki/tools/generate-shortcuts.mjs\`. Do not edit this page by hand; re-run the generator (\`node docs/wiki/tools/generate-shortcuts.mjs\`).`,
);
lines.push(
  `- ${commands.length} commands are registered; ${bound.length} have a default key. The same list, limited to bound keys, is in the app under the \`?\` button in the corner → Keyboard shortcuts, built from the live keymap.`,
);
lines.push(
  '- "When" is the condition under which the key does this ([[Concepts]] explains `editorFocused` and `blockSelected`). One key can do different things in different states: Enter splits a block while editing and starts editing a selected block.',
);
lines.push(
  "- Keys are meant to be rebindable through a user-editable `keybindings.json` (ADR 009, `docs/spec/commands-and-keymap.md` §I). The keymap merge rules exist in `apps/web/src/commands/keymap/`; a settings screen for editing them is not built.",
);

for (const category of categories) {
  const list = (byCategory.get(category) ?? []).filter(hasKey);
  if (list.length === 0) continue;
  lines.push(`- ## ${category}`);
  lines.push("- | Command | macOS | Windows / Linux | When |");
  lines.push("  |---|---|---|---|");
  for (const c of list) {
    const extra = secondaryByCommand.get(c.id);
    const mac = extra
      ? `${cell(c.defaultKeys.mac)}, ${cell(extra.find((k) => k.startsWith("Cmd")) ?? extra[0])}`
      : cell(c.defaultKeys.mac);
    const other = extra
      ? `${cell(c.defaultKeys.other)}, ${cell(extra.find((k) => k.startsWith("Ctrl")) ?? extra[0])}`
      : cell(c.defaultKeys.other);
    lines.push(
      `  | ${cell(c.title)} (\`${c.id}\`) | ${mac} | ${other} | \`${cell(c.when ?? "true")}\` |`,
    );
  }
}

lines.push("- ## Secondary bindings");
lines.push(
  "- A few keys are bound on top of a command's own default (`apps/web/src/commands/keymap/secondary-defaults.ts`):",
);
for (const row of SECONDARY_DEFAULTS) {
  lines.push(`  - \`${row.key}\` → \`${row.command}\`${row.when ? ` when \`${row.when}\`` : ""}`);
}

lines.push("- ## Commands without a default key");
lines.push(
  "- Reachable from the command palette (Cmd/Ctrl+K), the slash menu (`/` at the start of a line), the block context menu, or the phone toolbar. Listed so the palette holds no surprises.",
);
for (const category of categories) {
  const list = (byCategory.get(category) ?? []).filter((c) => !hasKey(c));
  if (list.length === 0) continue;
  lines.push(`  - **${category}**: ${list.map((c) => `${c.title} (\`${c.id}\`)`).join(" · ")}`);
}

writeFileSync(OUT, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`wrote ${OUT}: ${commands.length} commands, ${bound.length} bound\n`);
