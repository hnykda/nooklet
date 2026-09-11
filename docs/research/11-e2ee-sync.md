# 11 — End-to-end encrypted sync: what a blind relay would actually cost

Dated record, 2026-09-11. Like the other files in `docs/research/`, this is kept as written rather
than updated in place. No ADR follows from it yet; §10 proposes what would.

The question this answers is the user's, stated plainly: *"I want to host sync for other people
without being able to read their notes. Is that sound?"* PLAN.md §2 currently lists E2EE as an
explicit non-goal, with a one-line reason ("E2EE would block server-side embeddings and MCP").
That reason is correct but understates the problem, and it is also wrong about which parts are
genuinely blocked. This report replaces the one-liner with a measured inventory.

Everything in §1, §2.3, §3.5, §5 and §6 was measured on this machine against the real imported
graph (`scratchpad/real/graph.sqlite`, 952 pages / 18,628 blocks / 46.3 MiB, Node 26.8.1,
`node:sqlite` with SQLite 3.53.4, M-series arm64). Probe scripts are named inline.

---

## 0. TL;DR

1. **The server is not a relay today, and E2EE is not a feature you bolt onto one.** Fourteen
   distinct server capabilities read plaintext (§1.3), and **half the 46 MiB database is derived or
   audit data no client has ever seen** (§1.2) — E2EE does not merely encrypt what is synced, it
   removes the server's right to compute any of it.
2. **The loudly-feared losses are the cheap ones.** Moving full-text search and backlinks to the
   client costs **52 ms and 1.82 MiB** (FTS5) and **~2.9 MiB** (`ref`/`path_ref`) at this graph's
   real size, using code that is *already* platform-free in `packages/core`. A brute-force `LIKE`
   scan over all 18,628 blocks with no index at all takes **3.6 ms**. "E2EE costs you search" is
   false at this scale.
3. **The real loss is the API and MCP surface.** All 18 MCP tools and every `/api/v1/*` op read
   server-side state. nooklet's first principle is "built from day one for LLM agents"
   (PLAN.md §1). A blind relay cannot serve any of them. This, not search, is the thing E2EE
   actually takes.
4. **Recommendation, and it is a split one.** For the user's *own* graph on their *own* Tailscale
   box, E2EE buys close to nothing and costs the product's headline feature — don't do it.
   For *hosting other people's graphs*, E2EE is the only defensible posture, and the way to get
   it without gutting the product is to move the API/MCP/search/embedding tier out of the relay
   and into the **headless CLI replica** (§8) — a device with a key, running next to the user, not
   next to the relay. That reframes question 7 from "a backup idea" into the load-bearing piece of
   the whole design.
5. **Hosting a browser-delivered E2EE relay for strangers is not defensible on its own** (§9). The
   relay serves the JavaScript that holds the keys. Conditions under which it becomes defensible
   are listed there; "we use strong encryption" is not one of them.
6. **Adding E2EE later is a breaking change to the op log wire format but not to the op
   *model*.** `Op.payload` becomes opaque; `id`/`hlc`/`device`/`entity` must stay clear. §10.3.

---

## 1. What the server does today (measured)

Verified by reading `packages/server/src/apply-ops.ts`, `packages/server/src/sync/*.ts`,
`packages/core/src/sync/*.ts` and `docs/spec/sql-schema.md`, then measuring the real graph.

### 1.1 The op log, and what in it is not content

An op (`packages/core/src/ops.ts`) is:

```ts
interface Op { id: string; hlc: string; device: string; entity: string; payload: OpPayload }
```

with the invariant — enforced in `isOp()` — that **`id === hlc`**. Only `payload` is content.
Everything else is protocol machinery the server reads on every request:

| Field | Server uses it for | Could it be encrypted? |
|---|---|---|
| `id` (= `hlc`) | `op.id UNIQUE` dedupe, idempotent retry, `ORDER BY seq` | No. Dedupe and ordering are the protocol. |
| `hlc` | `Hlc.receive()` drift check (`HLC_MAX_DRIFT_MS = 60_000`), rejects a device >60 s ahead | Not without giving up the drift check |
| `device` | `device` row upsert, `acked_seq` GC floor, poke-suppression on push | Could be a per-graph pseudonym; see §2.3 |
| `entity` | `op_entity` index, `changes` attribution | Could be encrypted, at the cost of that index |
| `payload` | everything in §1.3 | **This is the only field E2EE actually has to hide** |

The HLC's serialized form is `2026-09-10T12:34:56.789Z-0003-a1b2c3d4` (`packages/core/src/hlc.ts`)
— a **plaintext ISO-8601 millisecond timestamp**, a counter, and the device id. And `entity` is a
short id whose first 9 Crockford-base32 characters are 45 bits of `Date.now()`
(`packages/core/src/ids.ts`, which exports `idTime(id)` to decode it). So even with `payload`
fully encrypted, the relay reads the **exact creation millisecond of every block and page**, for
free, from data it must keep in the clear. That is a real leak, it is structural, and no amount of
AEAD fixes it (§2.3).

Measured plaintext metadata that survives encryption: **98 bytes per op, 1.83 MiB over the log.**

### 1.2 The 46 MiB is not what you think it is

`dbstat` over the real graph (`scratchpad/` probes `q.mjs`, `leak.mjs`):

| Group | Size | Synced to clients today? |
|---|---:|---|
| State: `page`, `block`, `block_prop`, `page_prop` + indexes | 10.2 MiB | yes |
| `op` + indexes | 11.8 MiB | transiently |
| `changes` + indexes (audit, `before_json`/`after_json`) | 10.0 MiB | **no** |
| FTS family: `block_fts`, `block_tri`, `page_fts`, `page_tri` | 10.0 MiB | **no** |
| `ref` + `path_ref` + indexes | 2.9 MiB | **no** |
| `embedding` / `embedding_vec_N` | 0 (Ollama not run here); ADR 010 measures **~85 MB** at 20k blocks | **no** |
| **Total** | **45.7 MiB** | |

Raw block content is only **2.79 MiB** (18,628 blocks, mean 157 bytes, max 120,016 bytes). Op
payloads total **6.23 MiB**. The `changes` table's plaintext before/after snapshots total
**5.95 MiB** — more than twice the content itself, because every entity is snapshotted whole on
both sides of every write.

**So roughly 23 MiB of this database — half of it — is server-only derived or audit data that no
client has ever seen.** E2EE does not merely encrypt what is synced; it deletes the server's right
to compute any of it.

### 1.3 Full inventory of what reads plaintext

| # | Capability | Where | Needs plaintext | Survives E2EE? |
|---|---|---|---|---|
| 1 | Tree-cycle rejection + corrective `block.place` | `core/sync/apply-ops.ts` recursive CTE; `server/apply-ops.ts` rule 24 | `block.parent_id` graph | **No** (§6) |
| 2 | `ref` / `path_ref` (linked + unlinked references) | `server/apply-ops.ts` `rebuildRefRows`/`rebuildPathRef` | `block.content` | No — moves to client (§5.2) |
| 3 | FTS5 `block_fts`/`block_tri`/`page_fts`/`page_tri` | SQL triggers, `schema.ts` | content | No — moves to client (§5.1) |
| 4 | Embeddings + semantic/hybrid search | `server/embeddings/*`, ADR 010 | content + Ollama | No — moves to a real device (§5.4) |
| 5 | `GET /sync/snapshot` | `server/sync/snapshot.ts` | materialized state rows | **No** (§6.3) |
| 6 | All 18 MCP tools + every `/api/v1/*` op | `server/ops/*`, ADR 008 | state | **No** — the big one (§8) |
| 7 | Markdown mirror to `$DATA/pages/*.md` | `server/mirror/export.ts` (`writeFileSync`) | content | No — must be off |
| 8 | `changes` audit + `batch.undo` | `recordChanges`, `ops/batch-undo.ts` reads `before_json` | full entity snapshots | No (§6.4) |
| 9 | `page_key` UNIQUE index (name collisions) | `core/sync/schema.ts` | page names | **No** (§6.2) |
| 10 | `page_journal_day` UNIQUE index | same | journal day | No |
| 11 | `nooklet verify` (rebuild parity) | `server/verify.ts` | ops + state | Moves to a client (§6.5) |
| 12 | Assets under `$DATA/assets/` | `ops/asset-upload.ts` | file bytes | No — encrypt as blobs |
| 13 | `block_open_tasks` / `due_day` index (Tasks view) | `core/sync/schema.ts` | markers, dates | No |
| 14 | Plugin `beforeWrite` server hooks | `server/plugins/before-write.ts` | op payloads | No |

Capabilities that **do** survive untouched: op ordering by `seq`, idempotent dedupe by `op.id`,
`device.acked_seq`, op-log GC (`core/sync/gc.ts` needs only `seq` numbers), the push/pull/poke
transport, bearer-token auth and the `can_sync` capability. That is a genuinely useful relay —
it is just a much smaller thing than what runs today.

---

## 2. Threat model

State it concretely, for the actual deployment being proposed: **the user hosts a relay; other
people's devices sync through it; the user is the adversary being defended against** (along with
anyone who compromises the box, or subpoenas it).

### 2.1 What a malicious or compromised relay can do

- **Read every byte of plaintext today.** No qualification. Content, page names, task state,
  scheduled dates, the full `changes` audit with before/after snapshots, the markdown mirror on
  disk, and the embeddings — which, note, are a *lossy but real* reconstruction surface in their
  own right.
- **Under E2EE, still:** learn the graph's exact size and growth curve; the creation millisecond
  of every block and page (§1.1); which entity each op targets, so it can build the complete
  *shape* of the edit history per object; per-op ciphertext length (§2.3); connection timing,
  IP addresses, device count, and which device wrote what.
