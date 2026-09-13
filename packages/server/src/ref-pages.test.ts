/**
 * ADR 024: pages exist once referenced. Through `serverApplyOps`, the way every write reaches the
 * server, and checked against `verifyRebuildParity` — the minted ops are ordinary logged ops, so a
 * replay of the log must land on exactly the same pages.
 */

import { newId, type Op } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { REFERENCE_DEVICE_ID } from "./ref-pages.js";
import { verifyRebuildParity } from "./verify.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function op(entity: string, payload: Op["payload"]): Op {
  const hlc = ctx.hlc.next();
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

function apply(ops: Op[], referencedPages: "mint" | "skip" = "mint") {
  return serverApplyOps(ctx, ops, { origin: "user", actor: "test", referencedPages });
}

function page(name: string): string {
  const id = newId();
  apply([op(id, { kind: "page.create", name, journalDay: null, createdAt: Date.now() })]);
  return id;
}

function block(pageId: string, content: string, extra: Partial<Op["payload"]> = {}): string {
  const id = newId();
  apply([
    op(id, {
      kind: "block.create",
      place: { pageId, parentId: null, order: "a0" },
      content,
      createdAt: Date.now(),
      ...extra,
    } as Op["payload"]),
  ]);
  return id;
}

function text(blockId: string, content: string) {
  return apply([op(blockId, { kind: "block.text", content })]);
}

/** Live page names, sorted. */
function livePages(): string[] {
  return ctx.driver
    .all<{ name: string }>("SELECT name FROM page WHERE deleted_at IS NULL ORDER BY key")
    .map((r) => r.name);
}

function pageRow(name: string) {
  return ctx.driver.get<{ id: string; name: string; deleted_at: number | null }>(
    "SELECT id, name, deleted_at FROM page WHERE key = lower(?) ORDER BY deleted_at IS NULL DESC LIMIT 1",
    [name],
  );
}

function expectParity(): void {
  const report = verifyRebuildParity(ctx.driver);
  expect(report.divergences).toEqual([]);
  expect(report.ok).toBe(true);
}

