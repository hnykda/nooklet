import { describe, expect, it } from "vitest";
import { createToken, revokeToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { resolveStdioAuth } from "./stdio.js";

describe("nooklet mcp --stdio auth (B-59)", () => {
  it("grants ui:control to a --ui-control token, exactly like the HTTP mounts", () => {
    const driver = openDb({ path: ":memory:" });
    const { token, id } = createToken(driver, {
      label: "desktop",
      scope: "write",
      uiControl: true,
    });
    const auth = resolveStdioAuth(driver, token);
    expect(auth.scopes).toEqual(["read", "write", "ui:control"]);
    expect(auth.actor).toEqual({ label: "desktop", tokenId: id });
  });

  it("does not invent ui:control for a token created without it", () => {
    const driver = openDb({ path: ":memory:" });
    const { token } = createToken(driver, { label: "plain", scope: "admin" });
    expect(resolveStdioAuth(driver, token).scopes).toEqual(["read", "write", "admin"]);
  });

  it("refuses a missing or revoked token before serving anything", () => {
    const driver = openDb({ path: ":memory:" });
    expect(() => resolveStdioAuth(driver, undefined)).toThrow(/requires a token/);
    const { token, id } = createToken(driver, { label: "gone", scope: "read" });
    revokeToken(driver, id);
    expect(() => resolveStdioAuth(driver, token)).toThrow(/invalid or revoked/);
  });
});
