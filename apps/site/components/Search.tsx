"use client";

import MiniSearch, { type SearchResult } from "minisearch";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { SEARCH_INDEX_URL, SEARCH_OPTIONS, type SearchDoc } from "@/lib/search-options";

type Hit = SearchResult & Partial<SearchDoc>;

let indexPromise: Promise<MiniSearch<SearchDoc>> | undefined;

/** Fetches the prebuilt index once per page load; the first open (or hover) pays for it. */
function loadIndex(): Promise<MiniSearch<SearchDoc>> {
  indexPromise ??= fetch(SEARCH_INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`search index: HTTP ${r.status}`);
      return r.text();
    })
    .then((json) => MiniSearch.loadJSON<SearchDoc>(json, SEARCH_OPTIONS))
    .catch((err: unknown) => {
      indexPromise = undefined; // let the next open retry
      throw err;
    });
  return indexPromise;
}

/** Up to ~160 characters around the first matched term, with the terms marked. */
function snippet(text: string, terms: string[]): ReactNode[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at > 60 ? text.lastIndexOf(" ", at - 50) + 1 : 0;
  const slice = (start > 0 ? "…" : "") + text.slice(start, start + 170) + (text.length > start + 170 ? "…" : "");
  const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return [slice];
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return slice.split(re).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one static string, never reordered
      <mark key={i}>{part}</mark>
    ) : (
      part
    ),
  );
}

export function Search() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const listId = useId();
  const [isMac, setIsMac] = useState(true);

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  const open = useCallback(() => {
    const d = dialogRef.current;
    if (!d || d.open) return;
    d.showModal();
    inputRef.current?.select();
    if (status !== "ready") setStatus("loading");
    loadIndex().then(
      () => setStatus("ready"),
      () => setStatus("error"),
    );
  }, [status]);

  const close = useCallback(() => dialogRef.current?.close(), []);

  // ⌘K / Ctrl+K anywhere, and "/" when focus is not in a text field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (dialogRef.current?.open) close();
        else open();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (status !== "ready") return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let cancelled = false;
    loadIndex().then((ms) => {
      if (cancelled) return;
      // AND first for precision; if that finds nothing, OR so a typo in one word still helps.
      let res = ms.search(q) as Hit[];
      if (!res.length) res = ms.search(q, { combineWith: "OR" }) as Hit[];
      setHits(res.slice(0, 12));
      setActive(0);
    });
    return () => {
      cancelled = true;
    };
  }, [query, status]);

  const go = (hit: Hit | undefined) => {
    if (!hit?.url) return;
    close();
    router.push(hit.url);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[active]);
    }
  };

  useEffect(() => {
    const el = document.getElementById(`${listId}-${active}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  return (
    <>
      <button
        type="button"
        className="search-trigger"
        onClick={open}
        onPointerEnter={() => void loadIndex().catch(() => {})}
        aria-label="Search the docs"
        aria-keyshortcuts="Meta+K Control+K /"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="search-trigger__label">Search</span>
        <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <dialog
        ref={dialogRef}
        className="search-dialog"
        aria-label="Search the docs"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === dialogRef.current) close();
        }}
        onKeyDown={() => {}}
      >
        <div className="search-input-row">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={hits.length ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search query"
            placeholder="Search the docs and design decisions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="icon-button" onClick={close} aria-label="Close search">
            <kbd>Esc</kbd>
          </button>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: an ARIA listbox of links, the combobox pattern */}
        <ul id={listId} role="listbox" className="search-results" aria-label="Results">
          {hits.map((h, i) => (
            <li
              key={h.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
            >
              <a
                href={h.url}
                tabIndex={-1}
                onClick={(e) => {
                  e.preventDefault();
                  go(h);
                }}
              >
                <div className="r-title">
                  {h.heading || h.page}
                  {h.heading ? <span className="r-page"> in {h.page}</span> : null}
                </div>
                <div className="r-snippet">{snippet(h.text ?? "", h.terms)}</div>
              </a>
            </li>
          ))}
        </ul>
        {query.trim() && status === "ready" && hits.length === 0 ? (
          <p className="search-empty">No matches for “{query.trim()}”. Try a single word, like “sync”.</p>
        ) : null}
        {status === "error" ? (
          <p className="search-empty">The search index did not load. Reload the page to try again.</p>
        ) : null}
        <div className="search-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </dialog>
    </>
  );
}
