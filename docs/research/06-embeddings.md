# 06 — Built-in embeddings and "clever" search for nooklet

Research date: 2026-09-10. Machine used for measurements: MacBook Pro, Apple M4 Pro, 48 GB,
macOS 26 (Darwin 25.6), Node 26.8.1, pnpm 12.3.4, Ollama 0.33.3 with `bge-m3:latest`
(1.2 GB) and `qwen3-embedding:8b` (4.7 GB, Q4_K_M). Everything marked **measured** was run
on this machine today; everything else cites a URL.

## 0. TL;DR / recommendations

| Decision | Recommendation | Why (short) |
| --- | --- | --- |
| SQLite driver (server) | **`node:sqlite`** (built-in), thin adapter so `better-sqlite3` can be swapped in | Stability 1.2 "Release candidate" in Node 26; SQLite 3.53.4 with FTS5+trigram, JSON, R*Tree, **sessions/changesets**, `loadExtension`; zero native build. Verified sqlite-vec loads. |
| Vector store | **sqlite-vec 0.1.9 `vec0`** table in the *same* SQLite file, float32 (`distance_metric=cosine`), no partition key | 100k×1024 KNN = 99 ms, 20k = ~20 ms; transactional with the graph; one file to back up. int8/binary tables are a later optimisation (75 ms / 2.6 ms+14 ms rescore). |
| Embedding provider | Ollama `/api/embed` by default; second adapter for any **OpenAI-compatible `/v1/embeddings`** (LM Studio, llama.cpp server, OpenAI) | Verified shapes, dims auto-detected from `/api/show` `<arch>.embedding_length` or from the first vector. |
| Default model | **`bge-m3`** (1024-d, multilingual, no query prefix) — user-selectable | 65 short docs/s vs 7.9 for qwen3-8b; 28–44 ms query latency; the user's own A/B on their Czech/English graph also favoured bge-m3 for quality. |
| Chunking | **Block units with breadcrumb context** (`Page › ancestor › …` + block text + descendants, ≤ ~400 tokens) **plus page units** | What Smart Connections / Copilot / Khoj / mcp-logseq converge on; Logseq 2.0's "block title only, no context" is the known-bad baseline. |
| Incremental indexing | Content-hash (`sha256(model + text)`) per unit, debounced per page, background worker, batches of 32–128, per-model `vec0` table for zero-downtime model switch | Standard pattern (Copilot, Khoj, mcp-logseq); bge-m3 re-embeds a whole 20k-block graph in ~5 min. |
| Hybrid search | FTS5 (unicode61 for ranked/prefix + trigram for substring/CJK) + vec0 KNN fused with **RRF (k=60)** in one SQL statement | Verified end-to-end in node:sqlite: 22 ms @ 20k blocks, 110 ms @ 100k. Same design Logseq 2.0 ships (k=60, keyword weight 1.25, vector 1.0). |
| Reranker | Skip in v1; optional adapter to llama.cpp server `/v1/rerank` later | Ollama has **no** rerank endpoint (issues #3368 / #14172 still open, Aug 2026). |
| Client fuzzy title search | **uFuzzy** in the browser over the page-title list | 7.5 KB, ~80× faster than fuse.js; ideal for fzf-like palette. Block-content search goes to the server (or to local sqlite-wasm FTS5 offline). |
| On-device embeddings in the PWA | **No** (server-only) | sqlite-wasm has FTS5 but `OMIT_LOAD_EXTENSION`; a statically linked `sqlite-vec-wasm-demo` exists, but no embedding model in the browser is worth it on mobile. |
| Python | **Not needed.** Pure TypeScript. | Ollama does model serving over HTTP; sqlite-vec has Node bindings; hashing/queue/RRF are trivial in TS. |

---

## 1. Ollama embedding API (verified on Ollama 0.33.3)

### 1.1 `/api/embed`

Docs: <https://docs.ollama.com/api/embed> (the old `docs/api.md` on GitHub now redirects
there). Request fields: `model`, `input` (string or array), `truncate` (default `true`),
`dimensions`, `keep_alive`, `options` (incl. `num_ctx`). Response: `model`, `embeddings`
(array of arrays), `total_duration`, `load_duration`, `prompt_eval_count`.

**Measured shapes** (`curl -s http://localhost:11434/api/embed -d '{"model":"bge-m3","input":["hello world","second"]}'`):

```json
{"model":"bge-m3","embeddings":[[-0.0402,0.0369,...],[...]],
 "total_duration":1313334667,"load_duration":1274605875,"prompt_eval_count":8}
```

| Fact | bge-m3 | qwen3-embedding:8b |
| --- | --- | --- |
| dims (len of vector) | **1024** | **4096** |
| L2 norm of returned vector | 0.99999 (unit) | 1.0000 (unit) → cosine == dot product |
| `/api/show` `model_info` | `bert.embedding_length=1024`, `bert.context_length=8192`, `bert.pooling_type=2` | `qwen3.embedding_length=4096`, `qwen3.context_length=40960`, `pooling_type=3` |
| `/api/show` `capabilities` | `["embedding"]` | `["tools","embedding"]` |
| cold load | 1.27 s | 3.55 s |
| resident (`/api/ps size_vram`) | 673 MB | 10.9 GB |
| warm single-query latency (13 tokens) | **28–44 ms** | 33–110 ms |

**Dimension detection at runtime**: call `POST /api/show {"model": m}` and read
`model_info["<general.architecture>.embedding_length"]` (key prefix = `model_info["general.architecture"]`),
and check `"embedding" in capabilities` to validate the user's pick. Fallback (also what
mcp-logseq does): embed `"probe"` and take `embeddings[0].length`. Store both the model
name *and* the observed dims with the index.

