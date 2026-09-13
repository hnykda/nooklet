import { describe, expect, it, vi } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { createFakeDatePickerHost } from "../registrations/date-picker-host.js";
import { createTaskCommands } from "../registrations/task.js";
import type { CommandContext } from "../types.js";
import { DEFAULT_WHEN_CONTEXT } from "../types.js";
import { createDatePickerHost, type DatePickRequest, type DatePickResult } from "./host.js";

const TODAY = 20260913; // a Sunday

/** Let the host's fire-and-forget `open` finish: two reads, a pick, a write. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(props: Record<string, string | null>, result: DatePickResult | undefined) {
  const store = createFakeStore({ b1: props });
  const requests: DatePickRequest[] = [];
  const pick = vi.fn(async (req: DatePickRequest) => {
    requests.push(req);
    return result;
  });
  const host = createDatePickerHost({
    store,
    pick,
    today: () => TODAY,
    onError: (e) => {
      throw e;
    },
  });
  return { store, host, requests };
}

describe("createDatePickerHost.open (B-96)", () => {
  it("asks the picker with the block's current value and writes the pick in ADR 011's shape", async () => {
    const { store, host, requests } = setup(
      { marker: "TODO", scheduled: "2026-09-20 14:00", repeat: "1w" },
      { kind: "set", day: 20260918, time: "09:30" },
    );
    host.open({ blockId: "b1", field: "scheduled" });
    await settle();
    expect(requests).toEqual([
      {
        blockId: "b1",
        field: "scheduled",
        current: { day: 20260920, time: "14:00" },
        repeat: "1w",
        today: TODAY,
        anchor: undefined,
      },
    ]);
    expect(store.props.get("b1")).toMatchObject({ scheduled: "2026-09-18 09:30", repeat: "1w" });
  });

  it("a cancelled pick writes nothing", async () => {
    const { store, host } = setup({ marker: "TODO", deadline: "2026-09-20" }, undefined);
    const spy = vi.spyOn(store, "setBlockProps");
    host.open({ blockId: "b1", field: "deadline" });
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(store.props.get("b1")?.deadline).toBe("2026-09-20");
  });

  it("a typed repeat is written in the same batch; an unchanged one is not rewritten", async () => {
    const a = setup({}, { kind: "set", day: 20260914, time: null, repeat: "2w from done" });
    const spyA = vi.spyOn(a.store, "setBlockProps");
    a.host.open({ blockId: "b1", field: "deadline" });
    await settle();
    expect(spyA).toHaveBeenCalledWith("b1", { deadline: "2026-09-14", repeat: "2w from done" });

    const b = setup({ repeat: "1w" }, { kind: "set", day: 20260914, time: null, repeat: "1w" });
    const spyB = vi.spyOn(b.store, "setBlockProps");
    b.host.open({ blockId: "b1", field: "scheduled" });
    await settle();
    expect(spyB).toHaveBeenCalledWith("b1", { scheduled: "2026-09-14" });
  });

  it("clearing the last date also drops the repeat; clearing one of two keeps it", async () => {
    const last = setup({ scheduled: "2026-09-14", repeat: "1w" }, { kind: "clear" });
    const spyLast = vi.spyOn(last.store, "setBlockProps");
    last.host.open({ blockId: "b1", field: "scheduled" });
    await settle();
    expect(spyLast).toHaveBeenCalledWith("b1", { scheduled: null, repeat: null });

    const both = setup(
      { scheduled: "2026-09-14", deadline: "2026-09-20", repeat: "1w" },
      { kind: "clear" },
    );
    const spyBoth = vi.spyOn(both.store, "setBlockProps");
    both.host.open({ blockId: "b1", field: "scheduled" });
    await settle();
    expect(spyBoth).toHaveBeenCalledWith("b1", { scheduled: null });
  });
});

describe("createDatePickerHost.set (agents, no picker)", () => {
  it("accepts what the picker's text field accepts, keeps an existing time, clears on null", async () => {
    const { store, host } = setup({ scheduled: "2026-09-01 08:00" }, undefined);
    await host.set({ blockId: "b1", field: "scheduled", input: "tomorrow" });
    expect(store.props.get("b1")?.scheduled).toBe("2026-09-14 08:00");
    await host.set({ blockId: "b1", field: "scheduled", input: "fri no time" });
    expect(store.props.get("b1")?.scheduled).toBe("2026-09-18");
    await host.set({ blockId: "b1", field: "scheduled", input: null });
    expect(store.props.get("b1")?.scheduled).toBeNull();
  });

  it("rejects text that is not a date, writing nothing", async () => {
    const { store, host } = setup({ deadline: "2026-09-20" }, undefined);
    await expect(host.set({ blockId: "b1", field: "deadline", input: "banana" })).rejects.toThrow(
      /not a date/,
    );
    expect(store.props.get("b1")?.deadline).toBe("2026-09-20");
  });
});

describe("task.setScheduled / task.setDeadline route to the host (R38)", () => {
  function ctx(args?: unknown): CommandContext {
    return {
      ...DEFAULT_WHEN_CONTEXT,
      editorFocused: true,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
      args,
    };
  }

  it("no argument opens the picker; a string or {date} argument is written directly", async () => {
    const datePicker = createFakeDatePickerHost();
    const commands = createTaskCommands({ datePicker });
    const scheduled = commands.find((c) => c.id === "task.setScheduled");
    const deadline = commands.find((c) => c.id === "task.setDeadline");
    await scheduled?.run(ctx());
    await deadline?.run(ctx("+3d"));
    await deadline?.run(ctx({ date: null }));
    expect(datePicker.calls).toEqual([{ blockId: "b1", field: "scheduled" }]);
    expect(datePicker.sets).toEqual([
      { blockId: "b1", field: "deadline", input: "+3d" },
      { blockId: "b1", field: "deadline", input: null },
    ]);
    await expect(deadline?.run(ctx(42))).rejects.toThrow(/date string or null/);
  });
});
