/**
 * The badge's "recent activity" list (ADR 015 §2.6: "Claude looked at Projects/Aurora 2 minutes
 * ago"; "Claude marked a task DONE just now") — a small in-memory ring buffer, session-only. Not
 * backed by `changes_since` (that requires a round trip this local, always-available badge
 * shouldn't depend on); it simply records what `./message-handler.ts` just saw happen on THIS
 * window's own socket, which is exactly what a human watching this specific screen cares about.
 */

export interface ActivityEntry {
  text: string;
  at: number;
}

const MAX_ENTRIES = 20;

export interface ActivityLog {
  list(): ActivityEntry[];
  record(text: string, at?: number): void;
  subscribe(fn: (entries: ActivityEntry[]) => void): () => void;
}

export function createActivityLog(): ActivityLog {
  let entries: ActivityEntry[] = [];
  const listeners = new Set<(entries: ActivityEntry[]) => void>();

  return {
    list: () => entries,
    record(text, at = Date.now()) {
      entries = [{ text, at }, ...entries].slice(0, MAX_ENTRIES);
      for (const fn of listeners) fn(entries);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** One process-wide log, shared by the socket wiring (`./socket.ts`'s caller) and `./ConsentBadge.tsx`. */
export const activityLog: ActivityLog = createActivityLog();

/** Turn a `command.run` request into the badge's activity-log line. Pure, so it's easy to test the
 * phrasing independent of the log's storage. */
export function describeCommandActivity(commandId: string, whenResult: string): string {
  if (whenResult === "skipped_when_false") return `Claude tried ${commandId} (not applicable here)`;
  if (whenResult === "unknown_command") return `Claude tried an unknown command (${commandId})`;
  if (whenResult === "not_permitted") return `Claude tried ${commandId} (not allowed remotely)`;
  if (commandId === "nav.openPage") return "Claude opened a page";
  if (commandId === "nav.revealBlock") return "Claude looked at a block";
  return `Claude ran ${commandId}`;
}
