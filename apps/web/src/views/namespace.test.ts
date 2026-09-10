import { describe, expect, it } from "vitest";
import { isNamespaceChild, namespaceLabel } from "./namespace.js";

describe("namespaceLabel", () => {
  it("splits a namespaced name into parent + short form", () => {
    expect(namespaceLabel("Projects/Aurora/Launch")).toEqual({
      parent: "Projects/Aurora",
      short: "Launch",
    });
  });

  it("has no parent for a top-level page", () => {
    expect(namespaceLabel("Projects")).toEqual({ parent: null, short: "Projects" });
  });
});

describe("isNamespaceChild", () => {
  it("matches direct and indirect children", () => {
    expect(isNamespaceChild("projects/aurora", "projects")).toBe(true);
    expect(isNamespaceChild("projects/aurora/launch", "projects")).toBe(true);
  });

  it("does not match the namespace page itself", () => {
    expect(isNamespaceChild("projects", "projects")).toBe(false);
  });

  it("respects the '/' boundary (a name that merely starts with the same letters is not a child)", () => {
    expect(isNamespaceChild("projectsxyz", "projects")).toBe(false);
  });

  it("does not match an unrelated page", () => {
    expect(isNamespaceChild("vendors/acme", "projects")).toBe(false);
  });
});
