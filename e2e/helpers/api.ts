/**
 * Talking to the server the way an agent would: `POST /api/v1/<op>` with the web-client token.
 *
 * The token comes from `GET /api/session`, fetched once per worker over Playwright's own request
 * context rather than by first loading the app in the browser — so a test can seed its page and
 * navigate to it in ONE `goto`, which is where most of a spec's wall-clock goes. Loopback callers
 * are the only ones handed a token (docs/BUGS.md B-25), and the test runner is one.
 */

import type { Page, TestInfo } from "@playwright/test";

let cachedToken: string | undefined;

async function token(page: Page): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await page.request.get("/api/session");
  if (!res.ok()) throw new Error(`GET /api/session -> ${res.status()}`);
  const body = (await res.json()) as { token: string | null };
  if (!body.token) throw new Error("/api/session handed the test runner no token");
  cachedToken = body.token;
  return cachedToken;
}

/** One op. Throws with the server's status and body on anything but 2xx, so a seeding mistake
 * fails the test at the seed rather than as a mysterious "page doesn't exist" later. */
export async function api<T = unknown>(page: Page, op: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/${op}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${await token(page)}` },
    data: body,
  });
  if (!res.ok()) throw new Error(`${op} -> ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Create `name` with `markdown` as its blocks — once. `if_exists: "return"` makes a second call
 * for the same name a no-op, so a spec re-run against the same server (or the same page name
 * seeded from two tests) does not double every row (`graph.spec.ts` learned this first).
 */
export async function seedPage(page: Page, name: string, markdown: string): Promise<void> {
  await api(page, "page.create", {
    name,
    if_exists: "return",
    ...(markdown.trim() !== "" ? { markdown } : {}),
  });
}

/** The ISO date `offsetDays` from today — how journals are addressed through the API and, since
 * ADR 018, how the page itself is named. */
export function isoOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** `/page/<name>`, one `encodeURIComponent` per namespace segment, matching the router. */
export function pagePath(name: string): string {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** `page.read`'s JSON tree, flattened to `{id, content}` in reading order — for tests that need a
 * real block id (block references, zoom routes). */
export async function readBlocks(
  page: Page,
  name: string,
): Promise<Array<{ id: string; content: string; depth: number }>> {
  const out = await api<{ tree?: TreeNode[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<{ id: string; content: string; depth: number }> = [];
  const walk = (nodes: TreeNode[] | undefined, depth: number): void => {
    for (const n of nodes ?? []) {
      flat.push({ id: n.id, content: n.content, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(out.tree, 0);
  return flat;
}

interface TreeNode {
  id: string;
  content: string;
  children?: TreeNode[];
}

/**
 * `base`, made unique per `--repeat-each` iteration and per retry.
 *
 * Every spec in a run shares ONE server, and so does every repeat of a test. A test that seeds a
 * fixed page name and then asserts on its exact state (a row count, a reference count, an icon
 * slot that starts empty) passes once per server and fails on the second repeat against what the
 * first one left behind (B-292, B-356) — so it could not be looped to tell load from a regression,
 * which is the first thing a flaky-looking failure calls for.
 */
export function runName(base: string, info: Pick<TestInfo, "repeatEachIndex" | "retry">): string {
  return `${base} ${info.repeatEachIndex}-${info.retry}`;
}
