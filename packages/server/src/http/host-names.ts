/**
 * `Host` header names: which ones mean this machine, which ones the server accepts, and the 403
 * for the rest. Shared by `./app.ts`'s guard and `../mcp/server.ts`'s `/mcp` guard (B-616), on
 * its own so neither imports the other.
 */
import type { Context } from "hono";
import type { ServerConfig } from "../ops/registry.js";

/** The `Host` header's hostname, without port; IPv6 literals arrive bracketed. */
export function hostName(host: string | undefined): string {
  if (!host) return "";
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

/**
 * The 403 for a `Host` the server was not told about, from either guard (`./app.ts`'s, and the
 * `/mcp` one in `../mcp/server.ts`), so both name the fix the same way. Also says so on the
 * server's stderr, once per name: behind a proxy the person reading the terminal is the one who
 * can add `--allow-host`, and the browser that got the 403 may show nothing useful (B-616).
 */
const warnedHosts = new Set<string>();
export function rejectHost(c: Context, rawHost: string | undefined): Response {
  const name = hostName(rawHost) || "(missing)";
  const fix = `--allow-host ${name === "(missing)" ? "<hostname>" : name}`;
  if (!warnedHosts.has(name)) {
    warnedHosts.add(name);
    process.stderr.write(
      `nooklet: refused a request for Host "${name}" (403). If that is the name devices or a ` +
        `reverse proxy use, restart with ${fix}\n`,
    );
  }
  return c.json(
    {
      error: {
        code: "forbidden",
        message: `Host "${name}" is not allowed. Start the server with ${fix} to reach it by this name.`,
      },
    },
    403,
  );
}

/** The `Host` names a request may carry: loopback always, plus `--allow-host`. */
export function allowedHostNames(config: ServerConfig): Set<string> {
  return new Set([...LOOPBACK_NAMES, ...(config.allowedHosts ?? [])]);
}

/** The `Host` part of a request, without its port. */
export function requestHostName(c: Context): string {
  return hostName(c.req.header("host"));
}

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]", "::1"];

/** A bind address or `Host` name that means this machine. */
export function isLoopbackName(name: string): boolean {
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}
