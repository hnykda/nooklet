import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { formatServeBanner, lanAddresses } from "./serve-banner.js";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}
function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

// The shape of a Mac on Wi-Fi with Tailscale up.
const interfaces = {
  lo0: [v4("127.0.0.1", true)],
  en0: [v6("fe80::1"), v4("192.168.1.5")],
  utun4: [v4("100.101.102.103")],
  bridge100: [v4("192.168.139.3")], // a VM host-only network: unreachable from a phone
};

const base = { dataDir: "/d", port: 6100, webClientDir: undefined, interfaces };

describe("lanAddresses", () => {
  it("keeps non-internal IPv4 only, with the interface name, skipping VM/container bridges", () => {
    expect(lanAddresses(interfaces)).toEqual([
      { address: "192.168.1.5", iface: "en0" },
      { address: "100.101.102.103", iface: "utun4" },
    ]);
  });
});

describe("formatServeBanner (B-604)", () => {
  it("bound to 0.0.0.0, never prints 0.0.0.0 as an address and lists the LAN addresses", () => {
    const { stdout } = formatServeBanner({ ...base, host: "0.0.0.0", allowedHosts: undefined });
    expect(stdout).not.toContain("0.0.0.0");
    expect(stdout).toContain("http://192.168.1.5:6100");
    expect(stdout).toContain("http://100.101.102.103:6100");
    expect(stdout).not.toContain("127.0.0.1:6100   lo0");
  });

  it("names the --allow-host the listed addresses still need", () => {
    const { stdout, stderr } = formatServeBanner({
      ...base,
      host: "0.0.0.0",
      allowedHosts: ["192.168.1.5"],
    });
    expect(stdout).toMatch(/http:\/\/192\.168\.1\.5:6100 {3}en0\n/); // allowed: no 403 note
    expect(stdout).toMatch(/100\.101\.102\.103:6100 {3}utun4 {3}\(403/);
    expect(stderr).toContain("--allow-host 192.168.1.5,100.101.102.103");
  });

  it("says nothing about --allow-host once every listed address is allowed", () => {
    const { stderr } = formatServeBanner({
      ...base,
      host: "0.0.0.0",
      allowedHosts: ["192.168.1.5", "100.101.102.103"],
    });
    expect(stderr).toBe("");
  });

  it("loopback bind: no LAN section, no warning", () => {
    const out = formatServeBanner({ ...base, host: "127.0.0.1", allowedHosts: undefined });
    expect(out.stdout).not.toContain("other devices");
    expect(out.stderr).toBe("");
  });

  it("bound to one specific address: shows that address, and reminds when it is not allowed", () => {
    const out = formatServeBanner({ ...base, host: "192.168.1.5", allowedHosts: undefined });
    expect(out.stdout).toContain("http://192.168.1.5:6100/graphs");
    expect(out.stderr).toContain("--allow-host 192.168.1.5");
  });

  it("wildcard with no network at all still tells you so", () => {
    const out = formatServeBanner({
      ...base,
      interfaces: { lo0: [v4("127.0.0.1", true)] },
      host: "0.0.0.0",
      allowedHosts: undefined,
    });
    expect(out.stdout).toContain("no LAN address found");
    expect(out.stderr).toContain("ONLY requests addressed to");
  });
});