**`dimensions`** (MRL): measured — `dimensions:256` returns 256 floats on *both* endpoints
and on *any* model; for bge-m3 the result is exactly the first 256 components of the full
vector, re-normalised (cosine 1.0000 with a manual slice+normalise). So Ollama implements
`dimensions` as truncate+renormalise; only trust it for MRL-trained models
(qwen3-embedding 32–4096, nomic-embed-text-v2-moe 256–768, embeddinggemma 128–768,
snowflake-arctic-embed2 256–1024). bge-m3 and mxbai are *not* MRL models — do not expose
`dimensions` for them.

**`truncate`**: `truncate:false` with an over-long input returns
`{"error":"the input length exceeds the context length"}` (HTTP 400). Default truncates
silently and reports the kept token count in `prompt_eval_count`.

**Context-length gotcha (important for chunk sizing)**: bge-m3 (BERT, non-causal) was
truncated to **exactly 2048 tokens** even with `options.num_ctx: 8192` and `/api/ps`
reporting `context_length 8192`. Ollama starts llama-server with `-b 2048 -ub 2048`
(visible in `ps` and in ollama.log: `n_batch = 2048`, `n_ubatch = 2048`), and non-causal
encoders need the whole input inside one micro-batch. qwen3-embedding (decoder, last-token
pooling) processed a 3002-token input fine. Practical rule: **keep every embedded unit
under ~1500 tokens**; for an outliner we will be far below that.

**Batching**: an array of 1024 inputs (13k tokens) in one request worked (12.9 s). Batch
size had no effect on throughput (32 vs 128 vs 256 → all ~65 docs/s) because llama-server
runs with `-np 1`; the win from batching is only fewer HTTP round trips. Empty-string input
is accepted (returns a vector). `keep_alive:"10m"` works per request; use it so the model
does not unload between debounced index runs (default 5 m).

**Throughput, measured** (`bench_embed.py`, random 30/200/500-word docs):

| model | 256 docs × ~30 words | 128 docs × ~200 words | 32 docs × ~500 words |
| --- | --- | --- | --- |
| bge-m3 | **65 docs/s**, 2.85k tok/s | 24 docs/s, 6.7k tok/s | 10 docs/s, 7.2k tok/s |
| qwen3-embedding:8b | **7.9 docs/s**, 255 tok/s | 1.8 docs/s, 371 tok/s | 0.7 docs/s, 386 tok/s |

→ a 20k-block graph (avg ~40 tokens/unit) is a ~5-minute initial index with bge-m3 and
~45 minutes with qwen3-8b. The user's own production numbers agree
(`notes/logseq-search.md`: 28.8 vs 1.3 chunks/s on real, longer chunks; macOS Low Power
Mode halves it).

### 1.2 Models available on Ollama (Sept 2026) and their prompt conventions

Source: <https://ollama.com/search?c=embedding> + model cards.

| model (Ollama tag) | dims | ctx | MRL | query prefix / instruction | notes |
| --- | --- | --- | --- | --- | --- |
| `bge-m3` (567M) | 1024 | 8192 (2048 on Ollama, see above) | no | **none** (HF card: "no longer requires adding instruction") | multilingual 100+ langs; best quality/speed here |
| `qwen3-embedding:0.6b / 4b / 8b` | 1024 / 2560 / 4096 | 32–40K | 32→max | query: `Instruct: {task}\nQuery: {q}`; docs: raw | HF: omitting instruct costs ~1–5 %; MTEB multilingual #1 |
| `embeddinggemma` (300M) | 768 | 2048 | 128/256/512 | query: `task: search result \| query: {q}`; doc: `title: none \| text: {d}` | small, fast |
| `nomic-embed-text` (v1.5) | 768 | 8192 (Ollama card 2048) | 256–768 | `search_query: ` / `search_document: ` | English-centric |
| `nomic-embed-text-v2-moe` | 768 | 512 | 256–768 | same prefixes | multilingual |
| `mxbai-embed-large` | 1024 | 512 | no | query: `Represent this sentence for searching relevant passages: ` | binary-quant friendly |
| `snowflake-arctic-embed2` | 1024 | 8192 | yes | `query: ` | multilingual |
| `all-minilm` | 384 | 512 | no | none | what Logseq 2.0 defaults to |

Ollama does **not** add any of these prefixes itself (GitHub code search for
`search_query` / `task: search result` in ollama/ollama returns 0 hits; the qwen3 template
in `/api/show` is the chat template and is ignored for embeddings). The app must apply them.

**Measured effect of the qwen3 instruction** (6 docs, 3 queries, margin = cos(top1) − cos(top2)):

| | bge-m3 | qwen3-embedding:8b |
| --- | --- | --- |
| no prefix | margins 0.115 / 0.008 / 0.261 | 0.251 / 0.257 / 0.287 |
| with `Instruct:…\nQuery:` prefix | 0.062 / 0.004 / 0.107 (**worse**) | **0.291 / 0.299 / 0.346 (better)** |

So: prefix is per-model config, applied only to the *query* side, never to documents.
Keep a small profile table in the server:

