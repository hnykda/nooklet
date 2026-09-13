/**
 * `nooklet repair org-dates`: a one-off repair for graphs imported before B-143.
 *
 * Until B-143 the importer took an org timestamp's date only as `YYYY-MM-DD`, so Logseq's
 * `SCHEDULED: <2023-2-17 Fri>` stayed in the block's text and the date was never stored — no chip,
 * no place in the Tasks view or a journal's "Scheduled and deadline" section. The parser is fixed;
 * a database imported before that still holds the text (20 blocks on the owner's graph). This finds
 * those lines with the parser's own rule (`@nooklet/core`'s `findOrgDateLines`, so it takes exactly
 * the lines a re-import would and nothing else), and turns each into the real
 * `scheduled`/`deadline`/`repeat` value plus the text without that line.
 *
 * Shape of the write, and why:
 *  - **Ops through `serverApplyOps`**, never an `UPDATE`: every device follows the op log, and
 *    `nooklet verify` diffs live state against it.
 *  - **One call, so one `batch_id`**: the whole repair is one `batch_undo` away.
 *  - **All or nothing**: inside a savepoint; if any op is not applied, it is rolled back and
 *    nothing is written. A repair that half-lands is harder to reason about than one that refuses.
 *  - **Refuses to guess.** A block whose text disagrees with a date it already has (someone set one
 *    since the import), or that names two different dates of one kind, is reported and left alone.
 *
 * Dry run is the default; `--apply` writes. Not an op in the registry: it is a one-off for data
 * written by an old importer, not a capability an agent should reach for.
 */

import { findOrgDateLines, formatDayTime, makeOp, type Op, type TaskMarker } from "@nooklet/core";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { wirePageNameOf } from "./rows.js";

/** Stored on every `changes` row the repair writes, so History and `changes_since` say who. */
export const ORG_DATES_ACTOR = "repair:org-dates";

export interface OrgDateFields {
  content: string;
  scheduled: string | null;
  deadline: string | null;
  repeat: string | null;
}

export interface OrgDateRepair {
  blockId: string;
  /** The page's wire name (ISO for a journal day). */
  page: string;
  marker: TaskMarker | null;
  before: OrgDateFields;
  after: OrgDateFields;
}

export interface OrgDateSkip {
  blockId: string;
  page: string;
  content: string;
  reason: string;
}

export interface OrgDateRepairPlan {
  repairs: OrgDateRepair[];
  skipped: OrgDateSkip[];
}

export interface OrgDateRepairResult extends OrgDateRepairPlan {
  /** `undefined` when there was nothing to write. */
  batchId: string | undefined;
  /** Ops applied — every op the plan made, or the call throws. */
  applied: number;
}

interface CandidateRow {
  id: string;
  content: string;
  marker: TaskMarker | null;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  page_name: string;
  page_journal_day: number | null;
}

/** What `--apply` would do, reading only. Blocks in the trash, or on a page in it, are not looked
 * at: restoring one brings its text back as it was, which is no worse than today. */
export function planOrgDateRepair(ctx: ServerContext): OrgDateRepairPlan {
  // `LIKE` is only a cheap prefilter (it folds case, the parser does not); `findOrgDateLines`
  // decides. `instr` would be exact but reads the same rows.
  const rows = ctx.driver.all<CandidateRow>(
    `SELECT b.id, b.content, b.marker, b.scheduled_day, b.scheduled_time, b.deadline_day,
            b.deadline_time, b.repeat, p.name AS page_name, p.journal_day AS page_journal_day
     FROM block b JOIN page p ON p.id = b.page_id
     WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL
       AND (b.content LIKE '%SCHEDULED:%' OR b.content LIKE '%DEADLINE:%')
     ORDER BY p.name, b.created_at, b.id`,
  );

  const repairs: OrgDateRepair[] = [];
  const skipped: OrgDateSkip[] = [];
  for (const row of rows) {
    const found = findOrgDateLines(row.content);
    if (found.length === 0) continue;
    const page = wirePageNameOf({ name: row.page_name, journal_day: row.page_journal_day });
    const before: OrgDateFields = {
      content: row.content,
      scheduled:
        row.scheduled_day === null ? null : formatDayTime(row.scheduled_day, row.scheduled_time),
      deadline:
        row.deadline_day === null ? null : formatDayTime(row.deadline_day, row.deadline_time),
      repeat: row.repeat,
    };
    const skip = (reason: string): void => {
      skipped.push({ blockId: row.id, page, content: row.content, reason });
    };

    const after: OrgDateFields = { ...before };
    let refused = false;
    for (const key of ["scheduled", "deadline"] as const) {
      const values = [...new Set(found.filter((d) => d.key === key).map((d) => d.value))];
      if (values.length === 0) continue;
      if (values.length > 1) {
        skip(`its text names ${values.length} different ${key} dates (${values.join(", ")})`);
        refused = true;
        break;
      }
      const value = values[0] as string;
      if (before[key] !== null && before[key] !== value) {
        skip(`it already has ${key} ${before[key]}, and its text says ${value}`);
        refused = true;
        break;
      }
      after[key] = value;
    }
    if (refused) continue;

    const repeats = [
      ...new Set(found.map((d) => d.repeat).filter((r): r is string => r !== undefined)),
    ];
    if (repeats.length > 1) {
      skip(`its text names ${repeats.length} different repeats (${repeats.join(", ")})`);
      continue;
    }
    if (repeats.length === 1) {
      const repeat = repeats[0] as string;
      if (before.repeat !== null && before.repeat !== repeat) {
        skip(`it already repeats every ${before.repeat}, and its text says ${repeat}`);
        continue;
      }
      after.repeat = repeat;
    }

    const drop = new Set(found.map((d) => d.index));
    const kept = row.content.split("\n").filter((_, i) => !drop.has(i));
    // The parser drops a block's trailing blank lines, so a re-import of `a⏎⏎SCHEDULED: <…>` is
    // `a`. Taking only the date line out left `a⏎` — an empty last line in the editor that no
    // import would ever write.
    while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();
    after.content = kept.join("\n");
    repairs.push({ blockId: row.id, page, marker: row.marker, before, after });
  }
  return { repairs, skipped };
}

