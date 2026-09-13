import { describe, expect, it, vi } from "vitest";

vi.mock("../data/api-client.js", () => ({
  describeError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import type { PageDeletePreview, PageToDelete } from "../data/page-delete.js";
import {
  AFTER_DELETE_PATH,
  deletePageWithConfirm,
  JOURNAL_DELETE_NOTICE,
  type PageDeleteDeps,
  pageDeleteConfirmation,
} from "./page-delete.js";

const aurora: PageToDelete = { id: "pg000000000001", name: "Projects/Aurora", journalDay: null };

function deps(over: {
  page?: PageToDelete | undefined;
  preview?: PageDeletePreview | Error;
  answer?: boolean;
  remove?: Error;
}) {
  const calls: string[] = [];
  const d: PageDeleteDeps = {
    async findPage(name) {
      calls.push(`find ${name}`);
      return "page" in over ? over.page : aurora;
    },
    async preview(id) {
      calls.push(`preview ${id}`);
      if (over.preview instanceof Error) throw over.preview;
      return over.preview ?? { blocks: 3, backlinks: 0 };
    },
    async confirm(o) {
      calls.push(`confirm ${o.title}`);
      return over.answer ?? true;
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      if (over.remove) throw over.remove;
    },
    navigate(path) {
      calls.push(`navigate ${path}`);
    },
    notify(text, error) {
      calls.push(`notify${error ? " error" : ""} ${text}`);
    },
  };
  return { d, calls };
}

describe("deletePageWithConfirm", () => {
  it("asks with the dry run's numbers, deletes, then goes to the journal", async () => {
    const { d, calls } = deps({});
    expect(await deletePageWithConfirm("projects/aurora", d)).toBe("deleted");
    expect(calls).toEqual([
      "find projects/aurora",
      `preview ${aurora.id}`,
      'confirm Delete "Projects/Aurora"?',
      `remove ${aurora.id}`,
      `navigate ${AFTER_DELETE_PATH}`,
    ]);
    expect(AFTER_DELETE_PATH).toBe("/journals");
  });

  it("Cancel deletes nothing and stays on the page", async () => {
    const { d, calls } = deps({ answer: false });
    expect(await deletePageWithConfirm("Projects/Aurora", d)).toBe("cancelled");
    expect(calls.some((c) => c.startsWith("remove"))).toBe(false);
    expect(calls.some((c) => c.startsWith("navigate"))).toBe(false);
  });

  it("a journal day is refused before anything is asked or sent (PLAN §8, ADR 018)", async () => {
    const { d, calls } = deps({ page: { id: "pgday", name: "2026-09-13", journalDay: 20260913 } });
    expect(await deletePageWithConfirm("2026-09-13", d)).toBe("journal");
    expect(calls).toEqual(["find 2026-09-13", `notify error ${JOURNAL_DELETE_NOTICE}`]);
  });

  it("a page that is not there says so", async () => {
    const { d, calls } = deps({ page: undefined });
    expect(await deletePageWithConfirm("Gone", d)).toBe("missing");
    expect(calls).toEqual(["find Gone", 'notify error Couldn\'t delete — no page named "Gone"']);
  });

  it("a refused dry run or delete is shown, and nothing navigates", async () => {
    const refused = deps({ preview: new Error("no page named x") });
    expect(await deletePageWithConfirm("Projects/Aurora", refused.d)).toBe("failed");
    expect(refused.calls.at(-1)).toBe(
      'notify error Couldn\'t delete "Projects/Aurora": no page named x',
    );
    expect(refused.calls.some((c) => c.startsWith("confirm"))).toBe(false);

    const failed = deps({ remove: new Error("offline") });
    expect(await deletePageWithConfirm("Projects/Aurora", failed.d)).toBe("failed");
    expect(failed.calls.at(-1)).toBe('notify error Couldn\'t delete "Projects/Aurora": offline');
    expect(failed.calls.some((c) => c.startsWith("navigate"))).toBe(false);
  });
});

describe("pageDeleteConfirmation", () => {
  it("says the page and its blocks go to the Trash and can be restored", () => {
    const c = pageDeleteConfirmation("Projects/Aurora", { blocks: 12, backlinks: 0 });
    expect(c.title).toBe('Delete "Projects/Aurora"?');
    expect(c.message).toEqual([
      '"Projects/Aurora" and its 12 blocks will be moved to the Trash. You can restore them from there.',
    ]);
    expect(c.confirmLabel).toBe("Delete page");
    expect(c.destructive).toBe(true);
  });

  it("counts in the singular, leaves out blocks a page does not have, and warns about links", () => {
    expect(pageDeleteConfirmation("P", { blocks: 1, backlinks: 1 }).message).toEqual([
      '"P" and its 1 block will be moved to the Trash. You can restore them from there.',
      "1 reference to this page will point at a page that doesn't exist until it is restored.",
    ]);
    expect(pageDeleteConfirmation("P", { blocks: 0, backlinks: 4 }).message).toEqual([
      '"P" will be moved to the Trash. You can restore it from there.',
      "4 references to this page will point at a page that doesn't exist until it is restored.",
    ]);
  });
});