describe("a reference makes its page exist", () => {
  it("creates a namespaced page and every ancestor, resolved, as logged reference ops", () => {
    const home = page("Home");
    const b = newId();
    const res = apply([
      op(b, {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "a0" },
        content: "see [[Sprouts/Growing/Sixth Try]]",
        createdAt: Date.now(),
      }),
    ]);

    expect(livePages()).toEqual([
      "Home",
      "Sprouts",
      "Sprouts/Growing",
      "Sprouts/Growing/Sixth Try",
    ]);
    // The pushing device hears about them in the same response.
    const created = res.corrections.filter((c) => c.payload.kind === "page.create");
    expect(created.map((c) => (c.payload as { name: string }).name)).toEqual([
      "Sprouts",
      "Sprouts/Growing",
      "Sprouts/Growing/Sixth Try",
    ]);
    expect(created.every((c) => c.device === REFERENCE_DEVICE_ID)).toBe(true);
    const logged = ctx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM op WHERE device_id = ? AND kind = 'page.create' AND status = 'applied'",
      [REFERENCE_DEVICE_ID],
    );
    expect(logged?.n).toBe(3);

    const refs = ctx.driver.all<{ dst_page_id: string | null }>(
      "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
      [b],
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.dst_page_id).toBe(pageRow("Sprouts/Growing/Sixth Try")?.id);
    const path = ctx.driver.get<{ page_id: string | null }>(
      "SELECT page_id FROM path_ref WHERE block_id = ? AND page_key = 'sprouts/growing/sixth try'",
      [b],
    );
    expect(path?.page_id).toBe(pageRow("Sprouts/Growing/Sixth Try")?.id);
    expectParity();
  });

  it("names the page with the casing of the first reference", () => {
    const home = page("Home");
    const a = block(home, "[[Home Automation]]");
    block(home, "[[home automation]] again");
    text(a, "[[HOME AUTOMATION]]");
    expect(livePages()).toEqual(["Home", "Home Automation"]);
  });

  it("counts every kind of reference: tags, labelled links, property values, the Task tag", () => {
    const home = page("Home");
    block(home, "#idea and #[[quick capture]] and [[Target|the label]]");
    block(home, "a task", { marker: "TODO" } as Partial<Op["payload"]>);
    const withProps = newId();
    apply([
      op(withProps, {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "b0" },
        content: "props",
        properties: { tags: "book, [[Deep Work]]", who: "[[@eva svobodová]]", alias: "Nick" },
        createdAt: Date.now(),
      }),
    ]);
    expect(livePages()).toEqual([
      "@eva svobodová",
      "book",
      "Deep Work",
      "Home",
      "idea",
      "quick capture",
      "Target",
      "Task",
    ]);
    // `alias::` names the page it sits on; it is not a reference to a page called Nick.
    expect(pageRow("Nick")).toBeUndefined();
    expectParity();
  });

  it("creates pages a page's own tags:: name", () => {
    const p = page("Reading List");
    apply([op(p, { kind: "page.prop", key: "tags", value: "[[Books]], #novel" })]);
    expect(livePages()).toEqual(["Books", "novel", "Reading List"]);
    expectParity();
  });

  it("makes a live namespaced page's ancestors exist, however it was created", () => {
    page("Projects/Nooklet/M11");
    expect(livePages()).toEqual(["Projects", "Projects/Nooklet", "Projects/Nooklet/M11"]);
  });

  it("does not create journal days from date references", () => {
    const home = page("Home");
    block(home, "[[2026-09-07]] [[Sep 8th, 2026]] [[Wed, 09.09.2026]] #[[2026/09/10]]");
    expect(livePages()).toEqual(["Home"]);
  });

  it("does nothing for a reference that already resolves, directly or through an alias", () => {
    const real = page("Real");
    apply([op(real, { kind: "page.prop", key: "alias", value: "Nick" })]);
    const home = page("Home");
    const res = apply([
      op(newId(), {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "a0" },
        content: "[[Real]] and [[Nick]]",
        createdAt: Date.now(),
      }),
    ]);
    expect(res.corrections).toEqual([]);
    expect(livePages()).toEqual(["Home", "Real"]);
  });

  it("ignores references in deleted blocks and on deleted pages", () => {
    const home = page("Home");
    const b = newId();
    const del = newId();
    apply([
      op(b, {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "a0" },
        content: "draft",
        createdAt: Date.now(),
      }),
    ]);
    apply([op(b, { kind: "block.delete", deletedAt: Date.now() })]);
    text(b, "[[Ghost]]");
    expect(pageRow("Ghost")).toBeUndefined();
    void del;
  });

  it("with referencedPages: skip, leaves the reference dangling", () => {
    const home = page("Home");
    const b = newId();
    apply(
      [
        op(b, {
          kind: "block.create",
          place: { pageId: home, parentId: null, order: "a0" },
          content: "[[Later]]",
          createdAt: Date.now(),
        }),
      ],
      "skip",
    );
    expect(livePages()).toEqual(["Home"]);
  });
});

