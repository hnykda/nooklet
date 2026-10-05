import { describe, expect, it } from "vitest";
import { macDeletionDialog, removalDialog } from "./graph-removal.js";

describe("B-786: deleting a graph on This Mac (desktop)", () => {
  it("the only copy, typed 'delete', and the Trash named as where it goes and how it comes back", () => {
    const d = macDeletionDialog({ name: "Garden", id: "garden" });
    expect(d.typeToConfirm).toBe("delete");
    expect(d.destructive).toBe(true);
    expect(d.warning).toContain("only copy of “Garden”");
    const text = d.message.join(" ");
    expect(text).toContain("moved to the Trash, not erased");
    expect(text).toContain("graphs/garden");
    expect(text).toContain("rename it garden");
    expect(d.confirmLabel).toBe("Move to Trash");
  });
});

describe("B-712: removing a graph from this device", () => {
  it("a local-only graph: the only copy, permanent, typed 'delete', export said plainly", () => {
    const d = removalDialog({ name: "Sea Glass", place: "device", pending: 0 });
    expect(d.typeToConfirm).toBe("delete");
    expect(d.warning).toContain("only copy");
    expect(d.warning).toContain("cannot be undone");
    expect(d.message.join(" ")).toContain("cannot export a whole graph yet");
    expect(d.message.join(" ")).toContain("Add a server for this graph");
    expect(d.destructive).toBe(true);
  });

  it("a server graph with nothing unsynced: a plain confirm that says the server keeps it", () => {
    const d = removalDialog({
      name: "Work",
      place: "server",
      host: "notes.example.com",
      pending: 0,
    });
    expect(d.typeToConfirm).toBeUndefined();
    expect(d.warning).toBeUndefined();
    expect(d.message.join(" ")).toContain("The server at notes.example.com keeps “Work”");
    expect(d.message.join(" ")).toContain("other devices are unaffected");
  });

  it("a server graph with unsynced changes: how many are lost, and typed 'delete'", () => {
    const d = removalDialog({ name: "Work", place: "server", pending: 3 });
    expect(d.typeToConfirm).toBe("delete");
    expect(d.warning).toBe(
      "3 changes made on this device have not reached the server yet and will be lost.",
    );
    expect(removalDialog({ name: "W", place: "server", pending: 1 }).warning).toContain(
      "1 change made on this device has not",
    );
  });

  it("a server graph whose unsynced count is unknown is treated as having some", () => {
    const d = removalDialog({ name: "Work", place: "server", pending: undefined });
    expect(d.typeToConfirm).toBe("delete");
    expect(d.warning).toContain("cannot tell");
  });
});
