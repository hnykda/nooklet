import { describe, expect, it } from "vitest";
import {
  cycleTaskMarker,
  inferTaskWorkflow,
  parseTaskWorkflow,
  repeatReopenMarker,
  workflowStartMarker,
} from "./task-workflow.js";

// Expected values are Logseq 0.10.9's `util/marker.cljs#cycle-marker-state`, quoted in
// docs/progress/tasks-workflow.md (B-608).
describe("cycleTaskMarker", () => {
  it("under `now`: none → LATER → NOW → DONE → none (the owner's graph)", () => {
    expect(cycleTaskMarker(null, "now")).toBe("LATER");
    expect(cycleTaskMarker("LATER", "now")).toBe("NOW");
    expect(cycleTaskMarker("NOW", "now")).toBe("DONE");
    expect(cycleTaskMarker("DONE", "now")).toBeNull();
  });

  it("under `todo`: none → TODO → DOING → DONE → none", () => {
    expect(cycleTaskMarker(null, "todo")).toBe("TODO");
    expect(cycleTaskMarker("TODO", "todo")).toBe("DOING");
    expect(cycleTaskMarker("DOING", "todo")).toBe("DONE");
    expect(cycleTaskMarker("DONE", "todo")).toBeNull();
  });

  it("keys the pair on the current marker, not the workflow", () => {
    expect(cycleTaskMarker("TODO", "now")).toBe("DOING");
    expect(cycleTaskMarker("DOING", "now")).toBe("DONE");
    expect(cycleTaskMarker("LATER", "todo")).toBe("NOW");
    expect(cycleTaskMarker("NOW", "todo")).toBe("DONE");
  });

  it("WAITING and CANCELED restart at the workflow's start marker", () => {
    expect(cycleTaskMarker("WAITING", "now")).toBe("LATER");
    expect(cycleTaskMarker("CANCELED", "now")).toBe("LATER");
    expect(cycleTaskMarker("WAITING", "todo")).toBe("TODO");
    expect(cycleTaskMarker("CANCELED", "todo")).toBe("TODO");
  });
});

describe("workflow helpers", () => {
  it("start marker", () => {
    expect(workflowStartMarker("now")).toBe("LATER");
    expect(workflowStartMarker("todo")).toBe("TODO");
  });

  it("a repeating task reopens in its own pair", () => {
    expect(repeatReopenMarker("NOW")).toBe("LATER");
    expect(repeatReopenMarker("LATER")).toBe("LATER");
    expect(repeatReopenMarker("DOING")).toBe("TODO");
    expect(repeatReopenMarker("TODO")).toBe("TODO");
    expect(repeatReopenMarker(null)).toBe("TODO");
  });

  it("parses like Logseq's get-preferred-workflow", () => {
    expect(parseTaskWorkflow(":now")).toBe("now");
    expect(parseTaskWorkflow("NOW")).toBe("now");
    expect(parseTaskWorkflow("todo")).toBe("todo");
    expect(parseTaskWorkflow("anything-else")).toBe("todo");
    expect(parseTaskWorkflow("")).toBeNull();
    expect(parseTaskWorkflow(null)).toBeNull();
  });

  it("infers from markers; empty or tied is `now`, Logseq's default", () => {
    expect(inferTaskWorkflow({ laterNow: 77, todoDoing: 0 })).toBe("now");
    expect(inferTaskWorkflow({ laterNow: 0, todoDoing: 3 })).toBe("todo");
    expect(inferTaskWorkflow({ laterNow: 0, todoDoing: 0 })).toBe("now");
    expect(inferTaskWorkflow({ laterNow: 2, todoDoing: 2 })).toBe("now");
  });
});
