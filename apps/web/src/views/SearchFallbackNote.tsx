/**
 * The line over search results that says why a semantic or hybrid search fell back to keyword
 * (B-520).
 *
 * It used to say only "Fell back to keyword search.", which left the owner asking whether
 * semantic search works at all. The server now says which of several different situations it is
 * (`search`'s `fallback`, reasons in `packages/server/src/embeddings/semantic-search.ts`), and
 * each wants a different next step: never set up → Settings; embedding server down → start it
 * and try again; still indexing → wait and check again. So each reason gets its own sentence and
 * the one action that fits it. A reason this client does not know renders the server's own
 * `message`; a server too old to send `fallback` gets the old sentence.
 */

import { Index, type JSX, Show } from "solid-js";
import type { SearchFallback } from "../data/api-client.js";
import "./search-fallback.css";

export type FallbackAction = "settings" | "retry";

export interface FallbackExplanation {
  /** Follows "Fell back to keyword search: ". Empty for a server that sent no reason. */
  text: string;
  /** Verbatim error from the server, shown shortened after the sentence. */
  detail?: string;
  actions: ReadonlyArray<{ kind: FallbackAction; label: string }>;
}

/** Long provider errors are raw HTTP bodies; the full text stays in the element's title. */
const DETAIL_CHARS = 160;

function count(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

/** Pure, so every reason's wording is testable without rendering. */
export function explainFallback(fallback: SearchFallback | undefined): FallbackExplanation {
  if (!fallback) return { text: "", actions: [] };
  const service = fallback.host
    ? `the embedding service at ${fallback.host}`
    : "the embedding service";
  switch (fallback.reason) {
    case "not_configured":
      return {
        text: "semantic search is not set up.",
        actions: [{ kind: "settings", label: "Set up semantic search…" }],
      };
    case "sqlite_vec_unavailable":
      // Nothing in Settings can fix a missing native extension, so no button pretends to.
      return {
        text: "semantic search cannot run on this server — the sqlite-vec extension did not load.",
        detail: fallback.error,
        actions: [],
      };
    case "provider_unreachable":
      return {
        text: `${service} is not reachable.`,
        detail: fallback.error,
        actions: [
          { kind: "retry", label: "Try again" },
          { kind: "settings", label: "Search settings" },
        ],
      };
    case "model_missing":
      return {
        text: `${service} has no model named “${fallback.model ?? "?"}”.`,
        detail: fallback.error,
        actions: [{ kind: "settings", label: "Search settings" }],
      };
    case "indexing": {
      const failed = fallback.errors ? ` ${count(fallback.errors)} failed so far.` : "";
      return {
        text: `the semantic index is still being built (${count(fallback.indexed)} of ${count(fallback.total)} embedded).${failed}`,
        actions: [{ kind: "retry", label: "Check again" }],
      };
    }
    case "index_incomplete":
      return {
        text: `indexing stopped: ${count(fallback.errors)} item(s) failed to embed (${count(fallback.indexed)} of ${count(fallback.total)} embedded), so semantic search was not switched on.`,
        detail: fallback.error,
        actions: [{ kind: "settings", label: "Search settings" }],
      };
    case "query_embedding_failed":
      return {
        text: "embedding the query failed.",
        detail: fallback.error,
        actions: [{ kind: "retry", label: "Try again" }],
      };
    default:
      return { text: fallback.message, actions: [] };
  }
}

function shorten(detail: string): string {
  return detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS)}…` : detail;
}

export function SearchFallbackNote(props: {
  modeUsed: string;
  fallback: SearchFallback | undefined;
  onOpenSettings: () => void;
  onRetry: () => void;
}): JSX.Element {
  const explained = () => explainFallback(props.fallback);
  return (
    <p class="search-fallback" role="status" data-reason={props.fallback?.reason}>
      <span class="search-mode-fallback">
        Fell back to {props.modeUsed} search{explained().text ? `: ${explained().text}` : "."}
      </span>
      <Show when={explained().detail}>
        {(detail) => (
          <>
            {" "}
            <span class="search-fallback-detail" title={detail()}>
              ({shorten(detail())})
            </span>
          </>
        )}
      </Show>
      {/* Two things keep the button a keyboard user just pressed alive across "Try again" /
          "Check again" (B-525). `<Index>`, not `<For>`: `explainFallback` builds new action
          objects for every result and `<For>` keys by reference, so each answer — even the same
          reason — disposed the focused button. And one element per item, with its space inside
          it: a `{" "}` string next to the button in a fragment is turned into a NEW text node on
          every update, which made Solid move the button with `insertBefore`, and a browser blurs
          an element it moves (jsdom does not, so only the e2e test sees this). */}
      <Index each={explained().actions}>
        {(action) => (
          <span class="search-fallback-action-slot">
            {" "}
            <button
              type="button"
              class="search-fallback-action"
              data-action={action().kind}
              onClick={() =>
                action().kind === "settings" ? props.onOpenSettings() : props.onRetry()
              }
            >
              {action().label}
            </button>
          </span>
        )}
      </Index>
    </p>
  );
}
