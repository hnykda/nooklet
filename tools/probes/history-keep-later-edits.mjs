// B-251 on real data: does a History-style restore walk (batch.undo with keep_later_edits and
// ignore_batches) leave a later edit on ANOTHER page alone after a graph-wide replace + its undo?
//
// Run against a server on a COPY of a real graph (never ~/.nooklet/default itself):
//   mkdir -p $SCRATCH/graph && sqlite3 ~/.nooklet/default/graph.sqlite ".backup '$SCRATCH/graph/graph.sqlite'"
//   nohup pnpm nooklet serve --data $SCRATCH/graph --port 6461 > $SCRATCH/server.log 2>&1 &
//   node tools/probes/history-keep-later-edits.mjs http://127.0.0.1:6461 Alex
//
// Prints what the walk did and exits non-zero if the later edit was lost or the restored page
// did not come back. The word should occur on many pages (the QA run used "Alex": 835 blocks).

const base = process.argv[2] ?? "http://127.0.0.1:6461";
const word = process.argv[3] ?? "Alex";

const session = await (await fetch(`${base}/api/session`)).json();
async function op(name, body) {
  const res = await fetch(`${base}/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${name} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function blockContent(id) {
  return (await op("block.read", { id, format: "json" })).block?.content;
}

const replace = await op("graph.replace", {
  query: word,
  replacement: `${word}QA`,
  case_sensitive: true,
  limit: 500,
});
console.log("replace:", replace.blocks_matched, "blocks, batch", replace.batch_id);
const undoReplace = await op("batch.undo", { batch_id: replace.batch_id });
console.log("undo of replace: batch", undoReplace.batch_id);

// Two matches on different pages: X gets a later edit, Y is the page restored from History.
const matches = replace.matches;
const x = matches[0];
const y = matches.find((m) => m.page !== x.page);
const yOriginal = await blockContent(y.block_id);
await op("block.update", { id: x.block_id, content: "QA later edit, must survive" });
console.log("later edit on", JSON.stringify(x.page), "block", x.block_id);

const history = await op("page.history", { page: y.page, limit: 25 });
const ids = history.batches.map((b) => b.batch_id);
const target = ids.indexOf(replace.batch_id) + 1; // the version right before the replace
const walk = ids.slice(0, target);
console.log("restoring", JSON.stringify(y.page), "- walk of", walk.length, "batches");
const ignore = [...walk];
let kept = 0;
for (const batchId of walk) {
  const step = await op("batch.undo", {
    batch_id: batchId,
    keep_later_edits: true,
    ignore_batches: ignore,
  });
  if (step.batch_id) ignore.push(step.batch_id);
  kept += step.kept.length;
}

const xAfter = await blockContent(x.block_id);
const yAfter = await blockContent(y.block_id);
console.log("kept reports:", kept);
console.log("X after:", JSON.stringify(xAfter));
console.log("Y after equals original:", yAfter === yOriginal);
const ok = xAfter === "QA later edit, must survive" && yAfter === yOriginal;
console.log(ok ? "OK" : "FAILED");
process.exit(ok ? 0 : 1);