- **Withhold ops.** A relay can serve device B a `pull` that omits ops device A pushed. Nothing in
  the current protocol detects this: `pull` returns `{ops, cursor, has_more}` and the client
  advances `server_cursor` to whatever `cursor` it is handed. There is no hash chain, no signed
  head, no cross-device attestation. **This is undetectable today and stays undetectable under
  naive E2EE.**
- **Reorder or roll back.** `seq` is assigned by the server (`AUTOINCREMENT`). A relay can replay
  an old `seq` range, or serve a stale cursor, and clients will accept it. Per-field LWW limits
  the damage — a rolled-back op loses to a newer HLC on the same field once the newer one is
  delivered — but a relay that withholds the newer one indefinitely holds the client at the older
  value forever. Combined with §2.1's withholding, a relay can silently freeze one device's view.
- **Serve malicious client code.** The decisive one. See §9.
- **Deny service**, trivially and undetectably.

### 2.2 What it cannot do, if E2EE is done properly

- Read `payload` plaintext.
- Forge an op that clients accept, *if and only if* ops are authenticated — and note that AEAD
  with a shared per-graph key gives **group** authenticity, not per-device authenticity: any
  device holding the graph key can forge an op attributed to any other device. Per-device
  signatures (§3.1) are what buy non-repudiation, and they are a separate decision from
  confidentiality.
- Modify a payload without detection, given the AEAD tag.
- Recover the key from stored ciphertext.

### 2.3 Metadata leakage, measured

Ciphertext length leaks plaintext length. Measured over the real 19,580-op log (`leak.mjs`):

| Padding | Distinct length buckets | Ops with a globally unique length | Size cost |
|---|---:|---:|---:|
| none | 848 | 320 (**1.6 %**) | — |
| 16 B | 197 | 111 (0.57 %) | +2 % |
| 64 B | 116 | 74 (0.38 %) | +11 % |
| 256 B | 71 | 39 (0.20 %) | +25 % |
| 1024 B | 38 | 15 (0.08 %) | +234 % |

Read that as: with no padding, 1.6 % of ops are uniquely fingerprintable by size alone against a
known candidate corpus. **Padding to a 16-byte bucket costs 2 % and removes two-thirds of that**,
and is the obvious default. Beyond 64 B the curve flattens and the cost does not.

Caveat on the timing figures: this log was produced by a single import run, so it shows one device
(`1mp0rter`) and one HLC day and says nothing real about diurnal edit patterns. A live multi-year
log would leak a precise per-device activity timeline — the same signal the plaintext `id`
timestamps already give away.

Not leaked by lengths, but leaked structurally: `entity` is plaintext, so the relay sees exactly
how many times each block was edited and when, i.e. the full revision *shape* of the graph without
its contents. Whether that matters depends on the user; it should be stated, not hidden.

