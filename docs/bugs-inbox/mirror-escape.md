# Bug inbox — mirror-escape (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-470..B-479.

---

### B-342 (existing)

**In progress 2026-09-13** (owner chose option 2, the serializer escape). Core fix and unit tests
committed; server-side checks (block.update, importer, verify, export diff) still to come. Measured before the fix
on a `.backup` copy of the owner's graph (953 pages, 18,630 blocks) with
`tools/probes/mirror-roundtrip-graph.ts`: 2 pages / 20 blocks read back differently — the literal
`SCHEDULED: <…>` content lines left by the pre-B-266 import, each read back as a real `scheduled`
date with that line gone from the text. The probe `serialize-property-shaped-content.ts` said
lossless=false for all five shapes. Also found while measuring: a content line `:LOGBOOK:` (OUT-23
rule 3) is the same class and worse — it and every following line up to `:END:` are dropped from
the text on re-read; included in the fix.