describe("junk from editing a link, and a page whose last reference goes", () => {
  it("editing a link one character at a time leaves only the final page", () => {
    const home = page("Home");
    const b = block(home, "see [[Probe Foo]] here");
    const before = livePages();
    // The pushes `tools/probes/ref-link-typing.spec.ts` recorded at 700 ms/char.
    for (const n of ["Foob", "Fooba", "Foobar", "Foobar ", "Foobar b", "Foobar ba", "Foobar baz"]) {
      text(b, `see [[Probe ${n}]] here`);
    }
    expect(livePages()).toEqual(
      before
        .filter((n) => n !== "Probe Foo")
        .concat("Probe Foobar baz")
        .sort(),
    );
    expect(livePages()).toEqual(["Home", "Probe Foobar baz"]);
    expectParity();
  });

  it("typing a #tag slowly leaves only the finished tag", () => {
    const home = page("Home");
    const b = block(home, "start ");
    for (const t of [
      "#",
      "#p",
      "#pr",
      "#pro",
      "#prob",
      "#probe",
      "#probet",
      "#probeta",
      "#probetag",
    ]) {
      text(b, `start ${t}`);
    }
    text(b, "start #probetag done");
    expect(livePages()).toEqual(["Home", "probetag"]);
  });

  it("deleting the only reference removes an untouched page and its ancestors, not a used one", () => {
    const home = page("Home");
    const a = block(home, "[[Sprouts/Growing/Sixth Try]]");
    const used = block(home, "[[Garden]]");
    block(pageRow("Garden")?.id as string, "typed into");
    const propped = block(home, "[[Tagged]]");
    apply([op(pageRow("Tagged")?.id as string, { kind: "page.prop", key: "icon", value: "🌱" })]);

    apply([op(a, { kind: "block.delete", deletedAt: Date.now() })]);
    apply([op(used, { kind: "block.delete", deletedAt: Date.now() })]);
    apply([op(propped, { kind: "block.delete", deletedAt: Date.now() })]);

    expect(livePages()).toEqual(["Garden", "Home", "Tagged"]);
    expectParity();
  });

  it("keeps an ancestor that something else still references or holds", () => {
    const home = page("Home");
    const a = block(home, "[[A/B]] and [[A/C]]");
    text(a, "[[A/C]]");
    expect(livePages()).toEqual(["A", "A/C", "Home"]);
    text(a, "[[A/D]]");
    expect(livePages()).toEqual(["A", "A/D", "Home"]);
    text(a, "nothing");
    expect(livePages()).toEqual(["Home"]);
  });

  it("makes a new page when the reference returns — never revives the tombstone (B-443)", () => {
    const home = page("Home");
    const b = block(home, "[[Toggle]]");
    const id = pageRow("Toggle")?.id;
    text(b, "no link");
    expect(pageRow("Toggle")?.deleted_at).not.toBeNull();
    text(b, "[[toggle]]");
    const back = pageRow("Toggle");
    expect(back?.id).not.toBe(id);
    expect(back?.deleted_at).toBeNull();
    // Named by the reference that brought it back.
    expect(back?.name).toBe("toggle");
    // The old one stays a tombstone nothing revives: a replica that refused its create cannot
    // miss a later un-delete, because there is none.
    expect(
      ctx.driver.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM op WHERE entity = ? AND kind = 'page.delete' AND payload_json LIKE '%\"deletedAt\":null%'",
        [id],
      )?.n,
    ).toBe(0);
    expectParity();
  });

  it("gives a deleted page's still-referenced name an empty page again", () => {
    const home = page("Home");
    const topic = page("Topic");
    block(topic, "content");
    block(home, "[[Topic]]");
    apply([op(topic, { kind: "page.delete", deletedAt: Date.now() })]);
    const now = pageRow("Topic");
    expect(now?.deleted_at).toBeNull();
    expect(now?.id).not.toBe(topic);
    expectParity();
  });

  it("deleting a page takes its blocks' references with it", () => {
    const scratch = page("Scratch");
    block(scratch, "[[Only Here]]");
    expect(livePages()).toContain("Only Here");
    apply([op(scratch, { kind: "page.delete", deletedAt: Date.now() })]);
    expect(livePages()).toEqual([]);
  });

  it("a user's rename claims the page", () => {
    const home = page("Home");
    const b = block(home, "[[Draft Name]]");
    const id = pageRow("Draft Name")?.id as string;
    apply([op(id, { kind: "page.rename", name: "Kept Name" })]);
    text(b, "unlinked");
    expect(livePages()).toEqual(["Home", "Kept Name"]);
  });
});
