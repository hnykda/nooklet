// The Mac side of sim-driver.js: `GET /cmd` answers with the contents of $OUT/cmd ("setup" or
// "none"), `POST /dump` appends one JSON line to $OUT/dumps.jsonl and echoes it. Started by
// sim-run.sh; listens on 127.0.0.1 only.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const out = process.env.OUT;
const port = Number(process.env.PORT ?? 6491);
if (!out) throw new Error("OUT is required");

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "GET" && req.url === "/cmd") {
    let cmd = "none";
    try {
      cmd = readFileSync(`${out}/cmd`, "utf8").trim();
    } catch {}
    res.end(cmd);
    return;
  }
  if (req.method === "POST" && req.url === "/dump") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      appendFileSync(`${out}/dumps.jsonl`, `${body}\n`);
      // The tap is made once; the reload it causes must not look for the button again.
      if (body.includes('"label":"before-setup"')) writeFileSync(`${out}/cmd`, "none");
      console.log(body);
      res.end("ok");
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(port, "127.0.0.1", () => console.log(`sim-host on ${port}`));
