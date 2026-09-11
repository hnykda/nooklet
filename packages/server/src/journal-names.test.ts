/**
 * ADR 018: journal pages stored under their ISO name, and every recognised way of writing a date
 * indexed as one reference.
 *
 * The two halves are tested together because separately neither is worth much: canonical names
 * with uncanonicalised references means a journal's backlinks are empty, and canonical references
 * to pages stored under a display format means they resolve to nothing.
 */

import { newId, type Op } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { migrateJournalNames } from "./journal-names.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function apply(ops: Op[]): void {
  serverApplyOps(ctx, ops, { origin: "user", actor: "test" });
}

function op(entity: string, payload: Op["payload"]): Op {
  const hlc = ctx.hlc.next();
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

function page(name: string, journalDay: number | null = null): string {
  const id = newId();
  apply([op(id, { kind: "page.create", name, journalDay, createdAt: Date.now() })]);
  return id;
}

function block(pageId: string, content: string): string {
  const id = newId();
  apply([
    op(id, {
      kind: "block.create",
      place: { pageId, parentId: null, order: "a0" },
      content,
      createdAt: Date.now(),
    }),
  ]);
  return id;
}

/** Every distinct page key the reference index points at, for one block. DISTINCT because `ref`
 *  carries one row per occurrence — four ways of writing the same day is four rows, which is the
 *  point being made, not a problem. */
function refKeys(blockId: string): string[] {
  return ctx.driver
    .all<{ dst_page_key: string }>(
      "SELECT DISTINCT dst_page_key FROM ref WHERE src_block_id = ? AND dst_page_key IS NOT NULL ORDER BY 1",
      [blockId],
    )
    .map((r) => r.dst_page_key);
}

describe("reference canonicalisation", () => {
  it("indexes every journal title format under one key", () => {
    const p = page("Notes");
    const b = block(
      p,
      "see [[Mon, 07.09.2026]] and [[Sep 7th, 2026]] and [[2026-09-07]] and [[07.09.2026]]",
    );
    expect(refKeys(b)).toEqual(["2026-09-07"]);
  });

  it("resolves those references to the journal page itself", () => {
    const journal = page("2026-09-07", 20260907);
    const b = block(page("Notes"), "wrote it up on [[Sep 7th, 2026]]");
    const row = ctx.driver.get<{ dst_page_id: string | null }>(
      "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
      [b],
    );
    expect(row?.dst_page_id).toBe(journal);
  });

  it("leaves a page whose name merely contains digits alone", () => {
    const b = block(page("Notes"), "see [[97 poets of Revachol]] and [[v1.2.3]]");
    expect(refKeys(b)).toEqual(["97 poets of revachol", "v1.2.3"]);
  });
});

describe("migrateJournalNames", () => {
  /** A journal page written the way a pre-ADR-018 graph (or the Logseq importer) wrote them: the
   *  op carries the ISO name now, so the old shape has to be forced into the row directly. */
  function legacyJournal(name: string, day: number): string {
    const id = page(name, day);
    ctx.driver.run("UPDATE page SET name = ?, key = ? WHERE id = ?", [
      name,
      name.toLowerCase(),
      id,
    ]);
    return id;
  }

  /** Rewrite one block's reference rows to the key a pre-ADR-018 server would have written. */
  function legacyRef(blockId: string, oldKey: string, pageId: string): void {
    ctx.driver.run("UPDATE ref SET dst_page_key = ?, dst_page_id = ? WHERE src_block_id = ?", [
      oldKey,
      pageId,
      blockId,
    ]);
    ctx.driver.run(
      "UPDATE path_ref SET page_key = ?, page_id = ? WHERE block_id = ? AND page_id = ?",
      [oldKey, pageId, blockId, pageId],
    );
  }

  it("gives every journal page its ISO name, through real ops", () => {
    const id = legacyJournal("Mon, 07.09.2026", 20260907);
    const before = ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n ?? 0;

    const result = migrateJournalNames(ctx);

    expect(result.renamed).toBe(1);
    const row = ctx.driver.get<{ name: string; key: string }>(
      "SELECT name, key FROM page WHERE id = ?",
      [id],
    );
    expect(row).toEqual({ name: "2026-09-07", key: "2026-09-07" });
    // Real ops, not a raw UPDATE — that is what makes the rename reach other devices and survive
    // `nooklet verify`'s rebuild-from-the-log comparison.
    const after = ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n ?? 0;
    expect(after).toBe(before + 1);
  });

  it("re-points references written before the rename at the ISO key", () => {
    const journal = legacyJournal("Mon, 07.09.2026", 20260907);
    const b = block(page("Notes"), "see [[Mon, 07.09.2026]]");
    // The index is canonical from the moment it is written now, so a genuinely pre-ADR-018 graph
    // has to be staged by hand: this is the row shape that is out there in existing databases.
    legacyRef(b, "mon, 07.09.2026", journal);
    expect(refKeys(b)).toEqual(["mon, 07.09.2026"]);

    migrateJournalNames(ctx);

    expect(refKeys(b)).toEqual(["2026-09-07"]);
    const row = ctx.driver.get<{ dst_page_id: string | null }>(
      "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
      [b],
    );
    expect(row?.dst_page_id).toBe(journal);
  });

  it("resolves a reference that was already ISO but had nothing to point at", () => {
    const b = block(page("Notes"), "planned for [[2026-09-07]]");
    expect(
      ctx.driver.get<{ dst_page_id: string | null }>(
        "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
        [b],
      )?.dst_page_id,
    ).toBeNull();

    const journal = legacyJournal("Mon, 07.09.2026", 20260907);
    migrateJournalNames(ctx);

    expect(
      ctx.driver.get<{ dst_page_id: string | null }>(
        "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
        [b],
      )?.dst_page_id,
    ).toBe(journal);
  });

  it("runs once and is a no-op thereafter", () => {
    legacyJournal("Mon, 07.09.2026", 20260907);
    expect(migrateJournalNames(ctx).renamed).toBe(1);
    const second = migrateJournalNames(ctx);
    expect(second.alreadyDone).toBe(true);
    expect(second.renamed).toBe(0);
  });

  it("leaves a journal alone when an unrelated page already owns its ISO name", () => {
    const journal = legacyJournal("Mon, 07.09.2026", 20260907);
    page("2026-09-07"); // an ordinary page someone happened to name this

    const result = migrateJournalNames(ctx);

    expect(result.renamed).toBe(0);
    expect(result.collided).toEqual(["Mon, 07.09.2026"]);
    expect(
      ctx.driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [journal])?.name,
    ).toBe("Mon, 07.09.2026");
  });

  it("keeps the journal's #Journal tag pointing at the renamed page", () => {
    const journal = legacyJournal("Mon, 07.09.2026", 20260907);
    migrateJournalNames(ctx);
    const tag = ctx.driver.get<{ tag_key: string; source: string }>(
      "SELECT tag_key, source FROM page_tag WHERE page_id = ?",
      [journal],
    );
    expect(tag).toEqual({ tag_key: "journal", source: "intrinsic" });
  });
});
