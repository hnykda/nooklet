/**
 * `equals` for a memo over plain data that is re-read on every refresh (B-511).
 *
 * Every resource here refetches whenever its tables change — a sync pull, or a local write
 * anywhere on the page — and hands back freshly built objects even when nothing in them changed.
 * A keyed `<For>` over those objects sees all-new items and throws the DOM away: every query
 * result, every reference row, every date chip and property row was rebuilt with identical
 * content on every refresh. A memo that compares by value passes the previous array on instead,
 * so nothing downstream runs.
 *
 * Plain JSON-shaped data only (what SQL rows and API responses are). A `Map`, a `Set` or a class
 * instance stringifies to `{}` and would compare equal to any other — never use it for those.
 * Key order matters, which is fine for data built by the same code path each time; the worst a
 * false "different" costs is the re-render that happened before.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
