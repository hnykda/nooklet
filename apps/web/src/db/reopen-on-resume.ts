/**
 * B (docs/proposals/004-capacitor-storage-durability.md): one reopen-and-retry after a query fails
 * following a `resume` lifecycle event — the shape PowerSync's own report (research/08-mobile.md
 * §1.3, cited in `platform/capacitor.ts`) predicts for OPFS `opfs-sahpool` under Capacitor: the
 * access handle closes when the app backgrounds, so the next query after resume fails.
 *
 * Deliberately NOT "retry on any error" — that would mask a real bug as "must be the known
 * OPFS-closes-on-background failure." The retry only arms on an actual `resume` event and
 * disarms itself the moment either a retry is attempted or a call succeeds without needing one, so
 * a second consecutive failure right after a resume-triggered reopen propagates as a real error
 * rather than looping. Generic over the wrapped value so it can be unit-tested with a fake rather
 * than a real OPFS/Worker — see `reopen-on-resume.test.ts`.
 */

export interface ResumeRetry<T> {
  /** Call after a `resume` lifecycle event, before any query that might hit the stale connection. */
  onResume(): void;
  /** Run `fn` against the current value. On failure, if a `resume` has fired since the last retry
   * (or since start), reopen once via the `reopen` function this was constructed with and retry
   * `fn` against the fresh value — which becomes current for every later call too. A failure with
   * no armed resume, or a second failure right after reopening, propagates normally. */
  call<R>(fn: (value: T) => R): Promise<R>;
  /** The current value, for callers that need it without going through `call` (e.g. to read a
   * field rather than invoke a method that can throw). Resolves once, or after the latest reopen. */
  current(): Promise<T>;
}

export function createResumeRetry<T>(
  open: () => Promise<T>,
  reopen: () => Promise<T>,
): ResumeRetry<T> {
  let armed = false;
  let currentPromise = open();

  return {
    onResume(): void {
      armed = true;
    },
    current(): Promise<T> {
      return currentPromise;
    },
    async call<R>(fn: (value: T) => R): Promise<R> {
      const value = await currentPromise;
      try {
        // `await` (not a bare `return fn(value)`) so a rejected Promise `fn` returns is caught
        // here too, not just a synchronous throw — `forceSync()`/`notifyLifecycle()` are genuinely
        // async, unlike the query methods, which throw synchronously the moment the driver does.
        const result = await fn(value);
        // B-574: a call that succeeds without needing a retry disarms too, same as a retry attempt
        // — otherwise `armed` stays true until *some* call eventually fails, which could be an
        // unrelated bug far later getting a spurious reopen instead of this covering only the one
        // call right after resume.
        armed = false;
        return result;
      } catch (err) {
        if (!armed) throw err;
        armed = false;
        currentPromise = reopen();
        const fresh = await currentPromise;
        return await fn(fresh);
      }
    },
  };
}
