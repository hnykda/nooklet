/**
 * The graph view. A canvas has no DOM, so everything the eye checks here is checked through the
 * two handles the view exposes for exactly that reason: `data-node-count`/`data-edge-count` on
 * the wrapper, and the hidden list of page links that carries each node's settled position
 * (`data-x`/`data-y`, see `views/GraphView.tsx`). That list is not a test fixture — it is how a
 * screen reader and a keyboard user reach the same nodes — which is why asserting through it is
 * asserting something real.
 *
 * Edges come from the server's `ref` table, which no client has, so these tests also stand in for
 * "the client can actually reach `graph.links` with its credential" — the class of bug that made
 * search render as a permanent spinner.
 */
import { expect, type Page, test } from "@playwright/test";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

/**
 * Seed a small connected graph: Hub is linked from two pages and links a third, so its degree is
 * a known 3.
 *
 * Every call goes through `page.create` with `if_exists: "return"` rather than `page.append`,
 * because tests in one file share a server: appending on each `seed()` would triple Hub's
 * reference count by the third test and make any assertion about it meaningless.
 */
async function seed(page: Page): Promise<void> {
  await page.goto("/journals");
  const pages: Array<[string, string?]> = [
    ["Graph Hub", "- down to [[Graph Leaf]]"],
    ["Graph Left", "- points at [[Graph Hub]]"],
    ["Graph Right", "- also [[Graph Hub]]"],
    ["Graph Leaf"],
  ];
  for (const [name, markdown] of pages) {
    await api(page, "page.create", { name, markdown, if_exists: "return" });
  }
}

test("renders a node per page and an edge per reference", async ({ page }) => {
  await seed(page);
  await page.goto("/graph");

  const wrap = page.locator(".graph-canvas-wrap");
  await expect(wrap).toHaveAttribute("data-settled", "true", { timeout: 20_000 });

  // The seeded pages are all there. Other specs share this server, so the counts are lower bounds.
  const list = page.locator(".graph-node-list");
  for (const name of ["Graph Hub", "Graph Left", "Graph Right", "Graph Leaf"]) {
    await expect(list.locator(`li a:text-is("${name}")`)).toHaveCount(1);
  }
  expect(Number(await wrap.getAttribute("data-node-count"))).toBeGreaterThanOrEqual(4);
  expect(Number(await wrap.getAttribute("data-edge-count"))).toBeGreaterThanOrEqual(3);

  // The canvas, the accessible list and the header all report the same graph. Read in one tick,
  // because a local write refetches the whole thing and three separate reads could straddle it.
  const rendered = await page.evaluate(() => ({
    counted: Number(
      document.querySelector(".graph-canvas-wrap")?.getAttribute("data-node-count") ?? -1,
    ),
    listed: document.querySelectorAll(".graph-node-list li").length,
    header: document.querySelector(".graph-count")?.textContent ?? "",
  }));
  expect(rendered.listed).toBe(rendered.counted);
  expect(rendered.header).toContain(`${rendered.counted} pages`);

  // …and something was actually painted. Every assertion above would still pass against a canvas
  // that never drew a pixel — a transform bug, an empty palette, a simulation that put every node
  // off-screen — which is the shape of "green tests, broken feature" this suite exists to catch.
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector(".graph-canvas") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) opaque++;
    return opaque;
  });
  expect(painted).toBeGreaterThan(200);
});

test("clicking a node on the canvas opens that page", async ({ page }) => {
  await seed(page);
  await page.goto("/graph");

  const wrap = page.locator(".graph-canvas-wrap");
  await expect(wrap).toHaveAttribute("data-settled", "true", { timeout: 20_000 });

  const item = page.locator('.graph-node-list li:has(a:text-is("Graph Hub"))');
  const x = Number(await item.getAttribute("data-x"));
  const y = Number(await item.getAttribute("data-y"));
  expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);

  await page.locator(".graph-canvas").click({ position: { x, y } });
  await expect(page).toHaveURL(/\/page\/Graph%20Hub/);
  await expect(page.locator(".page-title-input")).toHaveValue("Graph Hub");
});

test("hovering a node names it and its reference count", async ({ page }) => {
  await seed(page);
  await page.goto("/graph");

  const wrap = page.locator(".graph-canvas-wrap");
  await expect(wrap).toHaveAttribute("data-settled", "true", { timeout: 20_000 });

  const item = page.locator('.graph-node-list li:has(a:text-is("Graph Hub"))');
  const x = Number(await item.getAttribute("data-x"));
  const y = Number(await item.getAttribute("data-y"));
  const box = await page.locator(".graph-canvas").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + x, (box?.y ?? 0) + y);

  // Hub is referenced twice and references once, so its degree is 3.
  await expect(page.locator(".graph-hover")).toContainText("Graph Hub · 3 reference(s)");
});

test("journals are excluded by default, and the view says what that costs", async ({ page }) => {
  await seed(page);
  // A link written in a journal entry: the reason excluding journals is not just decluttering.
  //
  // A PAST day, never "today": today's journal is shared state that `a-fresh-journal.spec.ts`
  // needs pristine — that spec is named to sort first precisely because this behaviour only
  // exists on a day with no page yet. Writing here would break it whenever the specs are
  // reordered or sharded, and the failure would look like an editor bug rather than a fixture
  // collision (docs/BUGS.md B-32).
  const past = new Date();
  past.setDate(past.getDate() - 9);
  const pastIso = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(
    past.getDate(),
  ).padStart(2, "0")}`;
  await api(page, "page.append", {
    page: pastIso,
    markdown: "- journal mentions [[Graph Leaf]]",
  });

  await page.goto("/graph");
  const wrap = page.locator(".graph-canvas-wrap");
  await expect(wrap).toHaveAttribute("data-settled", "true", { timeout: 20_000 });

  // The note has to be visible, or a graph that is sparse on purpose is indistinguishable from
  // one that is sparse because ref extraction broke.
  await expect(page.locator(".graph-note")).toContainText("journal");
  const withoutJournals = Number(await wrap.getAttribute("data-node-count"));

  await page.locator(".graph-toggle input").check();
  await expect(wrap).not.toHaveAttribute("data-node-count", String(withoutJournals), {
    timeout: 20_000,
  });
  expect(Number(await wrap.getAttribute("data-node-count"))).toBeGreaterThan(withoutJournals);
});

test("says so when the graph request fails", async ({ page }) => {
  await page.goto("/journals");
  await page.route("**/api/v1/graph.links", (route) => route.abort("failed"));
  await page.goto("/graph");

  await expect(page.locator(".graph-error")).toContainText("Couldn't load the graph", {
    timeout: 15_000,
  });
});

test("the sidebar links to it", async ({ page }) => {
  await page.goto("/journals");
  await page.locator("button[aria-label='Toggle sidebar']").click();
  await page.locator(".app-sidebar .sidebar-nav a[href$='/graph']").click();
  await expect(page).toHaveURL(/\/graph/);
  await expect(page.locator(".graph-header h1")).toContainText("Graph");
});