```ts
type EmbedProfile = { model: RegExp; queryPrefix?: string; docPrefix?: string; mrl?: boolean; maxTokens: number };
const PROFILES: EmbedProfile[] = [
  { model: /^bge-m3/,            maxTokens: 1500 },
  { model: /^qwen3-embedding/,   queryPrefix: 'Instruct: Given a search query, retrieve relevant notes from a personal knowledge base\nQuery: ', mrl: true, maxTokens: 8000 },
  { model: /^embeddinggemma/,    queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ', mrl: true, maxTokens: 1500 },
  { model: /^nomic-embed-text/,  queryPrefix: 'search_query: ', docPrefix: 'search_document: ', mrl: true, maxTokens: 1500 },
  { model: /^mxbai-embed-large/, queryPrefix: 'Represent this sentence for searching relevant passages: ', maxTokens: 400 },
  { model: /^snowflake-arctic-embed2/, queryPrefix: 'query: ', mrl: true, maxTokens: 1500 },
];
```

(User-overridable in settings; unknown models get no prefix.)

### 1.3 OpenAI-compatible `/v1/embeddings` (for swapping providers)

Docs: <https://docs.ollama.com/api/openai-compatibility>. Supported: `model`, `input`
(string | string[]), `encoding_format`, `dimensions`; not supported: token arrays, `user`.
**Measured** on Ollama: response `{object:"list", model, usage:{prompt_tokens,total_tokens}, data:[{object,embedding,index}]}`, 1024 floats, `dimensions:256` honoured.

Other servers that speak the same shape:
- **LM Studio**: `http://localhost:1234/v1/embeddings` (<https://lmstudio.ai/docs/app/api/endpoints/openai>).
- **llama.cpp server**: `/v1/embeddings` (and non-OpenAI `/embedding`); it also has **`/v1/rerank`** for `bge-reranker-v2-m3` when started with `--rerank --embedding --pooling rank` (<https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>).
- OpenAI / Voyage / Jina etc. with the same JSON.

Provider interface (pure TS, no SDK needed — use `fetch`; `ollama` npm 0.6.3 and
`openai` 7.13.0 exist but add nothing here):

```ts
interface EmbeddingProvider {
  id(): string;                                   // e.g. "ollama:bge-m3" — stored with the index
  dims(): Promise<number>;                        // /api/show or probe
  embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]>;
}
// OllamaProvider: POST /api/embed {model,input,truncate:true,keep_alive:'10m',options:{num_ctx}}
// OpenAICompatProvider: POST {baseUrl}/v1/embeddings {model,input[,dimensions]} + Authorization
```

Error handling learned from the user's mcp-logseq shim: one over-long text can push a
whole batch past a timeout; on timeout **bisect the batch** instead of dropping it, and
never drop units silently — mark them `status='error'` with the message.

### 1.4 Reranking

Ollama: **no rerank endpoint** — <https://github.com/ollama/ollama/issues/3368> (open,
updated 2026-08-08), #14172 "Add reranking support" (open), #11328 (open). Options if
wanted later: llama.cpp server `/v1/rerank`, or `@huggingface/transformers` 4.2.0 in-process
(ONNX cross-encoder). Cheaper alternative with no extra model: Alex Garcia's
"keyword-first, re-order by semantics" (FTS top-50 re-sorted by vector distance). Not needed
for v1.

---

## 2. Vector storage in SQLite from Node

### 2.1 sqlite-vec — status and loading

- npm `sqlite-vec` **0.1.9** (2026-05-18, stable), `0.1.10-alpha.4` (2026-05-18) adds
  experimental ANN (`rescore`, `ivf`, DiskANN) — <https://github.com/asg017/sqlite-vec/releases>,
  <https://www.npmjs.com/package/sqlite-vec>. Platform packages: darwin-arm64/x64,
  linux-x64/arm64, windows-x64 (pnpm installed `sqlite-vec-darwin-arm64@0.1.9`, a 1-file
  `vec0.dylib`). Docs for JS: <https://alexgarcia.xyz/sqlite-vec/js.html>.
- **Verified in `node:sqlite` on Node 26.8.1**:

```js
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
const db = new DatabaseSync('graph.db', { allowExtension: true });
sqliteVec.load(db);                 // uses db.loadExtension(sqliteVec.getLoadablePath())
db.enableLoadExtension(false);      // lock it down again
db.prepare('select vec_version() v, sqlite_version() s').get(); // { v: 'v0.1.9', s: '3.53.4' }
```

- **Verified in better-sqlite3 13.0.3** on Node 26 too (`sqliteVec.load(db)`), and the
  wasm build `sqlite-vec-wasm-demo` 0.1.9 (statically linked `sqlite3.wasm`, 5 MB) exists
  for browsers.

### 2.2 vec0 feature summary (docs: <https://alexgarcia.xyz/sqlite-vec/features/vec0.html>, `features/knn.html`, `features/metadata.html`)

- Column types `float[N]`, `int8[N]`, `bit[N]`; `distance_metric=cosine|L2|hamming` per column.
- **Metadata columns** (≤16, typed TEXT/INTEGER/FLOAT/BOOLEAN) filterable in KNN with
  `=, !=, <, <=, >, >=` (no LIKE/IS NULL/functions). **Auxiliary columns** `+name` store
  unindexed payload. **Partition keys** (≤4) shard the index for `=` filters.
- KNN: `where emb match ? and k = 20` (or `limit 20`, SQLite ≥3.41); pre-filter by
  `rowid in (...)`; point lookups by rowid work (`select emb from t where id = ?`).
- Scalar functions: `vec_distance_cosine/L2/L1/hamming`, `vec_normalize`, `vec_slice`
  (MRL truncation in SQL), `vec_quantize_int8(v,'unit')`, `vec_quantize_binary(v)`,
  `vec_to_json`, `vec_f32/int8/bit`.
- Storage: shadow tables in chunks of `chunk_size` rows (default 1024).

### 2.3 Three gotchas found while testing (all reproducible)

