/**
 * A small in-process rate limiter, for the one route that needs no credential and checks a secret:
 * `POST /api/v1/pairing.redeem` (`../auth/pairing-codes.ts`). nooklet has no other rate limiting
 * (the security guide says to limit at the proxy), but an unauthenticated guessing endpoint should
 * not depend on the deployment remembering that.
 *
 * Sliding window of attempt timestamps, per peer address and in total. The peer is the TCP socket's
 * address, never a forwarding header (a client can write any `X-Forwarded-For` it likes). Behind a
 * same-machine proxy every client shares the proxy's address, so the per-peer limit turns into a
 * second global one; that only ever makes it stricter.
 *
 * In memory, per process: a restart forgets the counts. Enough for its job, which is keeping a
 * 128-bit code space from being hammered, not accounting.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  perPeer: number;
  total: number;
  now?: () => number;
}

export interface RateLimiter {
  /** Records an attempt for `peer`; false if it is over either limit (and not recorded). */
  allow(peer: string): { ok: true } | { ok: false; retryAfterMs: number };
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const byPeer = new Map<string, number[]>();
  let all: number[] = [];
  const prune = (list: number[], t: number): number[] => {
    const cut = t - opts.windowMs;
    let i = 0;
    while (i < list.length && (list[i] as number) <= cut) i++;
    return i === 0 ? list : list.slice(i);
  };
  return {
    allow(peer) {
      const t = now();
      all = prune(all, t);
      const mine = prune(byPeer.get(peer) ?? [], t);
      if (mine.length === 0) byPeer.delete(peer);
      else byPeer.set(peer, mine);
      // Bound the map itself: an attacker rotating addresses must not grow it without limit.
      if (byPeer.size > 10_000) byPeer.clear();
      const full = mine.length >= opts.perPeer ? mine : all.length >= opts.total ? all : undefined;
      if (full) return { ok: false, retryAfterMs: (full[0] as number) + opts.windowMs - t };
      mine.push(t);
      byPeer.set(peer, mine);
      all.push(t);
      return { ok: true };
    },
  };
}

function peerOf(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // in-process `app.request()` in tests
  }
}

/** 429 with `Retry-After` once a peer (or everyone together) is over the limit. */
export function rateLimit(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const verdict = limiter.allow(peerOf(c));
    if (!verdict.ok) {
      c.header("retry-after", String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: "too many pairing attempts; wait a minute and try again",
          },
        },
        429,
      );
    }
    return next();
  };
}

/** The pairing endpoint's limits. A real pairing is one request; a typo'd retry or two is fine. */
export const PAIRING_RATE_LIMIT: Omit<RateLimitOptions, "now"> = {
  windowMs: 60_000,
  perPeer: 10,
  total: 60,
};
