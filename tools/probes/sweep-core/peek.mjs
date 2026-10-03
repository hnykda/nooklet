// Sweep helper: print a page's block tree as the API returns it. Usage: node .../peek.mjs <page>
import { api } from "./lib.mjs";

const r = await api("page.read", { page: process.argv[2], format: "json" });
console.log(JSON.stringify(r.tree.slice(0, Number(process.argv[3] ?? 4)), null, 1).slice(0, 3000));