1. **JS numbers bind as REAL in *both* `node:sqlite` and `better-sqlite3`** —
   `select typeof(?)` with `10` → `'real'`; `10n` → `'integer'`. Ordinary tables are fine
   (column affinity converts on store; `id = 10.0` matches), but vec0's typed columns are
   strict: inserting `page_id = 10` into an `integer partition key` throws
   `Parition key type mismatch: … but FLOAT was provided`. Fix: bind **BigInt** for ids
   (`BigInt(id)`) or write `cast(? as integer)` in the SQL (verified both). Filters
   (`page_id = ?` with a number) happened to work, inserts did not.
2. **Partition keys pre-allocate `chunk_size` rows per distinct value.** A `page_id`
   partition with 2000 pages and 100k float[1024] vectors produced an **8.4 GB** table and a
   961 ms KNN (the docs warn "every unique partition key value has ~100s of vectors").
   With `chunk_size=16` it was 531 MB vs 415 MB unpartitioned and in-page KNN took 0.2 ms —
   but full-graph KNN got slower (122 vs 99 ms). **Do not partition by page**; use a plain
   metadata column (or do in-page similarity in JS — a page has < 1k blocks).
3. Bind vectors as `Float32Array.buffer` (ArrayBuffer) in node:sqlite; better-sqlite3 accepts
   `Buffer`/typed arrays. Results come back as `Uint8Array` — wrap with
   `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)`.

### 2.4 Performance, measured (100k × 1024-d random unit vectors, node:sqlite, WAL, M4 Pro)

| operation | result |
| --- | --- |
| insert 100k float rows (one txn) | 8.8 s (~11k rows/s) — int8 0.76 s, bit 0.45 s, plain BLOB table 1.0 s |
| on-disk size | **float 415 MB**, int8 105 MB, bit 15 MB, plain BLOB 461 MB |
| KNN k=20, float, full scan | **99 ms** (5 distinct queries avg 98.7 ms) |
| KNN k=200, float | 110 ms |
| KNN + metadata `page_id = 45` | 45 ms; `page_id > 1000` 73 ms; `rowid in (500 ids)` 46 ms |
| KNN k=20, int8 (`vec_quantize_int8(?, 'unit')`) | 75 ms (top-3 identical to float) |
| KNN k=20, bit / hamming | **2.6 ms** (approximate; different top-2/3) |
| bit top-200 → float cosine rescore | **14 ms** (top-1 exact, top-3 close) |
| plain table `order by vec_distance_cosine(emb, ?) limit 20` | 142 ms |
| pure-JS `Float32Array` brute force (410 MB in RAM) | 67 ms top-k scan / 102 ms full sort |
| update 1000 rows / delete 1000 rows | 158 ms / 169 ms |

At **20k blocks** (typical personal graph, see §5): vec table 85 MB, hybrid query 22 ms.
Linear scaling means a 1M-vector graph would need int8/binary or the 0.1.10 ANN — not our
problem. Binary-quant guide: <https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html>
(store both, coarse-filter on bits with 8× candidates, rescore on float).

### 2.5 Alternatives considered

| option | version (npm) | verdict |
| --- | --- | --- |
| **sqlite-vec** | 0.1.9 | **Pick.** Same file/transaction as the graph, FTS5 alongside, no server. Brute force is plenty. |
| pure JS `Float32Array` | — | Works to ~100k (67 ms) but holds all vectors in RAM (410 MB @100k) and needs its own persistence; fine as a fallback if extension loading is disabled somewhere. |
| usearch | 2.26.2 (2026-08-31, Node ≥22, native prebuilt) | Fast HNSW, f16/i8/b1 quantization; but a *second* on-disk index to keep consistent with SQLite, weak metadata filtering. Overkill. |
| hnswlib-node | 3.0.0 (2024-03) | Stale; skip. |
| @lancedb/lancedb | 0.38.0 (2026-09-08, native Rust) | Full engine with FTS + hybrid + rerankers (what Python mcp-logseq uses), but a second storage engine (Lance directory) and a heavy native dep. |
| Vectra | 0.15.0 | JSON/protobuf files loaded fully in memory, brute force; toy scale. |
| @orama/orama | 3.1.18 | Pure JS hybrid search, in-memory; Obsidian Copilot had to shard its JSON dumps. Fine in a browser, not as the server's store. |
| libsql native vectors (`F32_BLOB`, `vector_top_k`) | @libsql/client 0.18.0 / libsql 0.5.29 | Couples the whole server to the Turso fork; no benefit over sqlite-vec here. |

---

## 3. SQLite driver choice

### 3.1 Server

