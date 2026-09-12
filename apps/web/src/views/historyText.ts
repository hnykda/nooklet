/**
 * Pure text helpers for the History and Trash views (`HistoryView.tsx`, `TrashView.tsx`): a
 * word-level diff for "what changed in this block", and the relative timestamps the timeline is
 * scanned by. Kept out of the components so they are unit-testable without a DOM
 * (`historyText.test.ts`).
 */

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

/** Words and the whitespace between them, as separate tokens, so a diff can keep the spacing of
 * whichever side it renders. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Above this many token pairs the O(n·m) table is not worth it for a diff nobody will read
 * word by word; the fallback shows the old text struck through and the new one whole. */
const MAX_CELLS = 250_000;

/**
 * Word-level diff of `before` -> `after` via longest common subsequence, merged into runs. A
 * change inside one word shows as that word removed and the new one added — right for block text,
 * where a typo fix and a rewrite look the same to a reader skimming a timeline.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before === "" ? [] : [{ kind: "same", text: before }];
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...(before ? [{ kind: "del" as const, text: before }] : []),
      ...(after ? [{ kind: "add" as const, text: after }] : []),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * cols + j] as number, lcs[i * cols + j + 1] as number);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i] as string);
      i++;
      j++;
    } else if ((lcs[(i + 1) * cols + j] as number) >= (lcs[i * cols + j + 1] as number)) {
      push("del", a[i] as string);
      i++;
    } else {
      push("add", b[j] as string);
      j++;
    }
  }
  while (i < a.length) push("del", a[i++] as string);
  while (j < b.length) push("add", b[j++] as string);
  return parts;
}

/** "just now", "5 minutes ago", "yesterday 14:02", "3 Sep 2026 09:15" — recency in words while it
 * is recent, the date once it is not. `now` is injectable for tests. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const minute = 60_000;
  const hour = 60 * minute;
  if (diff < minute) return "just now";
  if (diff < hour) {
    const m = Math.floor(diff / minute);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  const sameDay = (x: Date, y: Date): boolean =>
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate();
  if (sameDay(d, today)) return `today ${hm}`;
  const yesterday = new Date(now - 24 * hour);
  if (sameDay(d, yesterday)) return `yesterday ${hm}`;
  const month = d.toLocaleString("en", { month: "short" });
  return `${d.getDate()} ${month} ${d.getFullYear()} ${hm}`;
}

/** The keys whose value differs between two property bags, with both sides. */
export function diffProperties(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): Array<{ key: string; before?: string; after?: string }> {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: Array<{ key: string; before?: string; after?: string }> = [];
  for (const key of [...keys].sort()) {
    const b = before?.[key];
    const a = after?.[key];
    if (b !== a) out.push({ key, before: b, after: a });
  }
  return out;
}
