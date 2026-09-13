/**
 * `docs/spec/commands-and-keymap.md` §E's tables against the commands core actually registers.
 *
 * The tables drifted without anyone noticing (B-106): commands were added in code and never in the
 * spec, and a reader of the spec could not find "Open page" or the WAITING/CANCELED markers. A
 * hand-kept table is wrong the first time a binding changes, so this test keeps it honest: every
 * registered command has a row, every row a command, and the title, keys and `when` agree.
 *
 * If this fails because you added or changed a command, update the row in the spec — that is the
 * point. The wiki's shortcut page is generated (`docs/wiki/tools/generate-shortcuts.mjs`); the spec
 * is not, because its tables sit between normative prose rules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeAppHost, createFakeNavigationHost } from "../hosts/nav-host.js";
import { createPaletteController } from "../palette/palette-controller.js";
import { SLASH_ITEMS } from "../slash/items.js";
import { createFakeDatePickerHost } from "./date-picker-host.js";
import { createCoreCommands } from "./index.js";
import { createFakePageActionsHost } from "./page-actions.js";
import { createFakePageFindHost } from "./page-find.js";
import { createFakeRandomPageHost } from "./random-page.js";
import { createFakeRefactorHost } from "./refactor.js";
import { createFakeShelfHost } from "./shelf.js";

const SPEC = new URL("../../../../../docs/spec/commands-and-keymap.md", import.meta.url);

interface SpecRow {
  /** From the table's `####` heading: "(category `Block`)". */
  category: string;
  id: string;
  title: string;
  mac: string | undefined;
  other: string | undefined;
  when: string;
}

/** Rows of every table in §E: `| \`id\` | title | mac | other | when |`. Cells are split on
 * unescaped pipes, since a `when` like `editorFocused \|\| blockSelected` escapes its own. */
function specRows(markdown: string): SpecRow[] {
  const start = markdown.indexOf("### E. Command reference tables");
  const end = markdown.indexOf("### F. ", start);
  const section = markdown.slice(start, end);
  const rows: SpecRow[] = [];
  let category = "";
  for (const line of section.split("\n")) {
    if (line.startsWith("#### ")) category = /categor(?:y|ies) `([^`]+)`/.exec(line)?.[1] ?? "";
    if (!line.startsWith("| `")) continue;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
    const [id, title, mac, other, when] = cells;
    const unwrap = (s: string | undefined): string => (s ?? "").replace(/^`|`$/g, "");
    const key = (s: string | undefined): string | undefined =>
      s === "—" || s === undefined ? undefined : s;
    rows.push({
      category,
      id: unwrap(id),
      title: title ?? "",
      mac: key(mac),
      other: key(other),
      when: unwrap(when),
    });
  }
  return rows;
}

function registered() {
  return createCoreCommands({
    editor: createFakeEditorHost(),
    navigation: createFakeNavigationHost(),
    app: createFakeAppHost(),
    palette: createPaletteController(),
    datePicker: createFakeDatePickerHost(),
    refactor: createFakeRefactorHost().host,
    shelf: createFakeShelfHost(),
    // Every optional host, so every command the app can register is checked against the spec.
    pageFind: createFakePageFindHost(),
    randomPage: createFakeRandomPageHost(),
    pageActions: createFakePageActionsHost().host,
  });
}

describe("spec §E tables match the registered commands (B-106)", () => {
  const rows = specRows(readFileSync(SPEC, "utf8"));
  const commands = registered();

  it("parses the tables at all", () => {
    expect(rows.length).toBeGreaterThan(70);
  });

  it("every registered command has a row, and every row a command", () => {
    const inSpec = new Set(rows.map((r) => r.id));
    const inCode = new Set(commands.map((c) => c.id));
    expect(
      [...inCode].filter((id) => !inSpec.has(id)),
      "registered but not in the spec",
    ).toEqual([]);
    expect(
      [...inSpec].filter((id) => !inCode.has(id)),
      "in the spec but not registered",
    ).toEqual([]);
    expect(rows.length, "a command listed twice in the spec").toBe(inSpec.size);
  });

  it("sections (categories), titles, default keys and when clauses agree", () => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const mismatches: string[] = [];
    for (const c of commands) {
      const row = byId.get(c.id);
      if (!row) continue;
      const code: SpecRow = {
        category: c.category,
        id: c.id,
        title: c.title,
        mac: c.defaultKeys.mac,
        other: c.defaultKeys.other,
        when: c.when ?? "true",
      };
      for (const field of ["category", "title", "mac", "other", "when"] as const) {
        if (row[field] !== code[field]) {
          mismatches.push(`${c.id}.${field}: spec ${row[field]} ≠ code ${code[field]}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/** Keywords are code spans where they are markup (`` `[[` ``, ```` ```query ````) and bare
 * otherwise — including a bare ```, which is nothing but backticks and must stay as it is. */
function unquote(keyword: string): string {
  const k = keyword.trim();
  if (/^`+$/.test(k)) return k;
  return /^(`+) ?(.+?) ?\1$/.exec(k)?.[2] ?? k;
}

/** R54's slash table: `| Label | \`command\` | keywords |`, in default order. */
function slashRows(
  markdown: string,
): Array<{ label: string; command: string; keywords: string[] }> {
  const start = markdown.indexOf("**R54.**");
  const end = markdown.indexOf("**R55.**", start);
  const out: Array<{ label: string; command: string; keywords: string[] }> = [];
  for (const line of markdown.slice(start, end).split("\n")) {
    const m = /^\| ([^|]+) \| `([^`]+)` \| (.+) \|$/.exec(line);
    if (!m) continue;
    const [, label, command, keywords] = m;
    out.push({
      label: (label ?? "").trim(),
      command: command ?? "",
      keywords: (keywords ?? "").split(", ").map(unquote),
    });
  }
  return out;
}

describe("spec R54's slash table matches SLASH_ITEMS (B-106)", () => {
  it("same items, same order, same keywords", () => {
    const rows = slashRows(readFileSync(SPEC, "utf8"));
    expect(rows).toEqual(
      SLASH_ITEMS.map((i) => ({ label: i.label, command: i.command, keywords: [...i.keywords] })),
    );
  });
});
