# Bug inbox — search-fallback (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-520..B-529.

---

### B-520 · Search says "Fell back to keyword search" and never says why
**Status:** open · **Severity:** medium · **Reported:** 2026-09-13 (owner sees "Fell back to
keyword search. 4 results" and asks whether semantic search works at all)

The Search view's summary line says the search fell back to keyword and stops there. On the
owner's graph the cause is that no embedding model was ever configured — `embedding_model`,
`embedding` and `embed_dirty` are empty and there is no `embedding.*` setting — while Ollama is
running locally with bge-m3 pulled. Nothing on screen says that, or where to turn it on, and the
same words cover every other reason the server degrades: sqlite-vec not loaded, the embedding
server not answering, a model registered but still backfilling, a backfill that stopped on errors.
The server already knows which one it is (`checkSemanticAvailability`, `embeddings.status`); the
`search` op only returns `mode_used`.
