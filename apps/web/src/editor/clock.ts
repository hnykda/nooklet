/**
 * The editor's local `Clock` (`types.ts`), backing every op `commands.ts`/`task.ts`/`paste.ts`
 * build. Seeded from the same device id the sync client already established
 * (`db/client.ts#initDb`, which is idempotent — calling it again just returns the cached promise,
 * per its own doc comment) so the editor never invents a second device identity. This is a plain,
 * read-only import of `initDb`, not a modification of anything under `src/db/`.
 */
import { Hlc } from "@nooklet/core";
import { initDb } from "../db/client.js";
import type { Clock } from "./types.js";

let clockPromise: Promise<Clock> | undefined;

/** Resolves once the DB worker has reported (or created) this device's id. Safe to call from
 * multiple components; the underlying `Hlc` instance is a singleton for the tab. */
export function getClock(): Promise<Clock> {
  if (!clockPromise) {
    clockPromise = initDb().then(({ deviceId }) => {
      const hlc = new Hlc(deviceId);
      return {
        next: () => hlc.next(),
        device: deviceId,
        receive: (remote) => {
          // A remote clock more than the allowed drift ahead throws; this clock then stays where it
          // is, and that one write loses last-writer-wins as it would have anyway.
          try {
            hlc.receive(remote);
          } catch {}
        },
      } satisfies Clock;
    });
  }
  return clockPromise;
}
