import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same knob and the same per-port file as `global-setup.ts`.
const PORT = Number(process.env.NOOKLET_E2E_PORT ?? 6188);
const STATE = join(tmpdir(), `nooklet-e2e-state-${PORT}.json`);

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE)) return;
  const { pid, dataDir } = JSON.parse(readFileSync(STATE, "utf8")) as {
    pid: number;
    dataDir: string;
  };
  try {
    // `serve` is spawned detached, so it leads its own process group; the negative pid kills the
    // group (pnpm → tsx → node) rather than orphaning the actual server.
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(STATE, { force: true });
}
