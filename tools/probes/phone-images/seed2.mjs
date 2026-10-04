// Uploads a file to the scratch server and appends it as a block on today's journal.
import { readFileSync } from "node:fs";

const [, , file, mime] = process.argv;
const base = "http://127.0.0.1:6481/g/default";
const { token } = await (await fetch(`${base}/api/session`)).json();
const call = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
const up = await call("asset.upload", {
  filename: file.split("/").pop(),
  mime_type: mime,
  data_base64: readFileSync(file).toString("base64"),
});
await call("page.append", { page: "2026-10-04", markdown: `- ${up.markdown}` });
console.log(up.markdown);
