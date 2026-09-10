/**
 * TODO(views): this is a placeholder proving the data seam works end to end, not the Journals
 * view (PLAN.md §8: today always on top, infinite scroll of earlier non-empty days, a calendar).
 * Replace the body of this component; keep the `useJournalStream` call as the shape to build on.
 */
import { useJournalStream } from "../data/store.js";

function todayAsJournalDay(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function JournalsRoute() {
  const stream = useJournalStream(() => ({ today: todayAsJournalDay(), maxDays: 14 }));

  return (
    <div class="placeholder-view">
      <p>
        TODO(views): render the journal stream. Data seam: <code>useJournalStream()</code> in{" "}
        <code>src/data/store.ts</code>.
      </p>
      {stream.loading && <p>Loading…</p>}
      {stream.error && <p>Error: {String(stream.error)}</p>}
      <ul>
        {(stream() ?? []).map((entry) => (
          <li>
            {entry.day} — {entry.blocks.length} block(s)
            {entry.page === null && " (no page yet)"}
          </li>
        ))}
      </ul>
    </div>
  );
}
