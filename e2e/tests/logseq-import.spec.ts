/**
 * Settings → Import from Logseq (ADR 031), end to end: a real browser picks the fixture graph as
 * a folder (desktop width) and as a .zip (phone width), the real server unpacks, imports and
 * verifies it into a new graph, and the counts on screen match what `nooklet import` makes of the
 * very same folder. Then "Open" lands in the new graph with its pages there.
 *
 * The fixture (`e2e/fixtures/logseq-graph/`) is invented: two pages, a namespaced page, two
 * journals, one image, a block ref that resolves and one that does not, a non-default journal
 * title format, and a `logseq/bak/` copy that must be left out.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = join(repoRoot, "e2e", "fixtures", "logseq-graph");

interface CliStats {
  pagesImported: number;
  journalsImported: number;
  blocksImported: number;
  assetsImported: number;
}

let cli: CliStats;

test.beforeAll(() => {
  const data = mkdtempSync(join(tmpdir(), "nooklet-e2e-cli-import-"));
  const out = execFileSync(
    "pnpm",
    ["--filter", "@nooklet/server", "exec", "tsx", "src/cli.ts", "import", fixture, "--data", data],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NOOKLET_DATA: data } },
  );
  cli = JSON.parse(out.slice(out.indexOf("{"))) as CliStats;
  expect(cli.pagesImported).toBe(3);
});

async function openImport(page: Page): Promise<void> {
  await page.goto("/journals");
  await expect(page.locator(".vr-outliner, .vr-draft-input").first()).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator("#set-import")).toBeVisible();
  await expect(page.getByTestId("import-run")).toBeVisible();
}

async function runAndCheck(
  page: Page,
  graphName: string,
  graphId: string,
  testInfo: TestInfo,
): Promise<void> {
  const section = page.locator("#set-import");
  await section.getByTestId("import-graph-name").fill(graphName);
  await expect(section).toContainText(`/g/${graphId}`);
  // Screenshots of fixture data only (invented graph), for reviewing the screen.
  await section.screenshot({ path: testInfo.outputPath("1-choose.png") });
  await section.getByTestId("import-run").click();
  // The progress view appears at once and stays until the job finishes.
  await expect(section.getByTestId("import-progress")).toBeVisible();
  await expect(section.getByTestId("import-done")).toBeVisible({ timeout: 30_000 });
  await section.screenshot({ path: testInfo.outputPath("2-summary.png") });

  const n = async (label: string) =>
    Number((await section.getByTestId(`import-count-${label}`).textContent())?.replace(/\D/g, ""));
  expect(await n("pages")).toBe(cli.pagesImported);
  expect(await n("journals")).toBe(cli.journalsImported);
  expect(await n("blocks")).toBe(cli.blocksImported);
  expect(await n("assets")).toBe(cli.assetsImported);
  // The summary says what the importer noticed: the unresolved block ref, and the journal format.
  await expect(section.getByTestId("import-summary")).toContainText("block reference points");
  await section.locator(".imp-details summary").click();
  await expect(section.locator(".imp-details")).toContainText("EEE, dd.MM.yyyy");

  await section.getByTestId("import-open").click();
  await page.waitForURL(new RegExp(`/g/${graphId}/`));
  await page.goto(`/g/${graphId}/pages`);
  await expect(page.getByText("Garden plan", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Plánování zahradních úprav").first()).toBeVisible();
}

test("import a Logseq graph folder into a new graph", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await openImport(page);
  await page.getByTestId("import-folder-input").setInputFiles(fixture);
  // bak/ is not counted: 3 pages, 2 journals, 1 asset.
  await expect(page.getByTestId("import-picked")).toContainText("3 pages, 2 journals, 1 file");
  await runAndCheck(page, "Garden notes", "garden-notes", testInfo);
});

test("import a .zip of the graph at phone width", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // Deflated, folder-wrapped, with the backup folder inside: the shape Finder's or Files'
  // "Compress" produces.
  const zipPath = testInfo.outputPath("logseq-graph.zip");
  execFileSync("zip", ["-r", "-q", "-X", zipPath, "logseq-graph"], {
    cwd: join(repoRoot, "e2e", "fixtures"),
  });
  await openImport(page);
  await page.getByTestId("import-zip-input").setInputFiles(zipPath);
  await expect(page.getByTestId("import-picked")).toContainText("zip");
  // Nothing in the section is wider than the phone.
  const overflow = await page.evaluate(() => {
    const s = document.querySelector("#set-import") as HTMLElement;
    return s.scrollWidth - s.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  await runAndCheck(page, "Zipped notes", "zipped-notes", testInfo);
});
