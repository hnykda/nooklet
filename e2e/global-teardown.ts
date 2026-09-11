import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = join(tmpdir(), "nooklet-e2e-state.json");

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
