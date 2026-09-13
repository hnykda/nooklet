/**
 * Agent-facing ops against the real server and the production build (m9/server-ops): the calls an
 * agent makes over MCP, each checked where a person would see the result.
 *
 *  - B-172: `block.update` old_str/new_str on a task with a property line (it was a 400).
 *  - B-235: `page.create` markdown with a page-properties pre-block (it was silently dropped).
 *  - B-236: `page.update` properties on a journal day (it was "cannot rename a journal day").
 *  - B-148: `ui_run` whose command throws in a real window answers with the command's reason (it
 *    was a 500 "did not respond in time" after the RPC timeout).
 *
 * Page names start with "Srvops" and the journal day is 40 days back: the suite shares one server.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, openEditing, openPage, pagePath, readBlocks } from "../helpers/index.js";

const PORT = process.env.NOOKLET_E2E_PORT ?? "6188";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("block.update flips TODO to DONE by old_str on a scheduled task, and the row follows (B-172)", async ({
  page,
}) => {
  const name = "Srvops Tasks";
  const outliner = await openPage(
    page,
    name,
    `- TODO srvops buy milk\n  scheduled:: ${isoOffset(5)}\n- plain first line\n  second line`,
  );
  const [task, lines] = await readBlocks(page, name);
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);

  await api(page, "block.update", { id: task?.id, old_str: "TODO", new_str: "DONE" });
  await expect(outliner.locator(".vr-marker-DONE")).toHaveCount(1);
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(0);

  await api(page, "block.update", { id: lines?.id, old_str: "second", new_str: "2nd" });
  await expect
    .poll(async () => (await readBlocks(page, name))[1]?.content)
    .toBe("plain first line\n2nd line");
  const stored = await api<{ block: { properties?: Record<string, string> } }>(page, "block.read", {
    id: task?.id,
    format: "json",
  });
  expect(stored.block.properties?.scheduled).toBe(isoOffset(5));
  expect(stored.block.properties?.done).toBeTruthy();
});

test("page.create applies a markdown read-only:: pre-block: the page opens locked (B-235)", async ({
  page,
}) => {
  const name = "Srvops Locked By Markdown";
  await api(page, "page.create", {
    name,
    if_exists: "return",
    markdown: "read-only:: true\n\n- srvops locked a\n- srvops locked b",
  });
  await page.goto(pagePath(name));
  await expect(page.locator(".vr-outliner .vr-row")).toHaveCount(2);
  await expect(page.locator(".page-readonly-badge")).toBeVisible();
});

test("page.update sets a property on a journal day (B-236)", async ({ page }) => {
  const day = isoOffset(-40);
  await api(page, "page.append", { page: day, markdown: "- srvops journal note" });
  const out = await api<{ page: { kind: string; properties?: Record<string, string> } }>(
    page,
    "page.update",
    { page: day, properties: { "read-only": "true" } },
  );
  expect(out.page.kind).toBe("journal");
  expect(out.page.properties?.["read-only"]).toBe("true");
  await page.goto(pagePath(day));
  await expect(page.locator(".page-readonly-badge")).toBeVisible();
});

/** A write + ui:control token, minted with the CLI against this run's server data dir — the
 * loopback session token has no ui:control, and no op mints tokens. */
function mintUiControlToken(): string {
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${PORT}.json`), "utf8"),
  ) as { dataDir: string };
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "@nooklet/server",
      "exec",
      "tsx",
      "src/cli.ts",
      "token",
      "create",
      "--label",
      "e2e-srvops-ui-run",
      "--scope",
      "write",
      "--ui-control",
      "--data",
      state.dataDir,
    ],
    // NOOKLET_DATA as well as --data: a nooklet command must never fall back to the owner's graph.
    { cwd: repoRoot, env: { ...process.env, NOOKLET_DATA: state.dataDir }, encoding: "utf8" },
  );
  const token = /nk_[0-9a-f]+/.exec(out)?.[0];
  if (!token) throw new Error(`token create printed no token:\n${out}`);
  return token;
}

async function uiCall(page: Page, token: string, op: string, body: unknown) {
  const res = await page.request.post(`/api/v1/${op}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    data: body,
  });
  return { status: res.status(), json: await res.json() };
}

test("ui_run with args the command refuses answers invalid with its reason, not a timeout (B-148)", async ({
  page,
}) => {
  test.slow(); // the CLI token mint starts tsx
  const token = mintUiControlToken();
  await page.addInitScript(() => localStorage.setItem("nooklet.live.controlEnabled", "true"));
  const name = "Srvops Remote Dates";
  await openEditing(page, name, "- TODO srvops remote task");

  // The web client reports no page in its hello (`CommandLayer.tsx`'s `getPage: () => null`), so
  // this window is the newest one with control on — earlier tests' pages have closed theirs.
  let windowId = "";
  await expect
    .poll(async () => {
      const { json } = await uiCall(page, token, "ui.windows", {});
      const controlled = (
        (json.windows ?? []) as Array<{
          window_id: string;
          control_enabled: boolean;
          connected_at: string;
        }>
      )
        .filter((w) => w.control_enabled)
        .sort((a, b) => b.connected_at.localeCompare(a.connected_at));
      windowId = controlled[0]?.window_id ?? "";
      return windowId;
    })
    .not.toBe("");

  for (const args of ["banana", 42]) {
    const started = Date.now();
    const { status, json } = await uiCall(page, token, "ui.run", {
      command_id: "task.setScheduled",
      args,
      window_id: windowId,
    });
    expect(status, JSON.stringify(json)).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.details?.reason).toBe("command_failed");
    expect(json.error.message).toContain("task.setScheduled failed");
    expect(json.error.message).toContain(typeof args === "string" ? "banana" : "date string");
    // The RPC timeout is 2 s: an answer that slow is the bug coming back.
    expect(Date.now() - started).toBeLessThan(1900);
  }

  // A good value still runs, and nothing was stored by the refused ones before it.
  const [block] = await readBlocks(page, name);
  const read = async () =>
    (
      await api<{ block: { properties?: Record<string, string> } }>(page, "block.read", {
        id: block?.id,
        format: "json",
      })
    ).block.properties?.scheduled;
  expect(await read()).toBeUndefined();
  const ok = await uiCall(page, token, "ui.run", {
    command_id: "task.setScheduled",
    args: isoOffset(3),
    window_id: windowId,
  });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(ok.json.when_result).toBe("ran");
  await expect.poll(read).toBe(isoOffset(3));
});