/** The ops for one repair: each date field that changes, then the text. */
function opsFor(ctx: ServerContext, r: OrgDateRepair): Op[] {
  const ops: Op[] = [];
  for (const key of ["scheduled", "deadline", "repeat"] as const) {
    if (r.after[key] === r.before[key]) continue;
    ops.push(
      makeOp(ctx.hlc.next(), SERVER_DEVICE_ID, r.blockId, {
        kind: "block.prop",
        key,
        value: r.after[key],
      }),
    );
  }
  ops.push(
    makeOp(ctx.hlc.next(), SERVER_DEVICE_ID, r.blockId, {
      kind: "block.text",
      content: r.after.content,
    }),
  );
  return ops;
}

/**
 * Plan, then write every repair as one batch. Throws — having written nothing — if any op is not
 * applied.
 */
export function applyOrgDateRepair(ctx: ServerContext): OrgDateRepairResult {
  // The plan is read inside the same savepoint it is written in: a server running on this database
  // that commits in between makes the write fail as busy, rather than land on text the plan never
  // saw.
  const sp = ctx.driver.savepoint();
  try {
    const plan = planOrgDateRepair(ctx);
    if (plan.repairs.length === 0) {
      sp.release();
      return { ...plan, batchId: undefined, applied: 0 };
    }

    // A fresh CLI process's clock starts at the wall clock. A field last written by a device whose
    // clock ran a little ahead carries a later HLC, and last-writer-wins would turn that field's op
    // into a noop. Absorb every HLC these fields carry first, so each op minted below wins.
    for (const r of plan.repairs) {
      const hlcs = ctx.driver.get<Record<string, string | null>>(
        "SELECT content_hlc, scheduled_hlc, deadline_hlc, repeat_hlc FROM block WHERE id = ?",
        [r.blockId],
      );
      for (const h of Object.values(hlcs ?? {})) if (h) ctx.hlc.receive(h);
    }

    const ops = plan.repairs.flatMap((r) => opsFor(ctx, r));
    const result = serverApplyOps(ctx, ops, { origin: "system", actor: ORG_DATES_ACTOR });
    const failed = result.results.find((one) => one.status !== "applied");
    if (failed) {
      sp.rollback();
      throw new Error(
        `repair org-dates: ${failed.kind} on block ${failed.entity} was ${failed.status}` +
          `${failed.status === "rejected" ? ` (${failed.reason})` : ""}; nothing was written`,
      );
    }
    sp.release();
    return { ...plan, batchId: result.batchId, applied: result.applied };
  } catch (e) {
    sp.rollback();
    throw e;
  }
}

/** The report `nooklet repair org-dates` prints: one entry per block, before and after. `applied`
 * is the result of `--apply`; without it the report is a dry run's. */
export function formatOrgDateReport(
  result: OrgDateRepairPlan,
  applied?: OrgDateRepairResult,
): string {
  const lines: string[] = [];
  const show = (s: string): string => JSON.stringify(s);
  const dates = (f: OrgDateFields): string =>
    [
      f.scheduled && `scheduled ${f.scheduled}`,
      f.deadline && `deadline ${f.deadline}`,
      f.repeat && `repeat ${f.repeat}`,
    ]
      .filter(Boolean)
      .join(", ") || "no dates";
  for (const r of result.repairs) {
    lines.push(`${r.blockId}  ${r.page}${r.marker ? `  ${r.marker}` : ""}`);
    lines.push(`  before: ${show(r.before.content)}  (${dates(r.before)})`);
    lines.push(`  after:  ${show(r.after.content)}  (${dates(r.after)})`);
  }
  for (const s of result.skipped) {
    lines.push(`${s.blockId}  ${s.page}  LEFT ALONE: ${s.reason}`);
    lines.push(`  text: ${show(s.content)}`);
  }
  const n = result.repairs.length;
  const blocks = `${n} block${n === 1 ? "" : "s"}`;
  if (applied?.batchId) {
    lines.push(
      `repaired ${blocks} in one batch (${applied.applied} ops), batch_id ${applied.batchId}`,
      `undo: batch_undo with that batch_id (MCP), or POST /api/v1/batch.undo {"batch_id": "${applied.batchId}"}`,
    );
  } else if (applied) {
    lines.push("nothing to repair");
  } else {
    lines.push(
      n === 0 ? "nothing to repair" : `dry run: would repair ${blocks}; run again with --apply`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push(`${result.skipped.length} left alone (see above)`);
  }
  return lines.join("\n");
}
