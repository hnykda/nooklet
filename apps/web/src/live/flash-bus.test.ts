import { describe, expect, it } from "vitest";
import { flashRemoteTouch, subscribeFlash } from "./flash-bus.js";

describe("flash-bus", () => {
  it("notifies every subscriber with the touched block id, attributed to the agent", () => {
    const seen: Array<{ blockId: string; actor: string }> = [];
    const unsubscribe = subscribeFlash((e) => seen.push(e));
    flashRemoteTouch("1k7f3qa2m9xzr7");
    unsubscribe();
    expect(seen).toEqual([{ blockId: "1k7f3qa2m9xzr7", actor: "agent" }]);
  });

  it("unsubscribe stops delivery", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeFlash((e) => seen.push(e.blockId));
    unsubscribe();
    flashRemoteTouch("ghost");
    expect(seen).toEqual([]);
  });

  it("is a harmless no-op with zero subscribers", () => {
    expect(() => flashRemoteTouch("nobody-listening")).not.toThrow();
  });

  it("supports more than one concurrent subscriber", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeFlash((e) => a.push(e.blockId));
    const unsubB = subscribeFlash((e) => b.push(e.blockId));
    flashRemoteTouch("x1");
    unsubA();
    unsubB();
    expect(a).toEqual(["x1"]);
    expect(b).toEqual(["x1"]);
  });
});