**`node:sqlite`** (Node 26.8.1 docs <https://nodejs.org/api/sqlite.html>):
- Stability **1.2 – Release candidate** (no flag since 22.13/23.4). Bundled **SQLite 3.53.4**.
- Compile options (measured): `ENABLE_FTS5`, `ENABLE_FTS3`, `ENABLE_RTREE`, `ENABLE_GEOPOLY`,
  `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_STAT4`, `ENABLE_MATH_FUNCTIONS`,
  `ENABLE_COLUMN_METADATA`, `ENABLE_DBSTAT_VTAB`, `THREADSAFE=1`. FTS5 **trigram** tokenizer works.
- `new DatabaseSync(path, { allowExtension: true, timeout: 5000 })`, `loadExtension()`,
  `enableLoadExtension(false)`; `db.function()`/`db.aggregate()`; **`createSession()` /
  `applyChangeset()`** (SQLite session extension — directly useful for the multi-device sync
  topic); `sqlite.backup()`; `createTagStore()` (cached tagged-template statements);
  `stmt.iterate()`, `stmt.columns()`, `setReadBigInts()`.
- Synchronous only → run the embedding indexer (and other heavy reads) in a
  `worker_threads` worker with its own connection; WAL mode makes that painless.
- Gotcha: numbers bind as REAL (see §2.3).

**better-sqlite3 13.0.3** (2026-08-05): now N-API with **prebuilt binaries shipped inside the
package** (`prebuilds/darwin-arm64.node`, linux, win32, musl), `engines.node >=22`,
SQLite 3.53.4. **Verified working on Node 26 with pnpm 12 without compiling**, but pnpm 12
refused its install script (`ERR_PNPM_IGNORED_BUILDS`) — add it to
`pnpm.onlyBuiltDependencies` or run `pnpm approve-builds`. Slightly faster than node:sqlite
in micro-benchmarks and has a richer API, but it is a native dep to carry. Also binds numbers
as REAL. Keep as the swap-in behind a 40-line adapter (`prepare/get/all/run/exec/transaction`).

**@libsql/client 0.18.0** — only if we wanted Turso remote/embedded replicas; not needed.
**sql.js 1.14.2** — in-memory wasm, no OPFS; not for the server.

### 3.2 Browser client

`@sqlite.org/sqlite-wasm` **3.53.4-build1** (2026-09-08). Verified in Node: `ENABLE_FTS5`
(trigram query worked), `ENABLE_RTREE`, `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`,
`ENABLE_STMTVTAB`, and **`OMIT_LOAD_EXTENSION`** → no dynamically loaded sqlite-vec. OPFS
persistence only from a Worker (`sqlite3.oo1.OpfsDb` or the `opfs-sahpool` VFS; see
<https://sqlite.org/wasm/doc/trunk/persistence.md>). So the client can keep a local FTS5
index for offline block search. On-device vectors would need `sqlite-vec-wasm-demo` (a
separate statically-linked `sqlite3.wasm`) *and* an in-browser embedding model
(`@huggingface/transformers` 4.2.0, tens–hundreds of MB) — **not worth it for a mobile PWA;
embeddings stay server-side**, and semantic queries need connectivity (degrade to local
FTS5/uFuzzy offline).

---

## 4. Chunking / indexing strategy for an outliner

### 4.1 What existing tools do

| tool | unit embedded | context added | store / change detection |
| --- | --- | --- | --- |
| **Logseq 2.0** (`src/main/frontend/worker/search.cljs`) | **one block's own title text, no context**; all-MiniLM-L6-v2 384-d via a `sentence-transformers` sidecar (`sidecar/embedding_server.py`, OpenAI-shaped `/v1/embeddings`) | none | zvec (HNSW, cosine); RRF `k=60`, keyword weight 1.25, vector 1.0, `min-vector-search-score 0.5`, max 10 vector hits, small term-match boosts; 50 ms query-embedding budget. The user's notes: recall "weak on journal-style notes" because of the no-context design. |
| **mcp-logseq** (Python, what the user runs today) | each **top-level block + all descendants flattened** as one chunk; `min_chunk_length 50` chars | page title/tags/date as metadata columns (not in text) | LanceDB; sha256 per *file*; delete + reinsert all chunks of a changed file; embedder key stored, mismatch → forced full rebuild; 16-text batches. |
| **Smart Connections** (`jsbrains/smart-blocks/parsers/markdown.js`) | heading-based blocks keyed `note#H1##H2`, zero-indent list items as sub-blocks (`#{n}`), nested list items folded into their parent | breadcrumb in the key; both note-level and block-level embeddings | `.smart-env` files; related notes = cosine over note vectors. |
| **Obsidian Copilot** (`src/search/v3/chunks.ts`) | heading sections, then `RecursiveCharacterTextSplitter` to `CHUNK_SIZE` chars, overlap 0 | prepends `NOTE TITLE: [[name]]\n\nNOTE BLOCK CONTENT:\n\n` + stores section heading | Orama; mtime + 5 s debounce; `embeddingModelKey` sampled from the index → full reindex on change. |
| **Khoj** | heading entries split to 256 tokens | heading prepended to continuation chunks | MD5 per entry; optional cross-encoder rerank. |
| **Reor** | chunks per note | — | LanceDB + transformers.js. |

Lesson: every tool that people rate well adds *structural context* (title / heading
breadcrumb) to the embedded text; per-block-without-context (Logseq 2.0) is the weak
baseline; whole-page chunks lose the ability to jump to a block.

### 4.2 Recommended design for nooklet

Two unit kinds in one index:

1. **Block units** — one per block whose *own* text (after cleaning) is ≥ ~24 chars or has
   children. Embedded text:

   ```
   {Page title} › {ancestor-1 first line} › {ancestor-2 first line}
   {block text}
   {descendants flattened, depth-first, "- " prefixed, until a budget of ~300 tokens}
   ```
   Descendants beyond the budget are cut (they have their own units). The breadcrumb is
   cheap (a few tokens) and is what turns "fix reconnect bug" into "Projects › nooklet ›
   sync › fix reconnect bug". Journal pages use the date as title.
2. **Page units** — one per page: `{title}\n{top-level blocks flattened, ≤ ~500 tokens}`.
   Used for "related pages", for link suggestions, and as a fallback hit when a page has
   many tiny blocks. (Zero-cost alternative: mean of the page's block vectors, re-normalised
   — good enough for related-pages, no extra Ollama calls; can start there.)

Cleaning before embedding (mirror mcp-logseq's regexes): drop `key:: value` property
lines, `[[Page]]` → `Page`, `#tag` → `tag`, `((uuid))` → referenced block's first line
(or drop), strip markdown emphasis/markers, collapse whitespace. Skip empty, pure-property,
and image-only blocks. Never exceed the model's `maxTokens` (chars/3 as a conservative
token estimate; bge-m3 hard cap is 2048 tokens on Ollama).

### 4.3 Schema sketch

```sql
-- graph tables exist elsewhere: pages(id, title, ...), blocks(id, page_id, parent_id, order, content, ...)

create table embedding_index (           -- one row per (provider, model) ever used
  id integer primary key,
  provider text not null,                -- 'ollama' | 'openai-compat'
  model text not null,                   -- 'bge-m3'
  dims integer not null,                 -- 1024 (detected)
  table_name text not null,              -- 'vec_units_1'
  created_at integer not null,
  active integer not null default 0      -- exactly one active index
);

create table embedding_units (           -- what is (or should be) embedded
  id integer primary key,                -- vec0 rowid
  kind text not null check (kind in ('block','page')),
  block_id text, page_id text not null,  -- UUIDs from the graph
  text_hash blob not null,               -- sha256(cleaned text) — model-independent
  embedded_hash blob,                    -- hash actually embedded in the active index
  status text not null default 'pending',-- pending | done | error
  error text, updated_at integer not null
);
create index embedding_units_status on embedding_units(status) where status <> 'done';
create unique index embedding_units_block on embedding_units(block_id) where block_id is not null;
create unique index embedding_units_page  on embedding_units(kind, page_id) where kind = 'page';

-- one per model, created on demand; float32, cosine; rowid == embedding_units.id
create virtual table vec_units_1 using vec0(
  id integer primary key,
  kind text,                 -- metadata: filter block vs page
  page_key integer,          -- metadata: page rowid, lets "within page"/"exclude page" filters work
  emb float[1024] distance_metric=cosine
);

-- FTS over blocks (external content) + trigram twin
create virtual table blocks_fts using fts5(content, content='blocks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2 tokenchars ''-_''');
create virtual table blocks_tri using fts5(content, content='blocks', content_rowid='rowid', tokenize='trigram');
-- + the standard AFTER INSERT/UPDATE/DELETE triggers that keep both in sync
```

Measured index sizes at 100k blocks of ~27 words: `blocks_fts` 7.9 MB, `blocks_tri` 51 MB,
`vec` 415 MB; rebuild 0.17 s / 1.1 s.

### 4.4 Incremental pipeline

1. **Dirty tracking**: every write path (HTTP API, sync apply, MCP) ends by calling
   `markDirty(pageId, blockIds)`. Recompute the *cleaned text + breadcrumb* for the changed
   block, its ancestors (their flattened text changed), and the page unit; upsert
   `embedding_units` rows with the new `text_hash`; set `status='pending'` only if
   `text_hash != embedded_hash`. Deleted blocks → delete unit row + `delete from vec_units_N where id=?`.
2. **Debounce**: per page, 3 s after the last edit (Copilot uses 5 s), so typing does not
   spam Ollama. Queue lives in the DB (`status='pending'`), so restarts resume.
3. **Worker** (`worker_threads`, own `DatabaseSync`): loop `select … where status='pending' limit 64`,
   `provider.embed(texts, 'document')`, then in one transaction `insert or replace into
   vec_units_N`, set `embedded_hash = text_hash, status='done'`. On HTTP error/timeout bisect
   the batch; a single failing text gets `status='error'`. `keep_alive:'10m'` on every call.
   Yield between batches so interactive queries are not starved (they run on the main thread).
4. **Startup reconciliation**: re-derive texts for all blocks (cheap; 100k hashes ≈ 100 ms),
   diff against `embedding_units` → enqueue changes, delete orphans. This also handles edits
   that arrived while the server was down.
5. **Model switch**: settings change → insert a new `embedding_index` row + create
   `vec_units_{id}` (dims from `/api/show`), mark all units pending *for the new index* (add
   `index_id` to `embedding_units` or keep one units table per index), reindex in the
   background while the old table keeps serving; flip `active` when pending=0; drop the old
   table. Dims are part of the table definition, so per-model tables are unavoidable anyway.
6. **Status API**: `{model, dims, provider, units, pending, errors, lastError, docsPerSec, ollamaReachable}`
   for the settings UI and MCP `embedding_status`.

Rough costs with bge-m3: full index of 20k blocks + 1.2k pages ≈ 5–6 min; a typical edit
session re-embeds a handful of units per 3 s → invisible.

---

## 5. Hybrid search design

### 5.1 FTS5 side

- `blocks_fts` (unicode61, diacritics removed, `-_` kept as token chars) for **ranked**
  search with `bm25()` and prefix queries (`term*`), plus `snippet()`/`highlight()` for
  result previews. Measured: bm25 query 1.3 ms @20k, 6.6 ms @100k; prefix 0.5 ms.
- `blocks_tri` (trigram) for **substring / fuzzy / CJK** matching and indexed `LIKE '%x%'`;
  minimum 3 characters per term; ~6.5× the index size of unicode61 (51 MB vs 8 MB @100k).
  Measured: substring and LIKE queries < 0.1 ms.
- Query building: split on whitespace, quote each term (`"term"`), add `*` to the last
  term while typing, join with implicit AND; if the query contains CJK or yields zero hits,
  retry against `blocks_tri`. Never pass raw user text to `MATCH` (FTS5 syntax errors).
- FTS5 docs: <https://www.sqlite.org/fts5.html> (trigram, `bm25(tbl, w1, w2…)`, external content + triggers, `rebuild`).

### 5.2 Fusion: reciprocal rank fusion in one statement (verified in node:sqlite)

Pattern from <https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html>
(also what Logseq 2.0 implements in Clojure with `rrf-k 60`, keyword weight 1.25,
vector weight 1.0):

```sql
with vec_matches as (
  select id, row_number() over (order by distance) as rank_number, distance
  from vec_units_1
  where emb match :q_vec and k = :k and kind = 'block'
),
fts_matches as (
  select rowid as blk_rowid, row_number() over (order by rank) as rank_number, rank as score
  from blocks_fts where blocks_fts match :q_text limit :k
),
u as (select id, block_rowid from embedding_units where kind = 'block'),
final as (
  select coalesce(f.blk_rowid, u.block_rowid) as block_rowid,
         v.rank_number as vec_rank, f.rank_number as fts_rank,
         coalesce(1.0/(:rrf_k + f.rank_number), 0) * :w_fts
       + coalesce(1.0/(:rrf_k + v.rank_number), 0) * :w_vec as score
  from fts_matches f
  full outer join (vec_matches v join u on u.id = v.id) on u.block_rowid = f.blk_rowid
)
select b.id, b.page_id, b.content, score, vec_rank, fts_rank
from final join blocks b on b.rowid = final.block_rowid
order by score desc limit :n;
```

(`:rrf_k=60`, `:w_fts=1.25`, `:w_vec=1.0`, `:k=50`, `:n=20`.) **Measured end-to-end
(FTS k=50 + vec k=50 + join): 22 ms @ 20k blocks, 110 ms @ 100k** — dominated by the vector
scan. Embedding the query itself costs 28–44 ms with bge-m3 warm (issue the FTS query
immediately and stream the fused result after the vector part arrives; or show FTS hits
first and re-order when the vector hits land — that is what Logseq's Cmd-K does).

Modes exposed: `fts` (instant, offline-capable), `semantic` (vector only, with an optional
distance cutoff — bge-m3 relevant hits sit around cosine distance 0.55–0.65, noise > 0.8 on
the user's graph; thresholds are model-specific, expose as a setting), `hybrid` (default).

### 5.3 "Related …"

- **Related pages** for the current page: `select id, distance from vec_units_1 where emb
  match (select emb from vec_units_1 where id = :page_unit) and k = 11 and kind = 'page'`,
  drop self in JS. (No re-embedding — reuse the stored vector via point lookup.)
- **Related blocks** for a block: same with `kind='block'`; add `and page_key != :this_page`
  to hide siblings, or `= :this_page` for "similar in this page".
- Sidebar refresh is 1 KNN (≤ 100 ms worst case) — fine on navigation, no caching needed.

### 5.4 Client-side fuzzy title search

Keep the page-title list (a few thousand strings) in the client and use
**uFuzzy** (`@leeoniya/ufuzzy` 1.0.19, 7.5 KB, no index build; 434 ms vs fuse.js 33.9 s on
162k phrases — <https://github.com/leeoniya/uFuzzy>) for the fzf-like `[[` autocomplete and
command palette; typo-tolerant `intraMode: 1`. fuse.js 7.5.0 is fine for tiny lists but
slower; minisearch 7.2.0 / flexsearch 0.8 are alternatives if we want client-side block
search without sqlite-wasm. Block-content search → server FTS5/hybrid (or local
sqlite-wasm FTS5 when offline).

### 5.5 API / MCP surface

HTTP: `GET /api/search?q=…&mode=hybrid|fts|semantic&kind=block|page&k=20&page=<id>` →
`[{blockId, pageId, pageTitle, breadcrumb, snippet, score, vecRank, ftsRank}]`;
`GET /api/pages/:id/related`, `GET /api/blocks/:id/related`, `GET /api/embeddings/status`,
`POST /api/embeddings/reindex`. MCP tools: `search` (hybrid, with `mode`), `related_pages`,
`related_blocks`, `get_block_context` (block + breadcrumb + children, for RAG),
`embedding_status`. Return compact JSON; the LLM does the reasoning.

---

## 6. Cheap "clever" features once vectors exist

1. **Ask-your-graph via MCP** — no built-in chatbot: expose `search` + `get_page` +
   `get_block_context` + `backlinks` tools; Claude/other agents do RAG themselves. This is
   exactly how the user already works with mcp-logseq's `vector_search`.
2. **Suggest `[[links]]`** for the block being edited: embed the block (query side) →
   KNN over **page units** (`kind='page'`, k=5, distance < threshold) → propose pages not
   already linked. Combine with classic lexical *unlinked references* (trigram `LIKE` of the
   page title in block text) — lexical for precision, vectors for recall.
3. **Near-duplicate finder** (batch job / MCP tool): for each block unit, KNN k=3 among
   blocks; pairs with cosine distance < 0.08 (bge-m3) are near-duplicates; exact dupes via
   `text_hash`. 20k units × 20 ms ≈ 7 min naïvely — run as a background job or use the
   bit-quantized table (2.6 ms/query → < 1 min).
4. **Related-journal sidebar**: KNN of today's journal page unit over `kind='page'`.
5. **Tag suggestions**: KNN over pages that are tags. Same query, different filter.

Everything above is one KNN + one filter; none needs another model.

---

## 7. Is Python needed?

**No.** Ollama serves the model over HTTP; sqlite-vec ships native Node bindings (verified
on Node 26 + pnpm 12); hashing (`node:crypto`), queues, RRF and cleaning are trivial TS.
The only things Python would buy are (a) in-process `sentence-transformers` (what Logseq
2.0's sidecar does — and the user's notes document how fragile that spawn/venv path is), and
(b) a cross-encoder reranker — both replaceable later by llama.cpp server or
`@huggingface/transformers` in Node if ever wanted. Staying pure TS keeps deployment to
"`node` + `ollama`" and lets the same code run in tests without a Python toolchain.

---

## 8. What was verified locally today (commands in `scratchpad/`)

- `/api/embed` shape, dims (1024 / 4096), unit-norm, `dimensions`, `truncate:false`
  error, `keep_alive`, `options.num_ctx`, 1024-input batch, empty input → `embed_*.json`,
  `bench_embed.py`, `instr_test.py`.
- `/api/show` metadata keys; `/api/ps` context/VRAM; `/v1/embeddings` OpenAI shape.
- bge-m3 2048-token cap on Ollama (llama-server `-b 2048 -ub 2048`), qwen3 not capped.
- Instruction-prefix A/B for qwen3 vs bge-m3.
- Node 26.8.1 `node:sqlite`: SQLite 3.53.4, FTS5 + trigram, compile options,
  `allowExtension`/`loadExtension`/`enableLoadExtension`, numbers bind as REAL, BigInt/CAST
  workaround; sqlite-vec 0.1.9 loads (`vectest/t1.mjs`, `t3.cjs`).
- better-sqlite3 13.0.3 prebuilt loads on Node 26 under pnpm 12 (`vectest/t2.cjs`), also binds numbers as REAL.
- sqlite-vec benchmarks at 100k×1024 (float/int8/bit/plain/JS; metadata & rowid filters;
  partition-key blow-up; update/delete) → `vectest/bench_vec.mjs`, `bench_vec2.mjs`.
- FTS5 unicode61/trigram sizes and latencies + hybrid RRF at 20k and 100k → `vectest/bench_fts.mjs`.
- `@sqlite.org/sqlite-wasm` 3.53.4-build1 in Node: FTS5 + trigram present, `OMIT_LOAD_EXTENSION`; `sqlite-vec-wasm-demo` 0.1.9 inspected (`wasmtest/`).
- npm versions via `npm view` (2026-09-10): sqlite-vec 0.1.9, better-sqlite3 13.0.3,
  @libsql/client 0.18.0, libsql 0.5.29, @sqlite.org/sqlite-wasm 3.53.4-build1, usearch 2.26.2,
  hnswlib-node 3.0.0 (2024), vectra 0.15.0, @lancedb/lancedb 0.38.0, @orama/orama 3.1.18,
  @leeoniya/ufuzzy 1.0.19, fuse.js 7.5.0, sql.js 1.14.2, ollama 0.6.3, openai 7.13.0,
  @huggingface/transformers 4.2.0, minisearch 7.2.0, flexsearch 0.8.212.
- Read the user's running stack for prior art: `mcp_logseq/vector/{chunker,db,embedder,sync,state}.py`
  (LanceDB, bge-m3, top-level-block chunks, sha256 per file) and `notes/logseq-search.md`
  (bge-m3 vs qwen3-8b A/B on the real graph; Logseq 2.0 internals), plus Logseq's
  `worker/search.cljs` RRF constants and `platform/node.cljs` zvec/sidecar code via `gh api`.

## 9. Sources

- Ollama: <https://docs.ollama.com/api/embed>, <https://docs.ollama.com/api/openai-compatibility>, <https://docs.ollama.com/capabilities/embeddings>, <https://ollama.com/search?c=embedding>, <https://ollama.com/library/qwen3-embedding>, <https://ollama.com/library/embeddinggemma>, <https://ollama.com/library/nomic-embed-text-v2-moe>, <https://ollama.com/library/mxbai-embed-large>, <https://ollama.com/library/snowflake-arctic-embed2>, rerank issues <https://github.com/ollama/ollama/issues/3368>, <https://github.com/ollama/ollama/issues/14172>
- Model cards: <https://huggingface.co/BAAI/bge-m3>, <https://huggingface.co/Qwen/Qwen3-Embedding-8B>, <https://huggingface.co/google/embeddinggemma-300m>
- sqlite-vec: <https://github.com/asg017/sqlite-vec/releases>, <https://alexgarcia.xyz/sqlite-vec/js.html>, <https://alexgarcia.xyz/sqlite-vec/features/vec0.html>, <https://alexgarcia.xyz/sqlite-vec/features/knn.html>, <https://alexgarcia.xyz/sqlite-vec/features/metadata.html>, <https://alexgarcia.xyz/sqlite-vec/api-reference.html>, <https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html>, hybrid search <https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html>
- Drivers: <https://nodejs.org/api/sqlite.html>, <https://github.com/WiseLibs/better-sqlite3/releases>, <https://github.com/sqlite/sqlite-wasm>, <https://sqlite.org/wasm/doc/trunk/persistence.md>, <https://www.sqlite.org/fts5.html>
- Other stores: <https://github.com/unum-cloud/usearch/blob/main/javascript/README.md>, <https://github.com/lancedb/lancedb/blob/main/nodejs/README.md>, <https://github.com/Stevenic/vectra>, <https://github.com/leeoniya/uFuzzy>
- Prior art: <https://github.com/logseq/logseq> (`src/main/frontend/worker/search.cljs`, `src/main/frontend/worker/platform/node.cljs`, `sidecar/embedding_server.py`), <https://github.com/brianpetro/jsbrains/blob/main/smart-blocks/parsers/markdown.js>, <https://github.com/logancyang/obsidian-copilot/blob/master/src/search/v3/chunks.ts>, <https://deepwiki.com/khoj-ai/khoj/4-content-processing-and-search>, <https://github.com/reorproject/reor>, <https://github.com/ergut/mcp-logseq>, llama.cpp server <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
