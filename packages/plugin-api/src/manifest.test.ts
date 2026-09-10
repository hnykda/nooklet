import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";

/** The worked example from `docs/spec/api-and-plugin-types.md` §Examples (`plugins/mermaid-tools/package.json#nooklet`). */
const MERMAID_TOOLS_MANIFEST = {
  id: "mermaid-tools",
  name: "Mermaid + word count",
  api: "1",
  server: "./src/server.ts",
  client: "./src/client.ts",
  permissions: [],
  contributes: { slash: [{ id: "mermaid", label: "Mermaid diagram" }] },
};

describe("validateManifest", () => {
  it("accepts the spec's worked example plugin", () => {
    const result = validateManifest(MERMAID_TOOLS_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    if (result.valid) expect(result.manifest.id).toBe("mermaid-tools");
  });

  it("accepts a minimal manifest with only client + api + id", () => {
    const result = validateManifest({ id: "tiny", api: "1", client: "./client.ts" });
    expect(result.valid).toBe(true);
  });

  it("rejects a manifest missing id", () => {
    const result = validateManifest({ api: "1", server: "./server.ts" });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "id" }),
    );
  });

  it("rejects a manifest with the wrong api version", () => {
    const result = validateManifest({ id: "old", api: "2", server: "./server.ts" });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "api" }),
    );
  });

  it("rejects an unknown permission", () => {
    const result = validateManifest({
      id: "greedy",
      api: "1",
      server: "./server.ts",
      permissions: ["net", "root"],
    });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "permissions[1]" }),
    );
  });

  it("rejects malformed contributes (slash entry missing label)", () => {
    const result = validateManifest({
      id: "broken",
      api: "1",
      client: "./client.ts",
      contributes: { slash: [{ id: "foo" }] },
    });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "contributes.slash[0].label" }),
    );
  });

  it("rejects malformed contributes (commands not an array)", () => {
    const result = validateManifest({
      id: "broken2",
      api: "1",
      client: "./client.ts",
      contributes: { commands: "nope" },
    });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "contributes.commands" }),
    );
  });

  it("rejects a manifest declaring neither server nor client (rule 14)", () => {
    const result = validateManifest({ id: "nohalf", api: "1" });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(expect.objectContaining({ path: "" }));
  });

  it("rejects a non-object value", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest("nope").valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
  });

  it("rejects an id with invalid characters", () => {
    const result = validateManifest({ id: "Not_Valid!", api: "1", client: "./c.ts" });
    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "id" }),
    );
  });
});
