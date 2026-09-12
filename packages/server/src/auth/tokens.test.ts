import type { SqlDriver } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import {
  allScopesFor,
  createSoleToken,
  createToken,
  getToken,
  revokeToken,
  scopesFor,
  verifyToken,
} from "./tokens.js";

describe("createToken / verifyToken / revokeToken", () => {
  let driver: SqlDriver;

  beforeEach(() => {
    driver = openDb({ path: ":memory:" });
  });

  it("returns the raw token once, storing only its hash", () => {
    const { id, token } = createToken(driver, { label: "cli", scope: "write" });
    expect(token).toMatch(/^nk_[0-9a-f]{48}$/);
    const row = getToken(driver, id);
    expect(row?.token_hash).not.toBe(token);
    expect(row?.label).toBe("cli");
  });

  it("verifies a valid token and bumps last_used_at", () => {
    const { token, id } = createToken(driver, { label: "cli", scope: "read" });
    const before = getToken(driver, id)?.last_used_at;
    expect(before).toBeNull();
    const verified = verifyToken(driver, token);
    expect(verified).toEqual({ id, scope: "read", label: "cli", canSync: false, uiControl: false });
    expect(getToken(driver, id)?.last_used_at).not.toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(verifyToken(driver, "nk_does-not-exist")).toBeNull();
  });

  it("createSoleToken revokes every earlier live token with the same label, and nothing else", () => {
    const first = createSoleToken(driver, { label: "auto", scope: "write", canSync: true });
    const other = createToken(driver, { label: "other", scope: "write" });
    const second = createSoleToken(driver, { label: "auto", scope: "write", canSync: true });
    expect(verifyToken(driver, first.token)).toBeNull();
    expect(verifyToken(driver, second.token)?.id).toBe(second.id);
    expect(verifyToken(driver, other.token)?.id).toBe(other.id);
    const live = driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM token WHERE label = 'auto' AND revoked_at IS NULL",
    );
    expect(live?.n).toBe(1);
  });

  it("rejects a revoked token", () => {
    const { token, id } = createToken(driver, { label: "cli", scope: "admin" });
    expect(revokeToken(driver, id)).toBe(true);
    expect(verifyToken(driver, token)).toBeNull();
    expect(revokeToken(driver, id)).toBe(false); // already revoked
  });

  it("scopesFor expands admin > write > read", () => {
    expect(scopesFor("read")).toEqual(["read"]);
    expect(scopesFor("write")).toEqual(["read", "write"]);
    expect(scopesFor("admin")).toEqual(["read", "write", "admin"]);
  });

  it("ADR 015: ui_control is off by default and orthogonal to scope tier", () => {
    const { token } = createToken(driver, { label: "cli", scope: "admin" });
    const verified = verifyToken(driver, token);
    expect(verified?.uiControl).toBe(false);
    expect(allScopesFor(verified as NonNullable<typeof verified>)).toEqual([
      "read",
      "write",
      "admin",
    ]);
  });

  it("ADR 015: --ui-control adds ui:control without changing the scope tier", () => {
    const { token } = createToken(driver, { label: "agent", scope: "read", uiControl: true });
    const verified = verifyToken(driver, token);
    expect(verified?.scope).toBe("read");
    expect(verified?.uiControl).toBe(true);
    expect(allScopesFor(verified as NonNullable<typeof verified>)).toEqual(["read", "ui:control"]);
  });
});

describe("bearerAuth over HTTP", () => {
  let s: TestServer;

  beforeEach(() => {
    s = makeTestServer();
  });

  it("accepts a valid token (200)", async () => {
    const { status } = await post(s.app, "/api/v1/graph.overview", s.writeToken, {});
    expect(status).toBe(200);
  });

  it("rejects a missing token (401)", async () => {
    const res = await s.app.request("/api/v1/graph.overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  it("rejects an invalid token (401)", async () => {
    const { status, json } = await post(s.app, "/api/v1/graph.overview", "nk_not-a-real-token", {});
    expect(status).toBe(401);
    expect(json.error.code).toBe("unauthorized");
  });

  it("rejects a revoked token (401)", async () => {
    const created = createToken(s.serverCtx.driver, { label: "revoke-me", scope: "write" });
    revokeToken(s.serverCtx.driver, created.id);
    const { status, json } = await post(s.app, "/api/v1/graph.overview", created.token, {});
    expect(status).toBe(401);
    expect(json.error.code).toBe("unauthorized");
  });

  it("rejects a write op called with a read-only token (403 forbidden)", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.create", s.readToken, {
      name: "Nope",
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe("forbidden");
  });

  it("allows a write op with a write token, and reads with either", async () => {
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "ReadableByEither",
    });
    expect(created.status).toBe(200);
    const read = await post(s.app, "/api/v1/page.read", s.readToken, { page: "ReadableByEither" });
    expect(read.status).toBe(200);
  });
});
