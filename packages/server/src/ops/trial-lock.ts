/**
 * A single process-wide async mutex serializing every WRITE op's handler execution (`registry.ts`'s
 * `runOpHandler`, used by both the HTTP and MCP mounts).
 *
 * WHY: a `dry_run`/`batch` trial (`./dry-run.ts`, `./batch.ts`) now holds a `Savepoint` open on the
 * server's one shared SQLite connection across several `await`s, running real handler logic —
 * including real `ctx.applyOps` calls — before deciding to `release()` or `rollback()`. If a
 * second request's write interleaved during one of those `await`s, its writes would land on the
 * SAME connection, inside the trial's still-open transaction, and be silently rolled back with it
 * (or, for a successful trial, committed as part of a batch it was never meant to join). Wrapping
 * every write op's ENTIRE handler execution — not each individual `applyOps` call — in one mutex
 * means a trial's whole span (open savepoint -> run every step -> release/rollback) runs
 * uninterrupted, and a handler that calls `ctx.applyOps` several times never re-enters the lock
 * (it is acquired once, at the top, for the whole handler). nooklet is a single-user local server,
 * not a high-concurrency service, so a simple FIFO queue — no fairness/priority/timeout logic — is
 * plenty.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const ticket = this.tail.then(() => fn());
    // Swallow rejection here only so `tail` (which nothing ever reads besides ordering) doesn't
    // become a rejected promise `run()` never awaited — the real error still propagates below.
    this.tail = ticket.then(
      () => undefined,
      () => undefined,
    );
    return ticket;
  }
}

/** The one server-wide instance every write op's handler runs behind (see class doc above). */
export const writeLock = new AsyncMutex();
