/**
 * The desktop app's graph menu, as data (proposal 005, ADR 032): the shell's list grouped the way
 * the menu shows it, and what was pasted into "Connect to a server". Pure, so the unit tests hold
 * every case without a shell.
 */
import {
  graphBaseUrl,
  PAIRING_CODE_RE,
  parsePairingLink,
  parseServerUrl,
} from "../data/connect-graph.js";
import { isPairPath, pairCodeFromHash } from "../data/pairing.js";
import { normalizeToken, tokenShapeProblem } from "../data/token-input.js";
import type { DesktopGraph } from "../platform/desktop-shell.js";

export interface ServerGroup {
  /** `host[:port]`, the heading the graphs on one server share. */
  host: string;
  graphs: DesktopGraph[];
}

export interface GroupedGraphs {
  mac: DesktopGraph[];
  servers: ServerGroup[];
}

export function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** "On this Mac" in the shell's order (oldest first), then "On servers", one group per host. */
export function groupDesktopGraphs(graphs: readonly DesktopGraph[]): GroupedGraphs {
  const servers: ServerGroup[] = [];
  for (const graph of graphs) {
    if (graph.place !== "server") continue;
    const host = hostOf(graph.address);
    const group = servers.find((g) => g.host === host);
    if (group) group.graphs.push(graph);
    else servers.push({ host, graphs: [graph] });
  }
  return { mac: graphs.filter((g) => g.place === "mac"), servers };
}

/** The line under a server graph's name: its path on that server (`/g/work`), since the host is
 * already the group's heading. */
export function serverGraphPath(address: string): string {
  try {
    return new URL(address).pathname;
  } catch {
    return address;
  }
}

/** What the credential field held, once read. */
export type Credential =
  | { kind: "token"; token: string }
  /** A one-time pairing code (ADR 029), from a pasted pairing link or QR page address, which also
   * names the server. */
  | { kind: "code"; code: string; address?: string }
  | { kind: "error"; error: string };

/**
 * The field takes a device token, or anything a pairing gives you: a `nooklet://connect?…` link
 * (with a code or a token), the pairing page's own address (`https://…/g/<graph>/pair#code=…`),
 * or the bare code (`nkp_…`).
 * A link brings its server address with it, which then fills the address field.
 */
export function readCredential(raw: string): Credential {
  const text = raw.trim();
  if (text.startsWith("nooklet:")) {
    const link = parsePairingLink(text);
    if (link === undefined)
      return { kind: "error", error: "That nooklet:// link is not a pairing link." };
    if ("error" in link) return { kind: "error", error: link.error };
    if (link.code) return { kind: "code", code: link.code, address: graphBaseUrl(link.serverUrl) };
    return readToken(link.token ?? "");
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const code = pairCodeFromHash(url.hash);
      if (code && isPairPath(url.pathname)) {
        const address = `${url.origin}${url.pathname.replace(/\/pair\/?$/, "")}`;
        return { kind: "code", code, address };
      }
    } catch {
      // Not a URL after all: read as a token below, which names the problem.
    }
    return {
      kind: "error",
      error: "That's an address, not a token. Put the server's address in the field above.",
    };
  }
  if (PAIRING_CODE_RE.test(text)) return { kind: "code", code: text };
  return readToken(text);
}

function readToken(raw: string): Credential {
  // B-706: what was copied around the token (a sentence's `.`, backticks, a newline) is dropped, and
  // a token of the wrong shape is named before the server could only say "rejected".
  const token = normalizeToken(raw);
  const problem = tokenShapeProblem(token, "device");
  return problem ? { kind: "error", error: problem } : { kind: "token", token };
}

/** The address field, as the shell will be given it: checked as the web client checks it, with
 * no `/g/default` added (the shell needs to know whether a graph was named, for its error words). */
export function readAddress(raw: string): { address: string } | { error: string } {
  const parsed = parseServerUrl(raw);
  if ("error" in parsed) return parsed;
  try {
    const url = new URL(parsed.url);
    if (url.username || url.password) {
      return { error: "A server address can't contain a user name." };
    }
  } catch {
    return { error: "That doesn't look like a server address." };
  }
  return { address: parsed.url };
}

/**
 * B-786: whether the menu offers "Delete" on a graph. Only This Mac's graphs (a server graph is
 * removed, not deleted), never `default` (This Mac's main graph: the CLI, MCP and the launcher open
 * it), never the open one, never the last one on this Mac, and only on the bundled server's own
 * page with a shell that answers the request. The shell checks all of it again (`main.rs`).
 */
export function canDeleteMacGraph(
  graph: DesktopGraph,
  f: {
    shellCanDelete: boolean;
    onBundledServer: boolean;
    currentKey: string | undefined;
    macCount: number;
  },
): boolean {
  return (
    f.shellCanDelete &&
    f.onBundledServer &&
    graph.place === "mac" &&
    graph.id !== "default" &&
    graph.key !== f.currentKey &&
    f.macCount > 1
  );
}
