// B-713 probe: `DELETE /graphs/<id>` against a real `nooklet serve` with the live mirror ON (the
// unit and CLI tests run with --no-mirror). Checks that the retired folder carries the markdown
// mirror of a page written just before the retire, that the graph 404s afterwards, and that the
// server logs no error while closing it. Throwaway data dir; port 6562.
//
//   node tools/probes/graph-retire-live-mirror.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "server");
const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-probe-"));
const port = 6562;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(
  join(pkg, "node_modules", ".bin", "tsx"),
  ["src/cli.ts", "serve", "--data", dir, "--port", String(port), "--no-web"],
  { cwd: pkg, env: { ...process.env, NODE_ENV: "production", NOOKLET_DATA: dir } },
);
let log = "";
proc.stderr.on("data", (d) => {
  log += d;
});
try {
  for (let i = 0; i < 100 && !existsSync(join(dir, "serve.pid")); i++) await sleep(100);
  const root = readFileSync(join(dir, "root.token"), "utf8").trim();
  const rootAuth = { authorization: `Bearer ${root}`, "content-type": "application/json" };
  const created = await (
    await fetch(`${base}/graphs`, { method: "POST", headers: rootAuth, body: '{"id":"work"}' })
  ).json();
  const auth = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  const page = await fetch(`${base}/g/work/api/v1/page.create`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Mirror Probe", markdown: "- hello" }),
  });
  console.log("page.create", page.status);
  // Inside the mirror's 500 ms debounce: only the retire's own flush can write this page.
  const del = await fetch(`${base}/graphs/work`, { method: "DELETE", headers: rootAuth });
  const body = await del.json();
  console.log("DELETE", del.status, body);
  console.log("healthz after", (await fetch(`${base}/g/work/healthz`)).status);
  const pages = join(dir, body.path, "pages");
  console.log("retired mirror pages:", existsSync(pages) ? readdirSync(pages) : "(none)");
  await sleep(1000);
  console.log(
    "server stderr errors:",
    log.split("\n").filter((l) => /error|closing/i.test(l)),
  );
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  console.log("serve.pid after stop:", existsSync(join(dir, "serve.pid")));
}
