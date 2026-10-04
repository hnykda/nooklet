/**
 * What `nooklet serve` prints once it is listening. On its own (pure, `os.networkInterfaces()`
 * passed in) so it can be tested without binding anything.
 *
 * B-604: bound to `0.0.0.0` it used to print `http://0.0.0.0:6100/...` as the address to use, which
 * no phone can reach. A wildcard bind now lists the machine's LAN addresses instead, and says
 * which of them `--allow-host` still has to name: with a non-loopback bind, the Host guard in
 * `http/app.ts` answers 403 to any name not on that list, so an address printed here without the
 * reminder would fail on first use.
 */
import type { NetworkInterfaceInfo } from "node:os";
import { isLoopbackName } from "./http/host-names.js";

export interface LanAddress {
  address: string;
  iface: string;
}

/** Host-only virtual networks (Docker, VM hypervisors, macOS Internet Sharing/VM bridges). They are
 * non-internal, but no phone can reach them; on the dev Mac they outnumbered the real one 2 to 1. */
const VIRTUAL_IFACE = /^(bridge|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali)/;

/** Non-internal IPv4 addresses, in interface order. IPv6 is left out on purpose: link-local
 * `fe80::` needs a zone id a phone cannot use, and a bracketed literal is not what anyone types.
 * Tailscale's `utun`/`tailscale0` is kept: another tailnet device can use it. */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE.test(iface)) continue;
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push({ address: info.address, iface });
    }
  }
  return out;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export interface ServeBannerInput {
  dataDir: string;
  /** The bind address (`--host`). */
  host: string;
  port: number;
  allowedHosts: readonly string[] | undefined;
  webClientDir: string | undefined;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** `NOOKLET_VERSION` (B-696), so a log says which build was running. */
  version?: string;
}

export function formatServeBanner(input: ServeBannerInput): { stdout: string; stderr: string } {
  const { host, port } = input;
  const allowed = new Set(input.allowedHosts ?? []);
  const wildcard = WILDCARD_HOSTS.has(host);
  const exposed = !isLoopbackName(host);
  const lan = wildcard ? lanAddresses(input.interfaces) : [];

  // The name the endpoint list below uses: something this machine can actually open.
  const shown = exposed && !wildcard ? host : "127.0.0.1";
  const base = `http://${shown}:${port}`;
  let stdout =
    `nooklet${input.version ? ` ${input.version}` : ""} serving ${input.dataDir}\n` +
    `  graphs ${base}/graphs\n` +
    `  http   ${base}/g/<id>/api/v1\n` +
    `  mcp    ${base}/g/<id>/mcp\n` +
    `  spec   ${base}/g/<id>/openapi.json\n` +
    `  sync   ws://${shown}:${port}/g/<id>/sync/live\n` +
    `  live   ws://${shown}:${port}/g/<id>/ui/live\n` +
    (input.webClientDir
      ? `  app    ${base}/g/<id>/  (serving ${input.webClientDir})\n`
      : `  app    not served — build it (pnpm --filter @nooklet/web build) or pass --web <dir>\n`);

  if (wildcard) {
    if (lan.length === 0) {
      stdout += `  other devices: no LAN address found on this machine (not on a network?)\n`;
    } else {
      stdout += `  other devices — the server address to type in the app:\n`;
      for (const { address, iface } of lan) {
        const note = allowed.has(address) ? "" : "   (403 until allowed, see below)";
        stdout += `    http://${address}:${port}   ${iface}${note}\n`;
      }
    }
  } else if (exposed) {
    stdout += `  other devices — the server address to type in the app: http://${host}:${port}\n`;
  }

  let stderr = "";
  if (exposed) {
    // Names a request may need that the Host guard would refuse.
    const missing = wildcard
      ? lan.map((l) => l.address).filter((a) => !allowed.has(a))
      : allowed.has(host)
        ? []
        : [host];
    if (missing.length > 0) {
      const suggestion = [...allowed, ...missing].join(",");
      stderr +=
        `nooklet: not in --allow-host, so a device using it gets 403: ${missing.join(", ")}\n` +
        `  To allow it, restart with:  --allow-host ${suggestion}\n` +
        `  (add a tailnet or .local name to that list too if devices use one).\n`;
    } else if (allowed.size === 0) {
      stderr +=
        `nooklet: bound to ${host} with no --allow-host, so ONLY requests addressed to\n` +
        `  localhost are accepted. Pass e.g. --allow-host my-machine.local to allow a name.\n`;
    }
  }
  return { stdout, stderr };
}
