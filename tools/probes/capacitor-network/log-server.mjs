// Collects the capacitor-network probe's results (each line arrives as `GET /log?<line>`, sent
// no-cors so it is delivered even when CORS would hide the response). Usage:
//   node log-server.mjs <port> <outfile>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port = "6312", outFile = "probe-results.txt"] = process.argv.slice(2);
createServer((req, res) => {
  const q = req.url?.split("?")[1];
  if (req.url?.startsWith("/log") && q) appendFileSync(outFile, `${decodeURIComponent(q)}\n`);
  res.end("ok");
}).listen(Number(port), "0.0.0.0");