Obsidian's own security page is the right model for how to disclose this. It states that *"Some
metadata is not end-to-end encrypted: which device uploaded or deleted a file, when it was
uploaded, and the mapping between encrypted file paths and encrypted content"*, and it volunteers
its worst case — that file hashes are encrypted *"deterministically: the same file content, using
the same encryption key and salt, always produces the same encrypted hash on the server"*, which
enables a confirmation-of-file-presence attack against a compromised server
(<https://obsidian.md/help/sync/security>). A shipped E2EE notes product publishing its own
weakest link is the standard to meet; nooklet's equivalent disclosure is the paragraph above plus
§1.1's id-timestamp leak.

### 2.4 Replay, rollback, and what would actually fix it

The honest summary is that **confidentiality is the easy half and integrity of the log is the half
nobody ships**. Minimum credible fix, in increasing order of cost:

1. **Per-device signing keys**, and each client tracks the highest `hlc` it has seen from each
   device. A relay that withholds ops from device A leaves a gap the moment device A's next op
   arrives with a higher counter — turning silent withholding into detectable-on-next-contact.
2. **A per-device hash chain**: each op commits to the previous op id from the same device. Makes
   omission and reordering *within* a device's stream detectable, cheaply, with one extra field.
3. **A signed head / transparency log**: each device periodically signs "I have seen up to
   `(device, hlc)` for all devices" and publishes it through the relay. Other devices cross-check.
   This is the construction that makes equivocation detectable, and it is real work.

(1) and (2) are cheap enough to be defaults if E2EE is done at all. (3) is a research project. Note
that **none of these are implemented today, encrypted or not** — the current server is trusted
precisely because it is the user's own machine.

---

## 3. Crypto design

### 3.1 Key hierarchy

Four levels, no more. Each exists because something in §7 needs it.

```
recovery phrase  ──Argon2id──►  recovery key ─┐
                                              ├─wraps─►  graph key (per graph, symmetric)
device keypair (per device)  ──wraps──────────┘              │
                                                             ├─ encrypts op payloads
                                                             ├─ encrypts assets
                                                             └─ encrypts client snapshots
```

- **Graph key**: one 256-bit symmetric key per `graph_id`. The unit of encryption matches the unit
  of sharing and the column that already exists (§7).
- **Envelope**: the graph key is never transmitted bare. It is stored on the relay once per
  recipient, wrapped to that recipient's device public key (and once to the recovery key). Adding a
  device = adding one wrapped copy. This is what makes §4's pairing cheap and §7's sharing possible.
- **Device keypair**: X25519 for wrapping, Ed25519 for signing ops (§2.4). Per device, never leaves
  it, generated on first run.
- **Key epoch**: a small integer on every encrypted op saying which graph key generation decrypts
  it. Rotation (§7) mints a new epoch and re-wraps; old ops stay readable under old epochs. **This
  field must exist from the very first encrypted op**, or rotation becomes a migration (§10.3).

Forward secrecy deserves a blunt answer: **it is close to meaningless here and should not be
designed for.** FS protects past ciphertext after a key compromise, which matters when ciphertext
is ephemeral and in flight. A notes app's entire value proposition is that all of it is retained
and re-readable forever, on every device, so any key that opens today's note must also open the one
from 2022. Ratcheting per-op keys would buy nothing while breaking bootstrap. What *is* worth
having is the thing FS is often confused with — **post-compromise recovery**: the ability to rotate
the graph key and cut a lost device out of future ops (§7). Design for that; skip FS.

### 3.2 Which AEAD — and the browser constrains the answer

The reflexive 2026 answer is XChaCha20-Poly1305, and for this project it is the wrong one.

- **No shipping browser exposes ChaCha20-Poly1305 through `crypto.subtle`.** The algorithm lives in
  the WICG draft "Modern Algorithms in the Web Cryptography API"
  (<https://wicg.github.io/webcrypto-modern-algos/>, Draft Community Group Report dated 2026-09-03,
  which states in its own boilerplate that it "is not a W3C Standard nor is it on the W3C Standards
  Track"). Chrome's implementation (<https://chromestatus.com/feature/5198951632470016>) is status
  *Proposed*, targeting **Chrome 154**, with the `WebCryptoAdditionalAlgorithms202606` origin trial
  completed and security review still pending — and explicitly **not targeting iOS**, since Chrome
  on iOS is WebKit.
- **XChaCha20-Poly1305 is nowhere in any standard API.** It is not in Web Crypto Level 2
  (<https://w3c.github.io/webcrypto/>, Editor's Draft 2026-08-11), not in the WICG draft, and not in
  `node:crypto` — Node ships `chacha20-poly1305` via OpenSSL but no X-variant
  (<https://nodejs.org/api/crypto.html>). It exists only in libsodium (sumo build) and
  `@noble/ciphers`.
- **AES-GCM is in every browser, is hardware-accelerated, and is fast enough by three orders of
  magnitude** (§3.5).

So: **AES-256-GCM via `crypto.subtle`, with no third-party crypto library in the encryption path.**
That is a deliberate, defensible choice: the smallest trusted computing base, no WASM blob to
audit or ship, and identical code in Node 26 and the browser.

The standard objection to AES-GCM is the 96-bit nonce. NIST SP 800-38D is explicit about the bound
(<https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf>): §8 requires that
the probability of ever reusing an (IV, key) pair "shall be no greater than 2⁻³²", and §8.3 states
that with the RBG-based (random) IV construction "the total number of invocations of the
authenticated encryption function shall not exceed 2³²" per key. Measured against this graph: the
log holds 19,580 ops and `sql-schema.md` rule 28 projects a mature log at 50k–150k. **2³² is
4.29 × 10⁹ — roughly 30,000× the projected lifetime op count of this graph.** The nonce bound is
not a real constraint at personal-notes scale, and key rotation (§7) resets the budget anyway.

Use **random 96-bit nonces**, not nonces derived from `op.id`. Deriving is tempting, because
`op.id` is the HLC and is unique by construction — but its uniqueness rests on `newDeviceId()`
producing 32 random bits (`packages/core/src/hlc.ts`), so two devices *can* collide on device id,
and if they then collide on wall-ms and counter you get a duplicate op id. Today that is a minor
convergence bug caught by `op.id UNIQUE`. Under a deterministic nonce scheme the same collision is
**nonce reuse under the same key**, which for GCM is catastrophic — it leaks the XOR of both
plaintexts and enables forgery. Do not couple an id-uniqueness assumption to a crypto-critical
invariant.

Bind the AAD to the plaintext metadata so the relay cannot transplant a ciphertext onto a different
op: `AAD = id ‖ entity ‖ epoch`. (This is what the §3.5 benchmark measured.)

### 3.3 Key derivation and the recovery phrase

The recovery phrase is the only thing standing between a user and permanent data loss (§3.4), so
it is derived, not stored.

Argon2id is the right KDF and **is not available in browsers**: it is in the same WICG draft as
ChaCha20-Poly1305 and has shipped in Node (`crypto.subtle` Argon2d/i/id since **v24.8.0**,
<https://nodejs.org/api/webcrypto.html>) but in no browser. So a browser client needs WASM for this
one operation. Options, both verified:

- `hash-wasm` (<https://github.com/Daninet/hash-wasm>) — last push 2024-11-19, 1,156 stars; its own
  benchmark puts Argon2id (m=512 KiB, t=8, p=1) at **438 ops/sec** versus `argon2-browser`'s 213.
- `argon2-browser` (<https://github.com/antelle/argon2-browser>) — **last push 2023-03-24**, 20 open
  issues; effectively stale.
- `@noble/hashes` 2.4.0 now ships Argon2 but its README warns "Argon2 can't be fast in JS", and
  Argon2 was **explicitly excluded** from the cure53 audit scope for that library.

Recommendation: `hash-wasm` in the browser, `crypto.subtle` Argon2id in Node, one interface over
both — and treat the phrase-unwrap as a rare operation (recovery and first-device setup only), so
its cost is paid once, not per session. Neither repo publishes phone benchmarks; parameters must
be measured on a real low-end device before being fixed (§11).

An alternative worth considering precisely *because* it avoids all of the above: skip
passphrase-derived keys entirely and make the recovery artefact a **high-entropy random recovery
key** shown once (BIP39-style words or a 1Password-style Secret Key), not a user-chosen passphrase.
A 128-bit random key needs no KDF hardening at all, because there is no low-entropy input to
stretch — which deletes the Argon2-in-the-browser problem, the parameter-tuning problem, and the
weak-passphrase problem in one move. The cost is that the user must actually store it. Given this
is a self-hosted tool for technical users, that is the better trade.

### 3.4 Browser key storage — and a Safari bug that constrains the design

Store the device keypair as non-extractable `CryptoKey` objects structured-cloned into IndexedDB,
so the private key material is never visible to JavaScript. That is the standard advice and it is
mostly right, with two live caveats found in WebKit's tracker:

- **Bug 312279** (<https://bugs.webkit.org/show_bug.cgi?id=312279>, filed 2026-04-21, status NEW):
  *"Non-extractable X25519 CryptoKey stored in IndexedDB returns null on subsequent read in
  Safari"* — reproduces **100 % of the time** on Safari 26.4 / macOS 15.4 (`rdar://175258859`). The
  report states AES-GCM keys round-trip fine; it is X25519 specifically that breaks. Since §3.1
  puts X25519 at the centre of device pairing, **this bug sits directly on the critical path** and
  must be tested before the design is committed to.
- **Bug 308718** (<https://bugs.webkit.org/show_bug.cgi?id=308718>, 2026-03-09): CryptoKey material
  is stored unencrypted on **non-Apple** WebKit ports (WebKitGTK/OpenSSL backends). Apple's own
  builds wrap keys with AES-128-GCM under a Keychain-managed master key. Relevant only if Linux
  WebKit is ever a target — but it is exactly the kind of platform divergence that makes
  "non-extractable" a weaker promise than it sounds.

MDN documents neither caveat; the bug tracker is the only source.

The harder problem is **eviction**. `research/03-sync.md` §4 already recorded WebKit's rule, and
the current evergreen policy page (<https://webkit.org/tracking-prevention/>) still states it:
ITP "deletes all of a website's script-writable storage after seven days of Safari use without user
interaction on the site" — IndexedDB included — with home-screen web apps exempt. Today that is
benign, because the repo's stated design consequence is "treat client storage as a cache that can
vanish… the client can always re-bootstrap from a server snapshot."

**Under E2EE that answer fails catastrophically, and this is the single most important operational
consequence in this report.** Losing IndexedDB loses the device key. The relay cannot help, by
construction. The data is still there and is now permanently unreadable by that device. So:

- A recovery artefact is **mandatory, not optional**, and must be captured during onboarding before
  the first op is written — not offered later in settings.
- `navigator.storage.persist()` must be called, and the "Install app" prompt matters far more than
  it does today.
- At least two devices (or one device plus the recovery key, or the CLI replica of §8) must hold a
  wrapped copy of the graph key at all times, and the UI should say so when only one does.

### 3.5 What it costs, measured

Benchmarked over the real 19,580-op log with AES-256-GCM through Node 26.8.1's `crypto.subtle`
(`scratchpad/crypto-bench.mjs`, `crypto-bench2.mjs`), AAD bound to `id ‖ entity`:

| Operation | Result |
|---|---|
| Encrypt 19,580 ops individually | **287 ms** (14.7 µs/op) |
| Decrypt 19,580 ops individually | **302 ms** (15.4 µs/op) |
| Encrypt in batches of 200 | **3.3 ms** total |
| Bulk one-shot, 46 MiB | **12.2 ms** encrypt / 11.4 ms decrypt (~3.8 GiB/s) |
| Tag + IV overhead, per-op framing | 313,280 B tags + 234,960 B IVs = **0.52 MiB (+8 %)** |
| Wire body, plaintext JSON → base64 ciphertext JSON | 9.07 MiB → **12.30 MiB (+36 %)** |

Two conclusions. **The cipher is free** — per-op cost is dominated by `crypto.subtle`'s async call
overhead on tiny payloads, not by AES; the whole graph encrypts in 12 ms as one buffer. And **the
+36 % wire cost is base64, not crypto**: a binary framing (length-prefixed, or CBOR) brings it back
to the ~8 % that the tags and IVs actually cost. If E2EE ships, change the wire encoding at the
same time.

### 3.6 At-rest encryption on the client is a separate, weaker question

Worth stating because it is easy to conflate with E2EE: the official `@sqlite.org/sqlite-wasm`
build (3.53.4-build1) **has no encryption-at-rest capability at all** — its documentation
(<https://sqlite.org/wasm/doc/trunk/index.md>) describes the OPFS VFS and never mentions SEE or any
encrypted VFS. Options are application-level encryption of values before insertion, or a
third-party build such as SQLite3MultipleCiphers (<https://github.com/utelle/SQLite3MultipleCiphers>,
v2.5.1, August 2026), whose changelog shows a WASM build exists but whose **OPFS compatibility is
unverified** (§11). On the server/CLI side, `better-sqlite3-multiple-ciphers` (v13.0.3) exists,
but `packages/server` uses `node:sqlite`, which has no equivalent.

None of this is E2EE. A decrypted replica on a device is the point of the design; protecting it
from someone holding the unlocked device is what OS disk encryption is for. Don't ship an
app-level at-rest scheme whose key lives next to the database and call it a security feature.

---

## 4. Key distribution and device pairing

### 4.1 What the prior art actually does

Fetched from primary sources; see §11 for the two that could only be read through a proxy.

| System | What encrypts data | How device 2 gets the key | Recovery when all devices are lost |
|---|---|---|---|
| **Obsidian Sync** (<https://obsidian.md/help/sync/security>) | *"Key derivation function: scrypt with salt"*, *"Encryption algorithm: AES-256 using Galois/Counter Mode (GCM)"*. E2EE is the default; a "Standard encryption" mode exists where the key is managed by Obsidian | **No pairing protocol.** The user types the same encryption password on each device | *"If you ever lose or forget the encryption password, you won't be able to connect additional vaults to your remote vault. Since the encryption password isn't saved anywhere, it's forever lost."* |
| **Standard Notes** (<https://docs.standardnotes.com/specification/encryption>) | per-item "items keys", XChaCha20-Poly1305, wrapped under a root key. Argon2id **m = 64 MiB, t = 5, p = 1**, 128-bit salt, 512-bit output split into a local master key and a server password | No pairing protocol; device 2 re-derives the root key from the password plus a server-stored non-secret salt seed | None. *"password resets are simply not possible… your only option is to delete your account"* |
| **Signal** | — | **No published spec** for device linking. `signal.org/docs` lists X3DH, PQXDH, Double Ratchet, Sesame, XEdDSA, ML-KEM Braid — Sesame is *session* management across devices, not the QR provisioning handshake | Two distinct models: **SVR** (<https://signal.org/blog/secure-value-recovery/>) escrows a key in SGX enclaves so a low-entropy PIN works, because the master key also incorporates 256 bits of server-side randomness and the enclave rate-limits guesses; **Secure Backups** (<https://signal.org/blog/introducing-secure-backups/>, 2025-09-08) uses a 64-character on-device recovery key, *"never shared with Signal's servers… Signal cannot help you recover it"* |
| **Matrix** (<https://spec.matrix.org/latest/client-server-api/#cross-signing>) | Megolm session keys; backup under `m.megolm_backup.v1.curve25519-aes-sha2` | **Cross-signing**: three Ed25519 keypairs — master (MSK), user-signing (USK), self-signing (SSK), the SSK signing the user's own device keys. Devices verify by **SAS**: ECDH with `curve25519-hkdf-sha256`, then *"Generate 6 bytes using HKDF then split the first 42 bits into 7 groups of 6 bits"* → 7 emoji (or three 13-bit decimal numbers +1000). Secrets move device-to-device via `m.secret.request`/`m.secret.send`, *"encrypted using olm"* | **SSSS**: `m.secret_storage.v1.aes-hmac-sha2` (AES-CTR-256 + HMAC-SHA-256, keys via HKDF-SHA256), storage key from a passphrase via **PBKDF2-HMAC-SHA512**, spec example 100,000 iterations |
| **1Password** (<https://1passwordstatic.com/files/security/1password-white-paper.pdf>) | **Two-Secret Key Derivation**: account password → PBKDF2-HMAC-SHA256, **650,000 iterations**, XORed with a client-generated Secret Key (*"slightly more than 2^128 possible Secret Keys"*) → Account Unlock Key. Auth by SRP | *"the user will provide the client with the add-device link (possibly in the form of a QR code) and their account password"* — generated by an already-enrolled client; the bundle travels *"via an end-to-end (E2E) encrypted channel"*, relayed as ciphertext | *"We don't have the ability to recover your data if you forget your account password or lose your Secret Key."* Individuals rely on the printed Emergency Kit; teams get a cryptographic Recovery Group |
| **Apple iCloud Keychain** (<https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web>) | Per-item, to a **circle of trust**; syncing identities are **P-384** keypairs | **Sponsorship**: *"The sponsor adds the public key of the new member to the syncing circle and signs it again with both its syncing identity and the key derived from the user's iCloud password."* | HSM escrow authenticated by **SRP**, so the code itself never reaches Apple. Hard-limited: *"The escrow service allows only 10 attempts to authenticate and retrieve an escrow record"*, after which *"the HSM cluster destroys the escrow record and the keychain is lost forever."* Advanced Data Protection **requires** a recovery contact or recovery key before it can be enabled |

Three patterns are worth extracting:

1. **The two notes apps are the two weakest designs.** Obsidian and Standard Notes both have *no
   device pairing at all* — they re-derive from a password on each device. That is simple and it is
   why both have a single catastrophic failure mode. Everything built by a security team (Signal,
   Matrix, 1Password, Apple) uses **device keypairs plus an out-of-band-verified enrolment**, not a
   shared password.
2. **Nobody uses BIP39.** Apple's recovery key is 28 characters; 1Password's Secret Key is `A3-`
   plus 26 characters from a 31-symbol alphabet; Signal's is 64 characters. Proton's 12-word phrase
   is the only word-based one found and its BIP39 conformance is unconfirmed (§11). Dense
   alphanumeric beats wordlists in shipped consumer products.
3. **Recovery is where the real design happens**, and there are exactly two honest options:
   an unrecoverable high-entropy secret the user must store (Signal Secure Backups, 1Password,
   Apple's recovery key), or a low-entropy secret rescued by **rate-limiting hardware you operate**
   (Signal SVR, Apple's HSM escrow). The second is not available to a self-hoster. **So for nooklet
   the answer is forced: an unrecoverable recovery key, captured at onboarding.**

### 4.2 PAKEs: attractive, and not ready in TypeScript

Both candidates are now RFCs, and both are **Informational, IRTF/CFRG stream — not IETF standards
track**:

- **SPAKE2 — RFC 9382** (September 2023, <https://www.rfc-editor.org/rfc/rfc9382.txt>), which says
  of itself: *"This document predated the CFRG password-authenticated key exchange (PAKE)
  competition, and it was not selected."*
- **OPAQUE — RFC 9807** (July 2025, <https://www.rfc-editor.org/rfc/rfc9807.txt>), the aPAKE the
  CFRG competition did select.

The blocker is implementations. The npm `spake2` package last published in **2019**;
`@cloudflare/opaque-ts` last published **0.7.5 on 2022-02-15** and implements **IETF draft-07**,
predating and not necessarily wire-compatible with RFC 9807. No maintained, RFC-9807-conformant
JS/TS OPAQUE library was found (§11).

Conclusion: **do not build device pairing on a PAKE in 2026 for this project.** The cryptography is
settled; the TypeScript ecosystem is not, and a stale draft implementation of a PAKE is worse than
a simple construction you fully understand.

### 4.3 Recommended pairing flow

Follow 1Password and Apple, not Obsidian. The new device generates its own keypair; an
already-enrolled device wraps the graph key to it; the relay only ever moves ciphertext.

```
new device D2                          existing device D1                 relay
 ─ generate X25519 + Ed25519 keypair
 ─ display QR: pub(D2) ‖ nonce ─────────► scan
                                        ─ compute SAS from H(pub(D1) ‖ pub(D2) ‖ nonce)
 ◄──────── both screens show the same 7 emoji / 6 digits; user confirms ────────►
                                        ─ wrap graph key (all epochs) to pub(D2)
                                        ─ sign the wrapped bundle with D1's Ed25519 key
                                                       ──── upload ciphertext ────► store
 ◄──── fetch, verify signature, unwrap ────────────────────────────────────────────
```

- **The QR carries the new device's public key, not the graph key.** If a photo of the QR leaks,
  nothing is lost. This is the single most important property and it is the one a naive "QR
  contains the key" design gets wrong.
- **The SAS is what defeats the relay.** Without it, a relay can substitute its own public key for
  D2's and receive a wrapped graph key — a straightforward MITM. The short authentication string
  is a human-checked channel the relay cannot forge. Matrix's construction is directly reusable:
  ECDH, HKDF, 42 bits → 7 emoji. **Do not skip the SAS because it is "just for me" — it is the only
  part of §4 that actually makes the relay untrusted.**
- **Trust On First Use is the fallback, and it is weak.** If the SAS is skipped, pairing is TOFU
  and inherits its documented failure mode: warnings on key change get ignored or suppressed under
  UX pressure — WhatsApp and Telegram trust silently, Signal's warning is non-blocking
  (<https://en.wikipedia.org/wiki/Trust_on_first_use>). A warning nobody acts on is not a control.
- **Headless devices cannot do this** (§8): they need a one-time, short-lived, single-use enrolment
  token minted on a real device.

### 4.4 Losing every device

Say it plainly in the product, not in a FAQ: **if the recovery key is lost and no device holds the
graph key, the data is unrecoverable, and the operator cannot help by design.** That is the same
sentence Obsidian, Standard Notes, 1Password and Signal all had to write.

Mitigations that are actually available to a self-hoster:

- A **recovery key generated at onboarding**, shown once, with a forced "type it back" confirmation
  before the first op is written (§3.4). 128 bits of entropy, dense alphanumeric.
- The **CLI replica (§8) as a second key holder** — the most useful thing it does after backups.
- A **warning state in the UI when only one device holds the key.** Apple's Advanced Data
  Protection refuses to turn on without a recovery contact or recovery key; that is the right
  aggressiveness for an irreversible choice.
- What is *not* available: HSM escrow with guess-limiting (Signal SVR, Apple). Do not imitate a PIN
  flow without the hardware that makes a PIN safe — a 6-digit PIN protecting a key with no
  rate-limiter is a 20-bit secret.

---

## 5. Search and references under encryption

This is where the intuition is most wrong, so it is measured rather than argued.

### 5.1 Full-text search: move it client-side, it is nearly free

The client replica's schema (`packages/core/src/sync/schema.ts` +
`apps/web/src/db/schema-client.ts`) has no FTS tables today, which is why
`apps/web/src/data/api-client.ts` exists at all — its header says search and backlinks "MUST go
over HTTP". But `docs/spec/sql-schema.md` rule 1 already declares `block_fts`/`block_tri`/
`page_fts`/`page_tri` as tables that "exist on both, with identical schema". The spec anticipated
this; the implementation just hasn't done it.

Measured cost of building the index from scratch over all 18,628 real blocks
(`scratchpad/buildidx.mjs`, `node:sqlite`, native):

| Index | Build time | On-disk size |
|---|---:|---:|
| `fts5(tokenize="unicode61 remove_diacritics 2")` — the keyword index | **52 ms** | **1.82 MiB** |
| `fts5(tokenize="trigram")` — substring/infix search | 243 ms | 8.06 MiB |

A sanity check on the index-size ratio, because it is the number most likely to be doubted: the
keyword index is **65 % of the 2.79 MiB of raw block content**, which is *worse* than SQLite's own
published figure. <https://sqlite.org/fts5.html> reports indexing 1,636 MiB of email into
743 MiB with `detail=full` (≈45 %), 340 MiB with `detail=column` (≈21 %), and 134 MiB with
`detail=none` (≈8 %). Our ratio is higher because nooklet's documents are tiny — a mean of 157
bytes per block — so per-document overhead dominates. That is worth knowing because it means the
ratio will *improve*, not degrade, as the graph grows, and because `detail=none` is available as a
4–8× reduction if mobile footprint ever matters (at the cost of phrase and `NEAR` queries).

And query latency on the real graph (`q.mjs`, mean of 20):

| Query | Latency |
|---|---:|
| `block_fts MATCH 'projekt'` | 0.03 ms |
| `block_tri MATCH 'ject'` (substring) | 0.03 ms |
| linked refs via `path_ref` join, hottest page (1,094 rows) | 0.10 ms |
| **brute-force `content LIKE '%…%'` over all 18,628 blocks, no index at all** | **3.61 ms** |
| full scan of `block.content` | 3.94 ms |

The last two lines are the ones that settle the argument. **At this graph's real size, a phone can
answer a keyword query by scanning every block with no index whatsoever.** Native arm64 does it in
3.6 ms; `sqlite-wasm` is slower and a phone slower again, but the headroom is two orders of
magnitude, not two-fold.

`research/06-embeddings.md` §3.2 already verified that `@sqlite.org/sqlite-wasm` 3.53.4-build1
ships `ENABLE_FTS5` with the trigram tokenizer working, so there is no missing capability —
the browser can build and query exactly these tables.

Recommendation: ship the keyword index (1.82 MiB), make the trigram index optional on mobile
(8.06 MiB is 80 % of the whole FTS story for a feature — infix matching — that matters less on a
phone), and keep a brute-force fallback for cold start.

### 5.2 Backlinks: also nearly free, and the code already runs in the browser

`ref` and `path_ref` are derived by `extractRefs()` and `tokenizeContent()` — both in
`packages/core/src/refs.ts` and `tokens.ts`. Grep confirms **the only file in `packages/core` with
a `node:` import is `sync/node-sqlite-driver.ts`**, behind the `SqlDriver` seam. The reference
extractor is already platform-free and already runs in the browser as part of the editor's
tokenizer (ADR 006: the same offset-annotated tokens feed the renderer, the live-preview
decorations, *and* the server's reference indexer).

So moving backlinks client-side is not a port. It is: add the two tables to the client schema, and
call the function that is already there on the client from `applyOps` instead of only from
`serverApplyOps`. Cost at real scale: **2.9 MiB** (`ref` 100 KiB + `path_ref` 1.6 MiB + its index
1.2 MiB), 31,597 `path_ref` rows, 0.10 ms per backlinks query.

One caveat worth stating: `path_ref` maintenance is the expensive write-side operation, because
`rebuildPathRef` walks the ancestor chain for a block **and every descendant** on any move
(`reindexBlockAndSubtree`). Moving a 1,000-block subtree is 1,000 ancestor walks. That is fine on a
laptop and should be measured on a phone before it is promised; it is the one place where "just do
it on the client" has a plausible failure mode.

### 5.3 Encrypted search indexes on the server: don't

The tempting middle path — keep a *searchable encrypted* index on the relay — is the one option
this report rejects without reservation. The literature is unusually clear, and the failure mode
maps onto personal notes almost perfectly.

**Searchable symmetric encryption (SSE) leaks access patterns, and access patterns are enough.**

- Cash, Grubbs, Perry, Ristenpart, *Leakage-Abuse Attacks Against Searchable Encryption* (CCS 2015,
  <https://eprint.iacr.org/2016/718>) introduced the **count attack**: knowing only which encrypted
  documents each query returns, plus a stand-in corpus, the server matches queries to keywords by
  result-set size. Their headline figure: *"a server that happens to know even a single email sent
  to 500 Enron employees learns on average 35% of the other keywords of all other employees'
  queries."* On padding as a defence: *"a slightly modified variant of the count attack recovers
  query information even if the amount of padding increases the storage overhead by 8x."*
- Zhang, Katz, Papamanthou, *All Your Queries Are Belong to Us* (USENIX Security 2016,
  <https://eprint.iacr.org/2016/172>) showed **file-injection**: a server that can get the client to
  encrypt and upload chosen content runs *"a simple, binary-search attack that allows the server to
  learn 100% of the client's queries with no prior knowledge about the client's files"*, and the
  attack *"degrades only slightly"* under the padding defences that stopped earlier attacks. A
  relay that can also send you content — email, shared pages, anything — has this capability.
- Blackstone, Kamara, Moataz, *Revisiting Leakage-Abuse Attacks* (NDSS 2020,
  <https://eprint.iacr.org/2019/1175>) is the honest correction: the earlier attacks assumed
  unrealistically high known-data rates. But their narrowed result is precisely the wrong shape for
  this application — **high-selectivity queries combined with access-pattern and volume leakage
  still recover well.** Short, distinctive queries against short documents is the definition of
  block search in a personal graph full of `@person` pages and a private vocabulary.
- The attacks have not stopped. *Leakage-Abuse Attacks Against Structured Encryption for SQL*
  (USENIX Security 2024, <https://eprint.iacr.org/2024/554>) and *LAMA* (2024,
  <https://eprint.iacr.org/2024/1308>) attack a shipping product — Microsoft SQL Server's Always
  Encrypted — recovering *">95% of rows in 8 of 15"* deterministically-encrypted columns on a
  full-scale instance.

**Property-preserving encryption is worse and has been settled for a decade.** Naveed, Kamara,
Wright, *Inference Attacks on Property-Preserving Encrypted Databases* (CCS 2015,
<https://www.cs.brown.edu/~seny/pubs/edb.pdf>) attacked deterministic and order-preserving
encryption — the CryptDB approach — with *only* the encrypted column plus public auxiliary data,
against real electronic medical records from 200 US hospitals: they *"correctly recovered certain
OPE-encrypted attributes (e.g., age and disease severity) for more than 80% of the patient records
from 95% of the hospitals; and certain DTE-encrypted attributes (e.g., sex, race, and mortality
risk) for more than 60% of the patient records from more than 60% of the hospitals."* If a "blind
index" built on deterministic encryption is ever proposed for nooklet, this is the citation that
ends the conversation.

**PIR/FHE is real research and not buildable here.** The closest working system to private semantic
search is Tiptoe (SOSP 2023, <https://github.com/ahenzinger/tiptoe>), which indexes 360 M web pages
using linearly-homomorphic encryption. Its published costs per single query: **2.7 s latency,
~145 core-seconds of server compute, 56.9 MiB of communication, and a 45-server cluster.** Private
information retrieval over a database that *changes* is still an open problem with 2026 eprints on
it. Watch the space; do not build on it.

**And nobody ships the alternative middle path either.** Surveying what E2EE products actually do:

| Product | Where the index lives | Source |
|---|---|---|
| Joplin | client-side SQLite FTS over the locally decrypted DB | <https://joplinapp.org/help/apps/search/> |
| Proton Mail | *"The index is created in your browser and never leaves it"* | <https://proton.me/support/search-message-content> |
| Tuta | index built locally, **encrypted at rest on the device**, server gets *"zero access"* and *"no search meta data"* | <https://tuta.com/blog/first-search-encrypted-data> |

Not one of them uploads an index — encrypted or otherwise — to the server. The industry pattern is
"every device rebuilds its own index locally from the plaintext it already has after sync". No
shipping precedent for a synced encrypted-index blob was found (see §11 for the caveat on how hard
that was searched).

Proton's documented failure mode is the one worth internalising: their index build is *"resource-
intensive"*, can take minutes, and *"in rare cases, the contents of a large inbox may require more
storage capacity than your browser offers"* — at which point they truncate the searchable window
and tell the user the cutoff date. A well-funded team with a dedicated crypto group solves the
scale problem by **giving up on completeness**. At 2.79 MiB of block content we are three orders of
magnitude away from that cliff, which is the whole reason §5.1's answer is easy.

### 5.4 Semantic search: it moves to a device, or it dies

This is the one genuine loss, and it is not fixable by moving code.

- Embeddings need the plaintext *and* a model. ADR 010 puts both on the server: Ollama at
  `/api/embed`, bge-m3, vectors in `sqlite-vec` `vec0` tables, ~85 MB at 20k blocks, hybrid search
  by RRF in one SQL statement.
- `research/06-embeddings.md` §3.2 already established that the official `sqlite-wasm` build is
  compiled with **`OMIT_LOAD_EXTENSION`**, so sqlite-vec cannot be dynamically loaded in the
  browser at all; you would need `sqlite-vec-wasm-demo`, a separately statically-linked
  `sqlite3.wasm`. And the embedding model itself would have to run in-browser
  (`@huggingface/transformers`, "tens–hundreds of MB"). That report's conclusion — "not worth it
  for a mobile PWA" — was reached for performance reasons and holds a fortiori here.

So under E2EE, semantic search is available **only where a full-strength device with the key and a
local model exists**: a desktop client, or the headless CLI replica of §8. Phones get keyword
search. That is the honest trade and it should be stated as a product fact, not engineered around.

### 5.5 Recommendation for §5

Move FTS and references to the client **regardless of whether E2EE ever ships**. They are cheap
(~4.7 MiB and ~300 ms combined), they make the client work offline for its two most-used read
paths, they delete `api-client.ts`'s reason to exist, and they are the single largest de-risking
step toward E2EE that costs nothing if E2EE never happens. This is the strongest concrete
recommendation in this report.

---

## 6. Can the server still validate? Mostly no — and here is what replaces each piece

### 6.1 Cycles

`coreApplyOps` rejects a `block.place` that would make a block its own ancestor, via a recursive
CTE over `block.parent_id`; `serverApplyOps` then mints a corrective `block.place` with
`SERVER_DEVICE_ID = "00000000"` and a server-owned HLC, applied in the same transaction so "state
never observably held the rejected move even transiently". Under E2EE the relay sees neither
`parent_id` nor the tree, so it cannot do either half.

The replacement is already written down, in the most useful possible place: the header of
`packages/core/src/sync/apply-ops.ts` explains that `packages/core` deliberately has no server
role, and solves the same problem **without an arbiter** by processing every batch in HLC order
(ties broken by op id, which is the HLC). Its stated consequence:

> to guarantee that two devices which have seen the same *set* of ops converge on the same
> accept/reject decision for every `block.place`, ops must eventually be (re-)applied together, in
> one `applyOps`/`rebuild` call, in HLC order — not trickled in one at a time in arbitrary arrival
> order forever.

`sync.property.test.ts` already exercises exactly the concurrent cycle-creating-move case
converging under this rule. **So the answer to "what replaces server-side cycle correction" is:
the rule that replaces it already exists and is already tested.** What E2EE changes is that it
becomes load-bearing rather than a fallback, which means the client must actually do the canonical
re-application — a periodic `rebuild()`-equivalent over the accumulated log, not just incremental
`applyOps` in arrival order forever.

Two things to be clear about:

- This is **not** "last writer to observe a cycle fixes it". It is stronger and better: every
  device independently computes the *same* decision from the same set of ops, because HLC order is
  total and available without coordination. No corrective op is needed at all.
- The cost is that a device which has only ever applied ops incrementally can sit on a divergent
  tree until it next does a canonical replay. The transient "Unplaced pseudo-node for one round
  trip" of ADR 003 becomes "until the next canonical replay". That window needs a bound.

### 6.2 Page-name collisions

`CREATE UNIQUE INDEX page_key ON page(key) WHERE deleted_at IS NULL` is enforced by SQLite on both
sides today, and the server is where two devices creating `[[Meeting notes]]` concurrently get
reconciled. `docs/spec/sql-schema.md`'s own open issues already admit "Page-name-collision
reconciliation is out of scope". Under E2EE the relay certainly cannot help. This needs a
deterministic client-side merge rule (lowest-HLC page wins the key; the loser is renamed or
merged) — which is needed anyway and is currently unspecified. E2EE does not create this bug, it
removes the last place you could have hidden it.

### 6.3 `/sync/snapshot`

The bootstrap path returns materialized rows from all four state tables. A relay holding only
ciphertext cannot produce it. Two replacements:

- **Replay the whole encrypted log.** Measured: replaying all 19,580 ops into an empty replica
  takes **244 ms** (`scratchpad/replay.mts`, via `applyOps` through the real `SqlDriver`), plus
  **287 ms** to AES-GCM-decrypt them one-by-one (§3.5) and ~12.3 MiB of transfer. Viable *at this
  log's size* — but this log has exactly one op per entity, because it came from an import.
  `sql-schema.md` rule 28 projects a mature log at **50k–150k ops**; scaling linearly gives
  0.6–1.9 s of replay natively, and `sqlite-wasm` on a phone is plausibly 10–20× that. So
  snapshot-less bootstrap is fine now and becomes the thing that breaks first.
- **Client-published encrypted snapshots.** A device periodically uploads an encrypted, opaque
  state snapshot plus the cursor it is valid at; the relay stores and serves the blob without
  understanding it. This is the correct design, it keeps GC working, and it is the only thing that
  keeps bootstrap constant-time as the log grows.

### 6.4 The audit trail and `batch.undo`

`recordChanges` writes a full plaintext pre/post image of every touched entity into
`changes.before_json`/`after_json` — 5.95 MiB on the real graph — and `ops/batch-undo.ts` reads
`before_json` back to synthesize compensating ops. This is the single most sensitive table in the
database and it exists purely for a server-side feature. Under E2EE it must either be encrypted
(and `batch.undo` moves client-side, where the pre-images are reconstructible anyway from the local
replica) or dropped. Encrypting it is not optional: an audit table of plaintext before/after
snapshots on a relay you claim cannot read notes would be an outright contradiction.

### 6.5 Is `nooklet verify` still meaningful?

Yes, but not on the relay. `server/verify.ts` replays the op log into a scratch database and diffs
`page`/`block`/`block_prop`/`page_prop` against live state. Every input it needs — the ops and the
state — is available **on any device holding the key**. So `verify` moves from "a server-side dev
check" to "a client-side or CLI-replica check", unchanged in substance. The existing caveat it
already handles (GC'd log head → `minSeq > 1` → divergence is expected, not a regression) carries
over untouched.

The relay keeps one verification job it can still do blind, and it is worth keeping: it can check
that `op.id` is a well-formed HLC, that it is unique, and that the device's clock is not >60 s
ahead. `isOp()` and `Hlc.receive()` both work on plaintext metadata only.

---

## 7. Multi-user and multi-graph

The schema is further along here than the product is. `docs/spec/00-conventions.md` and
`sql-schema.md` rule 2 already require `graph_id TEXT NOT NULL DEFAULT 'default'` on every
top-level writable table, explicitly so "this can change without migration", even though v1 is
one graph per server (PLAN.md §17.7).

- **Per-graph keys.** The unit of encryption is the graph, matching the unit of sharing and the
  unit that already has a column. A graph key encrypts that graph's ops, assets, and snapshots;
  nothing else.
- **Server-side isolation.** Independent of crypto, and needed first: today `graph_id` is never
  set to anything but the default, `snapshot.ts` does `SELECT * FROM page` with no `graph_id`
  filter, and `recordChanges` hardcodes `'default'`. Multi-tenancy means auditing every query for
  a `graph_id` predicate and binding tokens to graphs. **Do that before, and separately from,
  E2EE** — a tenancy bug leaks ciphertext-plus-metadata to the wrong user, and E2EE will not save
  you from it.
- **Sharing a graph** means wrapping the graph key to another user's public key. That requires
  per-user identity keys and a way to trust them (§4), which is the hard part, not the wrapping.
- **Revoking a device or a user** requires rotating the graph key and re-wrapping to the remaining
  members — and, to be blunt about it: **you cannot un-share what they already decrypted.** A
  revoked member keeps every plaintext they ever held. Rotation protects *future* ops only. Any
  UI that says "removed" must not imply otherwise.
- Rotation also means ops carry a **key epoch** so a client knows which key decrypts which op.
  That field has to exist from the first encrypted op ever written, or rotation is a migration.
  See §10.3.

---

## 8. The headless CLI replica — the load-bearing idea, not a side quest

The user's framing was "a CLI client that syncs like any device and holds a full copy, so backups
need no trusted server". That is correct as far as it goes, and it undersells it.

Under E2EE, the relay loses the entire API/MCP tier (§1.3 row 6) — which is nooklet's first
principle. The CLI replica is **where that tier goes**. It is a device with a key, so it can hold
the decrypted state, maintain `ref`/`path_ref`/FTS, run Ollama for embeddings, serve
`/api/v1/*` and `/mcp` on localhost or a tailnet, run `nooklet verify`, and write the markdown
mirror — every capability in §1.3, unchanged, just relocated from the relay to the user's own
hardware. `packages/server` already is that program; it needs a sync-client mode rather than a
rewrite.

This resolves the central tension. E2EE does not delete the server tier, it **relocates** it from
"a machine the user doesn't control" to "a machine the user does". The relay becomes the dumb
thing it should have been.

Risks, stated honestly:

- **A long-lived key on an always-on machine.** The CLI replica holds the graph key at rest, with
  no user present. If it runs on a VPS, you have reinvented the trusted server with extra steps and
  worse ergonomics — and the threat model is now "whoever roots that VPS" rather than "whoever
  roots the relay". **It is only a win if it runs somewhere the user already trusts**: their own
  desktop, a home NAS, a Raspberry Pi. Say this in the docs or people will run it on the same box
  as the relay and think they have E2EE.
- **No user present to approve pairing.** Pairing a headless device cannot use the SAS/QR flow of
  §4. It needs a one-time enrolment token generated on a real device, short-lived, single-use, that
  carries the wrapped graph key. It must not be a long-lived bearer token that can pair anything.
- **Its token needs `can_sync` and nothing else.** `requireSyncToken` already enforces `can_sync`
  orthogonally to the `read|write|admin` scope (`sql-schema.md` rule 22), so this is expressible
  today.
- **Backup quality.** As a backup it is genuinely good — it is a live replica, so it has the op log
  and can rebuild state, and `docs/OPERATIONS.md` already covers backup/restore. But a replica is
  not a backup against *logical* corruption: a bad op syncs to it within seconds. It needs
  point-in-time snapshots on top (the op log makes this natural — `rebuild()` to any `seq`), or it
  is only a hardware-failure backup.
- **Encrypted at rest?** If it holds plaintext SQLite, then whole-disk encryption is the honest
  answer; an app-level "encrypted at rest" that decrypts with a key sitting next to it on the same
  disk is theatre. Say which one is meant.

---

## 9. Is this sound security design? The served-client problem

This is the user's actual question, so it gets a direct answer: **as stated — a web client served
by the same server that relays the ciphertext — no, it is not defensible against you, the
operator.** It is defensible against a third party who steals the disk, and against your future
self who gets a subpoena *if* the subpoena arrives after the fact. It is not defensible against an
operator who is willing to change one file.

### 9.1 The argument, and why fifteen years have not dented it

The canonical statement is Ptacek's *Javascript Cryptography Considered Harmful* (Matasano, 2011).
**Both canonical URLs are now dead** (`matasano.com/articles/javascript-cryptography/` and the NCC
Group mirror); the HN submission confirming authorship and date is
<https://news.ycombinator.com/item?id=2935220> (2011-08-28), and a Wayback snapshot should be
retrieved before citing the text itself (§11).

The author has restated it repeatedly since, and those restatements are live, dated, and directly
citable:

- <https://news.ycombinator.com/item?id=21839207> (2019-12-19): *"browser Javascript cryptography
  is essentially cosmetic and provides none of the assurance that cryptography normally offers."*
  In the same comment, pre-empting the two rebuttals that matter here: *"WebCrypto doesn't make any
  of these problems better. WebCrypto provides primitives, but the interesting vulnerabilities in
  cryptosystems are in the joinery; a malicious server can still exfiltrate secrets even if you're
  using WebCrypto"* and *"The standard answer of 'we'll just hash the js files' has never been
  credible!"*
- <https://news.ycombinator.com/item?id=26882760> (2021-04-20): *"there's no such thing as
  'auditing' a browser Javascript application. The code it feeds you on startup is not necessarily
  the code that you are running at any given point during its execution. The entire web security
  model is based on the idea that the origin is the root of security."*
- <https://news.ycombinator.com/item?id=20832823> (2019-08-29): *"There's no difference between
  trusting the server to deliver Javascript cryptography source code and trusting the server with
  your secrets."*
- <https://news.ycombinator.com/item?id=37230481> (2023-08-23): *"the cryptography promises you're
  making only work between users of your system."* This is the most useful framing for nooklet: a
  browser-delivered E2EE relay protects **user against user**, not **user against operator**.

The sharpest modern formulation is <https://www.devever.net/~hl/webcrypto>: *"A cryptosystem is
incoherent if its implementation is distributed by the same entity which it purports to secure
against."* That sentence is the whole of §9 and it applies to the proposed deployment exactly.

The honest steelman exists and should be granted: bren2010's *A Criticism of JavaScript
Cryptography* (<https://blog.bren2010.io/blog/criticism-of-javascript-crypto>) argues that the
critique collapses distinct threat models, and that browser crypto is genuinely useful against a
**passive** adversary — a stolen backup, a compromised disk, an opportunistic snoop — even where it
fails against an **active** one. That is correct, and it is the basis of the narrow recommendation
in §9.4. What it does not do is rescue the claim "I cannot read your notes."

### 9.2 What does not fix it

- **Subresource Integrity.** The W3C spec says it itself
  (<https://www.w3.org/TR/SRI/>): *"These mechanisms, however, authenticate only the server, not
  the content. An attacker (or administrator) with access to the server can manipulate content with
  impunity."* SRI protects a script referenced by an HTML document you trust. Here the same server
  serves the document *and* the script, so it simply serves a different hash. SRI is worth having
  against a compromised CDN; it is worth nothing against the operator.
- **HTTPS/TLS.** Protects the wire against third parties. The operator is not a third party.
- **Open source.** The published repository and the served bundle are different artefacts. Nothing
  ties them together (§9.3).
- **Reproducible builds — unless someone else does the attesting.** Sigstore
  (<https://docs.sigstore.dev>) is scoped to packages, containers and SBOMs, with no web-delivery
  use case. Google's Web Environment Integrity attested the *client environment*, not the served
  code — the wrong direction — and was abandoned in November 2023. **There is no shipped
  Certificate-Transparency-for-JavaScript.**
- **A browser extension, naively.** Wladimir Palant's Keybase analysis
  (<https://palant.info/2018/09/06/keybase-our-browser-extension-subverts-our-encryption-but-why-should-we-care/>)
  is the cautionary case: Keybase's extension injected its chat UI into third-party pages without
  isolating it, so the host page's JavaScript could read plaintext before encryption. An extension
  is not a trust anchor merely by not being the server.

Worth noting that the most honest vendor in this space simply says so. Bitwarden's security white
paper (<https://bitwarden.com/help/bitwarden-security-white-paper/>) states: *"The authenticity and
integrity of the Bitwarden web client depend on the integrity of the HTTPS TLS connection by which
it is delivered"* and *"An attacker capable of tampering with the traffic that delivers the web
client could deliver a malicious client to the user."* They mitigate with HSTS and CSP and do not
claim to have solved it. That is the standard to match in nooklet's own documentation.

### 9.3 What partially fixes it

Exactly one deployed mechanism resembles a solution, and its shape is instructive.

**Meta's Code Verify** (<https://engineering.fb.com/2022/03/10/security/code-verify/>, source at
<https://github.com/facebookincubator/meta-code-verify>, which had **commits dated 2026-09-10**, so
it is alive, contrary to the assumption in the brief) is a browser extension that *"compares the
code that runs on WhatsApp Web against the version of the code verified by WhatsApp and published
on Cloudflare."* The load-bearing detail is that **the hash registry is held by a third party**, not
by the operator. It requires (a) an independent attestor and (b) users installing an extension —
which is why it exists at WhatsApp scale and nowhere else.

Generalising it, the conditions under which hosting a relay for other people becomes defensible:

1. **The client is not served by the relay.** Native/desktop/mobile builds, installed once, updated
   through a channel with a **separate signing key** the relay operator does not hold. This is
   Signal's structural choice — Signal Desktop became a standalone app in 2017
   (<https://signal.org/blog/standalone-signal-desktop/>) — and it is why native clients are not a
   packaging preference here but a security boundary. ADR 005's Capacitor and Tauri paths, and
   `research/10`'s minisign/Ed25519 updater analysis, are directly relevant: `research/10` §4
   already notes the updater is *"a separate trust chain from OS code signing — two private keys to
   escrow."* Under E2EE that separation is the feature.
2. **Reproducible builds plus a third-party attestor**, so a user can check that the artefact they
   installed matches public source without asking the operator. Without (1) this is nearly
   pointless; with (1) it is what makes (1) auditable.
3. **The relay is operated by someone other than the client publisher**, or at minimum the two are
   separable — the user can point the same signed client at a different relay. nooklet is
   self-hostable, so this is achievable and is the cheapest of the three.
4. **The threat model is written down and does not overclaim**, in the Bitwarden style.

### 9.4 The verdict

- **Hosting a relay for other people, with a signed native client they install and can point
  elsewhere, and a written threat model: defensible.** This is roughly the Obsidian Sync posture
  and it is a normal, honest product.
- **Hosting a relay that also serves the web client, and telling users you cannot read their notes:
  not defensible.** You can read their notes whenever you choose to, by shipping different
  JavaScript to one user on one request, and nothing in the system would record that you did. If
  the PWA remains the primary client — and PLAN.md §14 says it is — then this is the deployment
  being proposed, and the claim must be weakened to match: *"the relay stores only ciphertext; the
  web client is served by the relay, so a malicious or compromised relay could serve code that
  exfiltrates your key. Use the desktop app if that matters to you."*
- **Regulators already treat "we control the client" and "we cannot read your data" as compatible
  claims**, which is why the distinction must be made by you rather than assumed. The EFF's
  analysis of Apple's client-side scanning (<https://www.eff.org/deeplinks/2021/08/apples-plan-think-different-about-encryption-opens-backdoor-your-private-life>)
  — *"even a thoroughly documented, carefully thought-out, and narrowly-scoped backdoor is still a
  backdoor"* — is about precisely this: whoever controls the client decides what the encryption
  means.

One further consequence specific to this codebase: **E2EE would be undermined by nooklet's own
plugin model.** ADR 007's v1 runtime loads client plugins as trusted ES modules via `import()`,
and the server half serves those client bundles. A relay that serves plugin code to a client that
holds keys has the §9.1 problem a second time, through a door that is *designed* to be open. If
E2EE ships, plugin delivery must move to the sandboxed Web Worker + iframe host that ADR 007 lists
as a v2 item, or plugins must be installed locally rather than fetched from the relay.

---

## 10. An incremental path, and the one-way doors

### 10.1 Ship these regardless of whether E2EE ever happens

Each is independently justified, and each removes a dependency E2EE would otherwise have to break.

1. **Client-side FTS and `ref`/`path_ref`** (§5.5). ~4.7 MiB, ~300 ms, code that already runs in
   the browser, and it makes search and backlinks work offline today. Highest value, lowest risk.
2. **Real `graph_id` scoping and per-graph token binding** (§7). Multi-tenancy correctness is a
   prerequisite for hosting anyone else's data at all, encrypted or not.
3. **A binary sync wire format.** §3.5 shows base64 would cost +36 % against +8 % for the tags
   themselves. Changing the encoding is easier before there is ciphertext in it.
4. **Per-device Ed25519 signing on ops** (§2.4). Useful on its own — it turns `device` from a label
   into an identity, and it is the precondition for detecting a withholding relay.
5. **A `nooklet sync` client mode for `packages/server`** (§8). The headless replica is a good
   backup story today and the load-bearing component under E2EE.

### 10.2 Then, if E2EE is wanted

6. Encrypt `changes.before_json`/`after_json`, or drop the table and move `batch.undo` client-side.
   This is the largest single plaintext exposure per byte and it exists only for a server feature.
7. Turn off the markdown mirror for relay-hosted graphs, and encrypt assets as opaque blobs.
8. Add the key hierarchy (§3.1), pairing (§4.3) and recovery key (§4.4).
9. Move the op payload behind AEAD; keep `id`/`hlc`/`device`/`entity` clear (§10.3).
10. Replace `/sync/snapshot` with client-published encrypted snapshots (§6.3).
11. Move the canonical HLC-ordered replay onto a schedule on the client, so §6.1's convergence rule
    is actually exercised rather than merely available.

### 10.3 Is adding E2EE later a breaking change to the op log?

**To the op *model*, no. To the wire format and the `op` table, yes — and one field must be added
now if it is ever to be added cheaply.**

- `Op`'s shape survives. `payload` becomes an opaque envelope; `id`, `hlc`, `device` and `entity`
  stay exactly as they are, because §1.1 shows the protocol reads all four. `isOp()` continues to
  validate them.
- `op.payload_json TEXT NOT NULL` becomes a ciphertext column — a schema migration, but a
  mechanical one, and `sql-schema.md` rule 27's create-backfill-swap convention already covers it.
- **The genuine one-way door is the key epoch.** An encrypted op must say which graph key opens it.
  If the first encrypted op ever written lacks that field, key rotation — and therefore device
  revocation and graph sharing (§7) — requires rewriting the whole log. Adding a nullable
  `key_epoch INTEGER` to `op` *before* any ciphertext exists costs one migration and nothing else.
  This is the cheapest insurance in the document.
- A second, smaller door: **GC and encryption interact.** `nooklet gc` deletes ops below
  `MIN(device.acked_seq)`, and `verify.ts` already documents that a trimmed log can no longer be
  fully replayed. Under E2EE, where §6.3 may make log replay the *only* bootstrap path, GC becomes
  load-bearing in a way it is not today. Client-published snapshots (§6.3) must land before or with
  GC, not after.
- The op log is also the **undo history** (`batch_undo`) and the `scheduled`/`repeat` history that
  ADR 011 uses in place of LOGBOOK drawers. Encrypting it does not lose that, but it does mean
  every consumer of that history must hold a key — another vote for §8.

### 10.4 What not to do

- Do not build searchable encryption (§5.3).
- Do not build a PAKE on a stale draft implementation (§4.2).
- Do not ship a PIN-based recovery flow without rate-limiting hardware (§4.4).
- Do not describe a browser-delivered E2EE relay as something the operator cannot read (§9.4).
- Do not add app-level at-rest encryption on the client and call it E2EE (§3.6).

---

## 11. Still unverified

Copying `research/10`'s shape: these are the things this report could not check and that would
change its conclusions if they came out differently.

1. **WebKit bug 312279** (non-extractable X25519 `CryptoKey` returning null from IndexedDB in
   Safari) was read from the bug tracker, not reproduced here. It sits on §4.3's critical path.
   A ten-line probe on a real iPhone settles it; write it before committing to X25519 wrapping.
2. **Whether Capacitor's `capacitor://` scheme is a secure context in WKWebView**, and therefore
   whether `crypto.subtle` is even present there. No primary source found. This is exactly the
   shape of the WKWebView/OPFS claim that `research/10` §1 disproved by probing — do the same here;
   `tools/probes/wkwebview-opfs.swift` is most of the harness already.
3. **`sqlite-wasm` FTS5 query latency and index size in a browser.** §5.1's numbers are native
   `node:sqlite` on arm64. The argument has two orders of magnitude of headroom, so the conclusion
   is robust, but the actual browser and phone numbers are unmeasured.
4. **`path_ref` maintenance cost on a phone** when moving a large subtree (§5.2). The one plausible
   failure mode in the client-side-references plan.
5. **Replay-based bootstrap at a mature log size.** §6.3 measured 244 ms for 19,580 import-shaped
   ops. A 150k-op log of real edits in `sqlite-wasm` on a phone is unmeasured and is where this
   design breaks first.
6. **Argon2id parameters on a low-end phone.** Neither `hash-wasm` nor `argon2-browser` publishes
   mobile benchmarks. Note also that the two authoritative parameter sets differ by more than an
   order of magnitude and target different regimes: OWASP's cheat sheet
   (<https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>) recommends
   *"a minimum configuration of 19 MiB of memory, an iteration count of 2, and 1 degree of
   parallelism"* for server-side password storage, while RFC 9106
   (<https://www.rfc-editor.org/rfc/rfc9106.html>) gives as its *"FIRST RECOMMENDED option"*
   Argon2id with *"t=1 iteration, p=4 lanes, m=2^(21) (2 GiB of RAM)"* and a second option at
   64 MiB. Standard Notes' shipped choice (64 MiB, t=5) sits near RFC 9106's second option. §3.3's
   recommendation to prefer a high-entropy random recovery key sidesteps this whole question.
7. **Chrome's Ed25519 status.** MDN's browser-compat data says Chrome 137; Chrome Platform Status
   (<https://chromestatus.com/feature/4913922408710144>, last updated 2025-08-22) says it is still
   behind the `WebCryptoEd25519` runtime flag. Unresolved; Firefox 129 and Safari 17 are solid.
   Test before relying on it, or use Ed25519 via `@noble/curves` in the browser.
8. **The original 2011 Ptacek article's text.** Both canonical URLs are dead and the Wayback
   snapshot was not retrievable in this session. §9.1 cites the author's dated restatements
   instead, which are live; retrieve the original before quoting it directly.
9. **Proton's "verified builds" for the *web* client.** Could not be confirmed; the
   `ProtonMail/WebClients` README does not mention reproducible or verified builds. Do not cite
   Proton as prior art for web-app build verification without checking.
10. **Standard Notes' documentation** was only readable through a reader proxy (the origin returns
    403 to automated fetches). The Argon2id parameters in §4.1 should be re-checked against a
    direct read before being treated as exact.
11. **Signal's device-linking handshake** has no published specification — `signal.org/docs` lists
    six specs and linking is not among them. §4.1's row reflects that absence honestly; the
    mechanism is inferable only from `libsignal` source.
12. **Matrix device dehydration** is MSC3814, still marked Work In Progress as of 2026-07-01, not a
    ratified spec module. Relevant if a "cold spare device" is ever wanted instead of §8's replica.
13. **SQLite3MultipleCiphers' WASM build with OPFS** (§3.6) — the changelog shows a WASM build
    exists; OPFS compatibility is unconfirmed.
14. **Whether anyone ships a synced encrypted search index.** None was found (§5.3), but the search
    tooling for this report was degraded (WebSearch quota was exhausted; findings came from direct
    fetches of primary URLs). Treat "no precedent found" as literal, not as "impossible".
15. **Op-id collision probability in practice.** `newDeviceId()` is 32 random bits. §3.2 rejects
    deterministic nonces on this basis; the actual collision probability across a realistic device
    population was not computed and the `op.id UNIQUE` constraint's behaviour on collision was not
    tested.

---

## 12. Sources

Architecture and measurements, in this repository: `docs/PLAN.md`, `docs/adr/003-sync-oplog-hlc-lww.md`,
`docs/adr/010-embeddings-and-search.md`, `docs/adr/013-ai-parity-undo-assets-live-ui.md`,
`docs/spec/sql-schema.md`, `docs/research/03-sync.md` §4/§6, `docs/research/06-embeddings.md` §3.2,
`docs/research/10-desktop-packaging.md` §4, `packages/core/src/{ops,hlc,ids,refs}.ts`,
`packages/core/src/sync/{apply-ops,schema,gc}.ts`, `packages/server/src/apply-ops.ts`,
`packages/server/src/sync/{push,pull,snapshot,auth,device}.ts`, `packages/server/src/verify.ts`,
`packages/server/src/ops/batch-undo.ts`, `packages/server/src/mirror/export.ts`,
`apps/web/src/data/api-client.ts`, `apps/web/src/db/schema-client.ts`,
`apps/web/src/sync/sync-client.ts`.

Measurement scripts written for this report (scratchpad, not committed): `crypto-bench.mjs`,
`crypto-bench2.mjs`, `buildidx.mjs`, `q.mjs`, `leak.mjs`, `wire.mjs`, `replay.mts`.

Standards and specifications: W3C Web Cryptography API Level 2 <https://w3c.github.io/webcrypto/>;
WICG Modern Algorithms <https://wicg.github.io/webcrypto-modern-algos/>; W3C Subresource Integrity
<https://www.w3.org/TR/SRI/>; NIST SP 800-38D
<https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf>; RFC 9106 (Argon2)
<https://www.rfc-editor.org/rfc/rfc9106.html>; RFC 9382 (SPAKE2)
<https://www.rfc-editor.org/rfc/rfc9382.txt>; RFC 9807 (OPAQUE)
<https://www.rfc-editor.org/rfc/rfc9807.txt>; Matrix client-server API
<https://spec.matrix.org/latest/client-server-api/>; MSC3814
<https://github.com/matrix-org/matrix-spec-proposals/pull/3814>.

Vendor documentation: Obsidian Sync security <https://obsidian.md/help/sync/security>; Standard
Notes encryption specification <https://docs.standardnotes.com/specification/encryption>; Signal
Secure Value Recovery <https://signal.org/blog/secure-value-recovery/>, Secure Backups
<https://signal.org/blog/introducing-secure-backups/>, standalone Desktop
<https://signal.org/blog/standalone-signal-desktop/>, SVR2
<https://github.com/signalapp/SecureValueRecovery2>; 1Password security white paper
<https://1passwordstatic.com/files/security/1password-white-paper.pdf>; Apple Platform Security —
keychain syncing <https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web>,
escrow <https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web>,
Advanced Data Protection <https://support.apple.com/en-us/102651>; Bitwarden security white paper
<https://bitwarden.com/help/bitwarden-security-white-paper/>; Proton Mail search
<https://proton.me/support/search-message-content>; Tuta encrypted search
<https://tuta.com/blog/first-search-encrypted-data>; Joplin search
<https://joplinapp.org/help/apps/search/>; SQLite FTS5 <https://sqlite.org/fts5.html>; SQLite WASM
<https://sqlite.org/wasm/doc/trunk/index.md>; WebKit tracking prevention
<https://webkit.org/tracking-prevention/>; Meta Code Verify
<https://engineering.fb.com/2022/03/10/security/code-verify/>.

Academic: Cash, Grubbs, Perry, Ristenpart, *Leakage-Abuse Attacks Against Searchable Encryption*
<https://eprint.iacr.org/2016/718>; Islam, Kuzu, Kantarcioglu, *Access Pattern Disclosure on
Searchable Encryption* (NDSS 2012)
<https://www.ndss-symposium.org/ndss2012/ndss-2012-programme/access-pattern-disclosure-searchable-encryption-ramification-attack-and-mitigation/>;
Zhang, Katz, Papamanthou, *All Your Queries Are Belong to Us* <https://eprint.iacr.org/2016/172>;
Blackstone, Kamara, Moataz, *Revisiting Leakage-Abuse Attacks* <https://eprint.iacr.org/2019/1175>;
Naveed, Kamara, Wright, *Inference Attacks on Property-Preserving Encrypted Databases*
<https://www.cs.brown.edu/~seny/pubs/edb.pdf>; Hoover et al., *Leakage-Abuse Attacks Against
Structured Encryption for SQL* <https://eprint.iacr.org/2024/554>; Seah et al., *LAMA*
<https://eprint.iacr.org/2024/1308>; Amjad, Kamara, Moataz, *Injection-Secure Structured and
Searchable Symmetric Encryption* <https://eprint.iacr.org/2023/533>; Henzinger et al., *SimplePIR*
<https://eprint.iacr.org/2022/949>; Henzinger et al., *Private Web Search with Tiptoe*
<https://github.com/ahenzinger/tiptoe>.

Critique: Ptacek, HN restatements <https://news.ycombinator.com/item?id=21839207>,
<https://news.ycombinator.com/item?id=26882760>, <https://news.ycombinator.com/item?id=20832823>,
<https://news.ycombinator.com/item?id=37230481>; Hugo Landau, *Web-based cryptography is always
snake oil* <https://www.devever.net/~hl/webcrypto>; bren2010, *A Criticism of JavaScript Cryptography*
<https://blog.bren2010.io/blog/criticism-of-javascript-crypto>; Palant on Keybase
<https://palant.info/2018/09/06/keybase-our-browser-extension-subverts-our-encryption-but-why-should-we-care/>;
EFF on Apple client-side scanning
<https://www.eff.org/deeplinks/2021/08/apples-plan-think-different-about-encryption-opens-backdoor-your-private-life>.

Libraries: `@noble/ciphers` 2.4.0 <https://github.com/paulmillr/noble-ciphers> (cure53 audit at
v1.0.0, Sept 2024); `libsodium.js` <https://github.com/jedisct1/libsodium.js>; `hash-wasm`
<https://github.com/Daninet/hash-wasm>; `@cloudflare/opaque-ts`
<https://github.com/cloudflare/opaque-ts>; SQLite3MultipleCiphers
<https://github.com/utelle/SQLite3MultipleCiphers>; WebKit bugs
<https://bugs.webkit.org/show_bug.cgi?id=312279>, <https://bugs.webkit.org/show_bug.cgi?id=308718>.
