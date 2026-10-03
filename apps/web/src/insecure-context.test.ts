import { describe, expect, it } from "vitest";
import { cannotRunHere } from "./insecure-context.js";

describe("cannotRunHere (B-615)", () => {
  const ok = { isSecureContext: true, hasRandomUUID: true, hasLocks: true };

  it("runs in a secure context that has what the app uses", () => {
    expect(cannotRunHere(ok)).toBe(false);
    // Unknown (no window, e.g. a worker-less test host) is judged by the APIs alone.
    expect(cannotRunHere({ ...ok, isSecureContext: undefined })).toBe(false);
  });

  it("refuses an insecure context, or one missing either API", () => {
    expect(cannotRunHere({ ...ok, isSecureContext: false })).toBe(true);
    expect(cannotRunHere({ ...ok, hasRandomUUID: false })).toBe(true);
    expect(cannotRunHere({ ...ok, hasLocks: false })).toBe(true);
  });
});
