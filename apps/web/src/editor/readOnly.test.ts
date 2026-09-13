import { describe, expect, it } from "vitest";
import { isReadOnlyValue } from "./readOnly.js";

describe("isReadOnlyValue", () => {
  it("locks only on an explicit true", () => {
    expect(isReadOnlyValue("true")).toBe(true);
    expect(isReadOnlyValue(" TRUE ")).toBe(true);
    for (const v of ["false", "", "yes", "1", "truee", undefined, null]) {
      expect(isReadOnlyValue(v), String(v)).toBe(false);
    }
  });
});
