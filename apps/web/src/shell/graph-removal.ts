/**
 * B-712: what "remove this graph from this device" asks before it acts. It used to be one tap on a
 * trash icon and one on "Remove", even for a phone's local-only graph, whose copy on the device IS
 * the graph. Now the dialog says what is lost, and anything that can lose data needs `delete` typed:
 *
 * - **On this device** (no server): always typed. Nothing else holds it, and once out of the list
 *   nooklet has no way to open it again (the replica file is left behind, unreachable — follow-up
 *   logged in `docs/progress/graph-menu.md`). There is no whole-graph export in the client yet, so
 *   the dialog says so and points at the two ways to keep it: copy it to a server first ("Add a
 *   server for this graph"), or export pages one at a time.
 * - **On a server**: the server keeps it and other devices are unaffected. Plain confirm when this
 *   device knows it has nothing unsynced; typed when it has some (and says how many) or cannot
 *   tell (`data/pending-memo.ts`).
 *
 * The desktop app's menu has its own, simpler removal (`DesktopGraphMenu.tsx`): there only a server
 * graph can be removed, and its replica stays on the Mac.
 *
 * Pure, so every wording is unit-tested; `GraphSwitcher.tsx` shows it with `app/confirm-dialog`.
 */
import type { ConfirmOptions } from "../app/confirm-dialog.js";

export const REMOVE_CONFIRM_WORD = "delete";

export interface RemovalFacts {
  name: string;
  place: "device" | "server";
  /** Where the server is, for the server wording. */
  host?: string;
  /** Changes not on the server; `undefined` = unknown. Ignored for "device". */
  pending: number | undefined;
}

function changes(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

export function removalDialog(f: RemovalFacts): ConfirmOptions {
  const quoted = `“${f.name}”`;
  if (f.place === "device") {
    return {
      title: `Delete ${quoted} from this device?`,
      warning: `This device holds the only copy of ${quoted}. Removing it cannot be undone.`,
      message: [
        "It is not on any server and no other device has it. Once removed, nooklet cannot open it again.",
        "Export first: nooklet cannot export a whole graph yet. To keep it, open it and use “Add a server for this graph” to copy it to a server, or export pages one at a time with Export as markdown.",
      ],
      confirmLabel: "Delete forever",
      destructive: true,
      typeToConfirm: REMOVE_CONFIRM_WORD,
    };
  }

  const lost =
    f.pending === undefined
      ? `This device cannot tell whether it has changes to ${quoted} that never reached the server. Any it has are lost.`
      : f.pending > 0
        ? `${changes(f.pending)} made on this device ${f.pending === 1 ? "has" : "have"} not reached the server yet and will be lost.`
        : undefined;

  const server = f.host ? `The server at ${f.host}` : "Its server";
  return {
    title: `Remove ${quoted} from this device?`,
    warning: lost,
    message: [
      `${server} keeps ${quoted}, and other devices are unaffected. You can add it here again later.`,
    ],
    confirmLabel: "Remove",
    destructive: true,
    typeToConfirm: lost ? REMOVE_CONFIRM_WORD : undefined,
  };
}
