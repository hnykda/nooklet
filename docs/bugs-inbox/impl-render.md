# Bugs inbox — impl-render (m8)

Entries in `docs/BUGS.md` format, for the coordinator to fold in. Numbers for new bugs come from
B-150..B-159 only.

---

### B-100 (existing)
Numbered lists never render.

---

### B-101 (existing)
Block properties are invisible in the UI, and `/property` writes literal text.

---

### B-99 (existing)
`/image` does nothing.

---

### B-150 · Image paste uploads without a credential, so it cannot work in the served app
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, reading `editor/paste.ts` while
wiring `/image` (B-99) · **Test:** (pending)

`editor/paste.ts#uploadImageAsset` calls `fetch("/api/v1/asset.upload")` with no `authorization`
header. Every `/api/v1/*` route sits behind `bearerAuth` (`packages/server/src/http/app.ts`), so
the served app gets a 401 and the paste is silently dropped (the catch only logs to the console).
Nothing covered it: no e2e test pastes an image, and `assets.spec.ts` uploads through its own
authenticated helper. Same class of defect as the "client has no API credential" bug the e2e suite
was created for.

---

### B-151 · A block that opens with a code fence loses its properties when serialized without ids
**Status:** open · **Severity:** low · **Found:** 2026-09-13, writing `core/block-text.ts` (B-101) ·
**Test:** none yet; `tools/probes/serialize-fence-props.ts` reproduces it

`serializeOutline(page, { ids: "none" })` writes a block's property lines straight after its first
line. When that line opens a fence (```` ```js ````), the property lines land inside the fence and
re-parse as code: `- ```js\n  foo:: bar\n  code\n  ```` comes back with `properties: {}` and the
`foo:: bar` line in the code. With ids (the mirror's default) OUT-14 puts `^id` alone on line 1 and
the round trip holds, which is why the mirror never showed it. Callers with `ids: "none"`:
`BlockTree.tsx`'s `block.copySelection` (copy then paste loses the property) and the server's
`outline-bridge.ts#renderSingleBlockText` (the before-text `block.update` matches `old_str`
against). `core/block-text.ts#joinBlockText` avoids the same trap by writing such a block's
properties after the closed fence. Fix: the same placement in `serializeOutline`.
