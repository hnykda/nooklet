/**
 * The markdown mirror `nooklet serve` keeps (ADR 002, B-95), read off the disk of the very server
 * this suite started. B-260: only block text, creates and deletes reached `pages/`; a rename left
 * the old file and wrote no new one, and properties, markers and indents never appeared.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { api, clickRow, MOD, openEditing, readBlocks, seedPage } from "../helpers/index.js";

/** `global-setup.ts` records the throwaway data dir it served, keyed by port. */
function dataDir(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return state.dataDir;
}

// ADR 025: the mirror lives under this graph's own subdirectory now, not the base data dir
// directly — the e2e server's zero-config "default" graph, same as everywhere else in this suite.
const pageFile = (name: string) => join(dataDir(), "graphs", "default", "pages", `${name}.md`);
const readMirror = (name: string) =>
  existsSync(pageFile(name)) ? readFileSync(pageFile(name), "utf8") : "";

test("renaming a page moves its mirror file: the new one appears, the old one goes (B-260)", async ({
  page,
}) => {
  await seedPage(page, "Mirror Live Rename", "- body");
  await expect.poll(() => existsSync(pageFile("Mirror Live Rename"))).toBe(true);

  await api(page, "page.update", { page: "Mirror Live Rename", new_name: "Mirror Live Renamed" });
  await expect.poll(() => existsSync(pageFile("Mirror Live Renamed"))).toBe(true);
  await expect.poll(() => existsSync(pageFile("Mirror Live Rename"))).toBe(false);

  // Namespaced: `/` is spelled `___` in the file name, and both spellings must move together.
  await seedPage(page, "Mirror Live/NS", "- body");
  await expect.poll(() => existsSync(pageFile("Mirror Live___NS"))).toBe(true);
  await api(page, "page.update", { page: "Mirror Live/NS", new_name: "Mirror Live/NS moved" });
  await expect.poll(() => existsSync(pageFile("Mirror Live___NS moved"))).toBe(true);
  await expect.poll(() => existsSync(pageFile("Mirror Live___NS"))).toBe(false);
});

test("page and block properties reach the mirror file (B-260)", async ({ page }) => {
  await seedPage(page, "Mirror Live Props", "- carrier");
  await expect.poll(() => readMirror("Mirror Live Props")).toContain("carrier");
  const [block] = await readBlocks(page, "Mirror Live Props");

  await api(page, "page.update", { page: "Mirror Live Props", properties: { qaprop: "hello" } });
  await api(page, "block.update", { id: block?.id, properties: { status: "x" } });
  await expect.poll(() => readMirror("Mirror Live Props")).toContain("qaprop:: hello");
  await expect.poll(() => readMirror("Mirror Live Props")).toContain("status:: x");
});

test("Tab and Cmd/Ctrl+Enter in the outliner reach the mirror file (B-260)", async ({ page }) => {
  const outliner = await openEditing(page, "Mirror Live Keys", "- one\n- two\n- three");
  await expect.poll(() => readMirror("Mirror Live Keys")).toMatch(/^- three /m);

  await clickRow(page, outliner, 1);
  await page.keyboard.press("Tab");
  await expect.poll(async () => (await readBlocks(page, "Mirror Live Keys"))[1]?.depth).toBe(1);

  await clickRow(page, outliner, 2);
  await page.keyboard.press(`${MOD}+Enter`);

  await expect.poll(() => readMirror("Mirror Live Keys")).toMatch(/^ {2}- two /m);
  await expect.poll(() => readMirror("Mirror Live Keys")).toMatch(/^- TODO three /m);
});
