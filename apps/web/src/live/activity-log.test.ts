import { describe, expect, it } from "vitest";
import { createActivityLog, describeCommandActivity } from "./activity-log.js";

describe("createActivityLog", () => {
  it("records most-recent-first", () => {
    const log = createActivityLog();
    log.record("first", 1);
    log.record("second", 2);
    expect(log.list().map((e) => e.text)).toEqual(["second", "first"]);
  });

  it("caps at 20 entries", () => {
    const log = createActivityLog();
    for (let i = 0; i < 25; i++) log.record(`entry ${i}`, i);
    expect(log.list()).toHaveLength(20);
    expect(log.list()[0]?.text).toBe("entry 24");
  });

  it("notifies subscribers on every record, with unsubscribe working", () => {
    const log = createActivityLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((entries) => seen.push(entries.length));
    log.record("a");
    log.record("b");
    unsubscribe();
    log.record("c");
    expect(seen).toEqual([1, 2]);
  });
});

describe("describeCommandActivity", () => {
  it("phrases a successful nav.openPage/nav.revealBlock distinctly", () => {
    expect(describeCommandActivity("nav.openPage", "ran")).toBe("Claude opened a page");
    expect(describeCommandActivity("nav.revealBlock", "ran")).toBe("Claude looked at a block");
  });

  it("phrases a generic successful command", () => {
    expect(describeCommandActivity("task.setMarkerDone", "ran")).toBe(
      "Claude ran task.setMarkerDone",
    );
  });

  it("phrases skipped/unknown/not_permitted outcomes distinctly from a success", () => {
    expect(describeCommandActivity("task.setPriorityA", "skipped_when_false")).toMatch(
      /not applicable/,
    );
    expect(describeCommandActivity("bogus.command", "unknown_command")).toMatch(/unknown command/);
    expect(describeCommandActivity("app.quit", "not_permitted")).toMatch(/not allowed/);
  });
});
