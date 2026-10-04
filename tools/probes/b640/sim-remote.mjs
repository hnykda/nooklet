// B-640 probe: the same remote-edit sequence the test graph's op log shows, driven through the API
// at a page open in the iOS Simulator's Safari (real iOS WebKit), with a simulator screenshot
// after each step. Usage: node sim-remote.mjs <baseURL> <simUDID> <outdir> [scenario]
import { execFileSync } from "node:child_process";

const [base, udid, out, scenario = "mac"] = process.argv.slice(2);
const { token } = await (await fetch(`${base}/api/session`)).json();
const api = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (label) => {
  await sleep(2500);
  execFileSync("xcrun", [
    "simctl",
    "io",
    udid,
    "screenshot",
    `${out}/sim-${scenario}-${label}.png`,
  ]);
  console.log("shot", label);
};
const name = `sim ${scenario} ${Date.now() % 100000}`;
const ids = async () =>
  [...(await api("page.read", { page: name })).text.matchAll(/^(\s*)- ?(.*?) ?\^(\w{14})$/gm)].map(
    (m) => ({ depth: m[1].length / 2, text: m[2], id: m[3] }),
  );
await api("page.create", { name, markdown: "- One\n- Three\n  - Nested\n  - Desktop" });
execFileSync("xcrun", ["simctl", "openurl", udid, `${base}/page/${encodeURIComponent(name)}`]);
await sleep(6000);
await shot("0-initial");
const by = async (t) => (await ids()).find((b) => b.text === t);
// Mac: Enter after "Desktop" (an empty sibling), then Shift+Tab (top level).
await api("block.insert", { ref: (await by("Desktop")).id, position: "after", markdown: "- x" });
const x = await by("x");
await api("block.update", { id: x.id, content: "" });
await shot("1-empty-child");
await api("block.move", { id: x.id, page: name });
await shot("2-empty-top");
// Phone: types into it.
await api("block.update", { id: x.id, content: "Ok these ones are added on " });
await api("block.update", {
  id: x.id,
  content: "Ok these ones are added on mobile in airplane mode",
});
await shot("3-text");
// Phone: Enter (new top-level row), Tab (under "Ok"), types.
await api("block.insert", { ref: x.id, position: "after", markdown: "- y" });
const y = await by("y");
await api("block.update", { id: y.id, content: "" });
await api("block.move", { id: y.id, ref: x.id, position: "child_first" });
await api("block.update", { id: y.id, content: "Nothing" });
await shot("4-child");
await api("block.insert", { ref: y.id, position: "after", markdown: "- And that" });
await shot("5-child2");
