import { describe, expect, it } from "vitest";
import {
  assertApiSupported,
  isApiSupported,
  PluginLoadError,
  SUPPORTED_API_MAJORS,
} from "./api-version.js";

describe("api version compatibility", () => {
  it('supports exactly api major "1" in this build', () => {
    expect([...SUPPORTED_API_MAJORS]).toEqual(["1"]);
    expect(isApiSupported("1")).toBe(true);
  });

  it("rejects any other api major", () => {
    expect(isApiSupported("2")).toBe(false);
    expect(isApiSupported("0")).toBe(false);
    expect(isApiSupported("")).toBe(false);
  });

  it("assertApiSupported is a no-op for a supported plugin", () => {
    expect(() => assertApiSupported({ id: "ok-plugin", api: "1" })).not.toThrow();
  });

  it("assertApiSupported throws PluginLoadError naming the plugin and the unsupported version", () => {
    expect(() => assertApiSupported({ id: "future-plugin", api: "2" })).toThrow(PluginLoadError);

    let caught: unknown;
    try {
      assertApiSupported({ id: "future-plugin", api: "2" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as Error).message).toContain("future-plugin");
    expect((caught as Error).message).toContain("2");
    expect((caught as Error).message).toContain("1"); // names what the host DOES support
  });
});
