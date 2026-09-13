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
