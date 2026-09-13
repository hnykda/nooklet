/**
 * Probe (2026-09-13, m11/remote-rewrite, B-460): an agent changes only a PROPERTY of the block being
 * edited (`block.update` with `properties`, which leaves `content_hlc` alone). Does the editor's
 * buffer — which holds the block's property lines (B-101) — show it, and does typing elsewhere in
 * the block write the old value back?
 *
 * Result on `m11/remote-rewrite` after the B-192 fix: buffer stays `"has prop\nowner:: alice"`
 * after the server holds `owner:: bob` and a later refetch; typing `!` on line 1 writes
 * `has prop!` and leaves `owner:: bob` on the server; after Escape the row shows `bob`.
 *
 * Not part of the suite (it prints; it does not assert on the finding). To re-run, copy it into
 * `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, test } from "@playwright/test";
import { api, editorText, openEditing, readBlocks } from "../helpers/index.js";

test("probe: agent changes only a property of the block being edited", async ({ page }) => {
  const name = "Probe Remote Prop";
  await openEditing(page, name, "- has prop\n  owner:: alice\n- other");
  const id = (await readBlocks(page, name))[0]?.id as string;
  console.log("buffer at start:", JSON.stringify(await editorText(page)));

  await api(page, "block.update", { id, properties: { owner: "bob" } });
  const md = async () =>
    (await api<{ text?: string }>(page, "page.read", { page: name, format: "outline" })).text ?? "";
  await expect.poll(md).toContain("owner:: bob");
  // A change elsewhere on the page, to be sure a refetch has happened since.
  const other = (await readBlocks(page, name))[1]?.id as string;
  await api(page, "block.update", { id: other, content: "other changed" });
  await expect.poll(() => page.locator(".vr-row").nth(1).textContent()).toBe("other changed");
  console.log("buffer after the property write:", JSON.stringify(await editorText(page)));

  await page.keyboard.type("!");
  await page.waitForTimeout(1500);
  console.log("server after typing '!':", JSON.stringify(await md()));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  console.log("server after Escape:", JSON.stringify(await md()));
  console.log(
    "row after Escape:",
    JSON.stringify(await page.locator(".vr-row").first().textContent()),
  );
});
