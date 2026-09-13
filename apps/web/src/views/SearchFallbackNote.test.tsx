// @vitest-environment jsdom
/**
 * B-520: every reason the server gives for falling back to keyword search gets its own sentence
 * and the action that fits it — one test per reason, rendered, plus the two degraded inputs (a
 * reason this client does not know, and a server that sends no reason at all).
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchFallback } from "../data/api-client.js";
import { explainFallback, SearchFallbackNote } from "./SearchFallbackNote.js";

afterEach(cleanup);

function renderNote(fallback: SearchFallback | undefined) {
  const onOpenSettings = vi.fn();
  const onRetry = vi.fn();
  render(() => (
    <SearchFallbackNote
      modeUsed="keyword"
      fallback={fallback}
      onOpenSettings={onOpenSettings}
      onRetry={onRetry}
    />
  ));
  const note = document.querySelector(".search-fallback") as HTMLElement;
  const actions = [...note.querySelectorAll("button")].map((b) => b.textContent);
  return { note, text: note.textContent ?? "", actions, onOpenSettings, onRetry };
}

describe("SearchFallbackNote (B-520)", () => {
  it("not_configured: says semantic search is not set up and offers to set it up in Settings", () => {
    const { text, actions, onOpenSettings, onRetry } = renderNote({
      reason: "not_configured",
      message: "Semantic search is not set up: no embedding model is configured.",
    });
    expect(text).toContain("Fell back to keyword search: semantic search is not set up.");
    expect(actions).toEqual(["Set up semantic search…"]);
    fireEvent.click(screen.getByRole("button", { name: "Set up semantic search…" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("provider_unreachable: names the address and the error, offers Try again and Settings", () => {
    const { text, actions, onRetry, onOpenSettings } = renderNote({
      reason: "provider_unreachable",
      message: "The embedding server at http://127.0.0.1:11434 is not reachable (…).",
      provider: "ollama",
      model: "bge-m3",
      host: "http://127.0.0.1:11434",
      error: "fetch failed: connect ECONNREFUSED 127.0.0.1:11434",
    });
    expect(text).toContain("the embedding service at http://127.0.0.1:11434 is not reachable.");
    expect(text).toContain("(fetch failed: connect ECONNREFUSED 127.0.0.1:11434)");
    expect(actions).toEqual(["Try again", "Search settings"]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("indexing: says the index is still building, N of M, and offers Check again", () => {
    const { text, actions, onRetry } = renderNote({
      reason: "indexing",
      message: "The semantic index for ollama:bge-m3 is still being built (512 of 900 embedded).",
      provider: "ollama",
      model: "bge-m3",
      host: "http://127.0.0.1:11434",
      indexed: 512,
      total: 900,
      errors: 0,
    });
    expect(text).toContain("the semantic index is still being built (512 of 900 embedded).");
    expect(text).not.toContain("failed");
    expect(actions).toEqual(["Check again"]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("indexing with failures so far says how many", () => {
    const { text } = renderNote({
      reason: "indexing",
      message: "…",
      indexed: 10,
      total: 900,
      errors: 64,
    });
    expect(text).toContain("(10 of 900 embedded). 64 failed so far.");
  });

  it("index_incomplete: says indexing stopped, with counts and the last error, and points to Settings", () => {
    const { text, actions } = renderNote({
      reason: "index_incomplete",
      message: "…",
      indexed: 700,
      total: 900,
      errors: 200,
      error: "ollama /api/embed 500: out of memory",
    });
    expect(text).toContain(
      "indexing stopped: 200 item(s) failed to embed (700 of 900 embedded), so semantic search was not switched on.",
    );
    expect(text).toContain("(ollama /api/embed 500: out of memory)");
    expect(actions).toEqual(["Search settings"]);
  });

  it("sqlite_vec_unavailable: says it cannot run on this server, with the load error, and offers nothing", () => {
    const { text, actions } = renderNote({
      reason: "sqlite_vec_unavailable",
      message: "…",
      error: "dlopen(vec0.dylib): image not found",
    });
    expect(text).toContain("semantic search cannot run on this server");
    expect(text).toContain("(dlopen(vec0.dylib): image not found)");
    expect(actions).toEqual([]);
  });

  it("model_missing: names the model and the server", () => {
    const { text, actions } = renderNote({
      reason: "model_missing",
      message: "…",
      model: "bge-m3",
      host: "http://127.0.0.1:11434",
      error: 'ollama /api/embed 404: {"error":"model \\"bge-m3\\" not found"}',
    });
    expect(text).toContain(
      "the embedding service at http://127.0.0.1:11434 has no model named “bge-m3”.",
    );
    expect(actions).toEqual(["Search settings"]);
  });

  it("query_embedding_failed: says embedding the query failed, with the error, and offers Try again", () => {
    const { text, actions } = renderNote({
      reason: "query_embedding_failed",
      message: "…",
      error: "ollama /api/embed 500: boom",
    });
    expect(text).toContain("embedding the query failed. (ollama /api/embed 500: boom)");
    expect(actions).toEqual(["Try again"]);
  });

  it("shortens a long error on screen and keeps the full text in the title", () => {
    const long = `ollama /api/embed 500: ${"x".repeat(400)}`;
    const { note } = renderNote({ reason: "query_embedding_failed", message: "…", error: long });
    const detail = note.querySelector(".search-fallback-detail") as HTMLElement;
    expect(detail.getAttribute("title")).toBe(long);
    expect((detail.textContent ?? "").length).toBeLessThan(200);
  });

  it("a reason this client does not know shows the server's own message", () => {
    const { text, actions } = renderNote({
      reason: "some_future_reason",
      message: "The index is being migrated.",
    });
    expect(text).toContain("Fell back to keyword search: The index is being migrated.");
    expect(actions).toEqual([]);
  });

  it("a server that sends no reason gets the old sentence", () => {
    const { text, actions } = renderNote(undefined);
    expect(text).toBe("Fell back to keyword search.");
    expect(actions).toEqual([]);
    expect(explainFallback(undefined)).toEqual({ text: "", actions: [] });
  });
});
