/**
 * R67 conflict detection: informational only (never blocking — R12's resolution walk still
 * resolves ties deterministically at dispatch time regardless of what this reports).
 */
import type { KeymapConflict, ResolvedBinding, WhenNode } from "../types.js";
import { areProvablyDisjoint, compileWhen } from "../when/index.js";

export function detectConflicts(bindings: readonly ResolvedBinding[]): KeymapConflict[] {
  const byKey = new Map<string, ResolvedBinding[]>();
  for (const b of bindings) {
    const list = byKey.get(b.key);
    if (list) list.push(b);
    else byKey.set(b.key, [b]);
  }

  const conflicts: KeymapConflict[] = [];

  for (const [key, rows] of byKey) {
    // A command with several rows on the same key (e.g. a base default plus a user addition) is
    // reachable whenever ANY of its rows' `when` holds — combine them with OR before comparing
    // against other commands sharing the key.
    const byCommand = new Map<string, WhenNode>();
    for (const row of rows) {
      const node = compileWhen(row.when ?? "true");
      const existing = byCommand.get(row.command);
      byCommand.set(row.command, existing ? { t: "or", left: existing, right: node } : node);
    }

    const commandIds = [...byCommand.keys()];
    if (commandIds.length < 2) continue;

    const conflicting = new Set<string>();
    for (let i = 0; i < commandIds.length; i++) {
      for (let j = i + 1; j < commandIds.length; j++) {
        const a = commandIds[i] as string;
        const b = commandIds[j] as string;
        const nodeA = byCommand.get(a) as WhenNode;
        const nodeB = byCommand.get(b) as WhenNode;
        if (!areProvablyDisjoint(nodeA, nodeB)) {
          conflicting.add(a);
          conflicting.add(b);
        }
      }
    }

    if (conflicting.size > 0) {
      conflicts.push({ key, commands: [...conflicting].sort() });
    }
  }

  return conflicts.sort((a, b) => a.key.localeCompare(b.key));
}
