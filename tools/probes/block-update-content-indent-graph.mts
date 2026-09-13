/**
 * Probe (2026-09-13, verifying m9/server-ops, B-313): on a REAL graph copy, how does
 * `block.update`'s `content` (the `"auto"` indent reading) treat text an agent copied — each live
 * block's flush `before` text, and the block as `page_read` prints it at depth 0, 1 and 2 (bullet
 * and ^id dropped from line 1)? Three readings compared: `unit` (strip one 2-column unit — the
 * B-172 fix as first committed), `common` (strip the later lines' common leading whitespace — the
 * B-313 fix), `gated` (common only when that reveals a property line).
 *
 * Read-only (node:sqlite, readOnly). Point it at a COPY, never ~/.nooklet/default. From packages/server:
 *   pnpm exec tsx ../../tools/probes/block-update-content-indent-graph.mts <COPY of graph.sqlite>
 *
 * Result on the owner's graph copy (2026-09-13 11:38, 18,628 live blocks; fence-first and literal
 * SCHEDULED: blocks skipped):
 *   unit:   page_read@1 and @2 — 866 blocks' properties differ (an indented key:: line read as
 *           text, so block.update unsets the property), 1,055 contents differ, 1 refused.
 *   gated:  page_read@1/@2 — 0 property diffs, 440 contents differ (whitespace), 1 refused.
 *   common: every depth — 0 property diffs, 14 contents differ (blocks whose every later line has
 *           its own indent lose it), 0 refused.
 *   flush text as content: 13 contents differ under all three (every later line tab-indented).
 *   shipped (the real parseSingleBlockGrammar(text, "auto") after B-313): identical to common.
 */
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { DatabaseSync } = await import("node:sqlite");
const { parseOutline, PROPERTY_LINE_RE } = await import(`${W}/packages/core/src/outline.ts`);
const { createNodeSqliteDriver } = await import(
  `${W}/packages/core/src/sync/node-sqlite-driver.ts`
);
const { renderSingleBlockText, renderOutlineNodes, applyCheckboxSugar, parseSingleBlockGrammar } =
  await import(`${W}/packages/server/src/ops/outline-bridge.ts`);
const { BLOCK_COLUMNS, rowToBlock } = await import(`${W}/packages/server/src/rows.ts`);
const path = process.argv[2];
if (!path || path.includes("/.nooklet/default")) {
  console.error("usage: block-update-content-indent-graph.mts <COPY of graph.sqlite>");
  process.exit(2);
}
const driver = createNodeSqliteDriver(new DatabaseSync(path, { readOnly: true }));
const rows = driver.all(`SELECT ${BLOCK_COLUMNS} FROM block WHERE deleted_at IS NULL`);
const common = (ls: string[]) => {
  let p = /^[ \t]*/.exec(ls[0] ?? "")?.[0] ?? "";
  for (const l of ls) {
    let i = 0;
    while (i < p.length && l[i] === p[i]) i++;
    p = p.slice(0, i);
  }
  return p;
};
type Mode = "unit" | "common" | "gated" | "shipped";
const bullet = (text: string, mode: Mode) => {
  const [first = "", ...rest] = text.split(/\r\n?|\n/);
  const nb = rest.filter((l) => l.trim() !== "");
  const ind = nb.length > 0 && nb.every((l) => l.startsWith("  ") || l.startsWith("\t"));
  let c = ind ? common(nb) : "";
  if (mode === "unit") c = "";
  if (mode === "gated" && !nb.some((l) => PROPERTY_LINE_RE.test(l.slice(c.length)))) c = "";
  const body = rest.map((l) =>
    c !== "" ? (l.trim() === "" ? l : `  ${l.slice(c.length)}`) : ind || l === "" ? l : `  ${l}`,
  );
  return [`- ${first}`, ...body].join("\n");
};
const parse = (text: string, mode: Mode) => {
  if (mode === "shipped") {
    try {
      return parseSingleBlockGrammar(text, "auto");
    } catch {
      return null;
    }
  }
  const p = parseOutline(`- -\n${bullet(applyCheckboxSugar(text), mode)}`);
  return p.blocks.length === 2 && p.blocks[1].children.length === 0 ? p.blocks[1] : null;
};
const sorted = (p: Record<string, string>) =>
  JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
const counts: Record<string, number> = {};
const ex: Record<string, string> = {};
const bump = (k: string, e: string) => {
  counts[k] = (counts[k] ?? 0) + 1;
  ex[k] ??= e;
};
for (const row of rows as Array<{ id: string }>) {
  const b = rowToBlock(driver, row);
  if (/^SCHEDULED: |\nSCHEDULED: |\nDEADLINE: /.test(b.content)) continue;
  if (/^(```|~~~)/.test(b.content)) continue; // OUT-14 artefact of this probe's page_read stripping
  const pr = renderOutlineNodes([{ ...b, id: row.id, children: [] }])
    .replace(/\n$/, "")
    .split("\n");
  const shapes: Array<[string, string]> = [["flush", renderSingleBlockText(b)]];
  for (const d of [0, 1, 2]) {
    const lines = pr.map((l) => (l === "" ? l : "  ".repeat(d) + l));
    const first = (lines[0] ?? "")
      .replace(/^\s*- ?/, "")
      .replace(new RegExp(`\\s*\\^${row.id}$`), "");
    shapes.push([`page_read@${d}`, [first, ...lines.slice(1)].join("\n")]);
  }
  for (const [shape, text] of shapes) {
    for (const mode of ["unit", "common", "gated", "shipped"] as Mode[]) {
      const n = parse(text, mode);
      if (!n) {
        bump(`${shape} ${mode} refused`, row.id);
        continue;
      }
      if (sorted(n.properties) !== sorted(b.properties))
        bump(`${shape} ${mode} PROPS differ`, `${row.id} ${JSON.stringify(text.slice(0, 100))}`);
      else if (n.content.replace(/\s+$/gm, "") !== b.content.replace(/\s+$/gm, ""))
        bump(`${shape} ${mode} content differs`, `${row.id} ${JSON.stringify(text.slice(0, 100))}`);
    }
  }
}
for (const k of Object.keys(counts).sort()) console.log(k.padEnd(40), counts[k], "  e.g.", ex[k]);
