// Probe (2026-09-13, docs/BUGS.md B-138): with the options `apps/web/src/editor/render/math.ts`
// passes, can hostile TeX get anything executable or loadable into KaTeX's HTML (which the renderer
// sets as innerHTML), and how large can a user-given size make a box?
//
// Parses KaTeX's output with jsdom and flags on* attributes, href/src, style with url()/position/
// expression, and any em length over 1000 (after maxSize: over 25).
//
// Run: node tools/probes/katex-output-attributes.cjs
//
// Result, katex 0.18.7, 2026-09-13:
//   \href, \url, \htmlClass, \htmlId, \htmlStyle, \htmlData, \includegraphics, hostile \color /
//   \textcolor / \colorbox, raw <img>/<script> text: no on*/href/src attributes, no url() styles —
//   `trust: false` turns them into error text.
//   Without maxSize: \rule{99999em}{99999em} -> border widths 99999em, \raisebox{99999em} ->
//   height 99999.43em, \hspace{99999em} -> 99999em. With maxSize: 20 all three are capped at 20em.
//   \kern-99999em is NOT capped by maxSize (margin-right: -99999em either way).
const path = require("node:path");
const web = path.join(__dirname, "../../apps/web/package.json");
const katex = require(require.resolve("katex", { paths: [path.dirname(web)] }));
const { JSDOM } = require(require.resolve("jsdom", { paths: [path.dirname(web)] }));

const base = { throwOnError: false, displayMode: false, trust: false, strict: "ignore" };
const inputs = [
  String.raw`\href{javascript:alert(1)}{x}`,
  String.raw`\url{javascript:alert(1)}`,
  String.raw`\htmlClass{x" onmouseover="alert(1)}{y}`,
  String.raw`\htmlId{x}{y}`,
  String.raw`\htmlStyle{background:url(//evil)}{y}`,
  String.raw`\htmlData{onclick=alert(1)}{y}`,
  String.raw`\includegraphics{https://evil/x.png}`,
  String.raw`\color{red" onmouseover="alert(1)}{x}`,
  String.raw`\textcolor{#fff;background:url(//evil)}{x}`,
  "<img src=x onerror=alert(1)>",
  String.raw`\text{<script>alert(1)</script>}`,
  String.raw`\colorbox{red;position:fixed}{x}`,
  String.raw`\rule{99999em}{99999em}`,
  String.raw`\raisebox{99999em}{x}`,
  String.raw`\hspace{99999em}`,
  String.raw`\kern-99999em x`,
];

for (const [label, opts, limit] of [
  ["no maxSize", base, 1000],
  ["maxSize: 20", { ...base, maxSize: 20 }, 25],
]) {
  console.log(`--- ${label}`);
  for (const tex of inputs) {
    const html = katex.renderToString(tex, opts);
    const doc = new JSDOM(`<body><span id=r>${html}</span></body>`).window.document;
    const flags = [];
    for (const el of doc.getElementById("r").querySelectorAll("*")) {
      for (const a of el.attributes) {
        if (/^on/i.test(a.name) || /href|src/i.test(a.name))
          flags.push(`${el.tagName}[${a.name}=${a.value}]`);
        if (a.name === "style") {
          if (/url\(|expression|position|javascript/i.test(a.value))
            flags.push(`${el.tagName}[style=${a.value}]`);
          for (const m of a.value.matchAll(/(-?[\d.]+)em/g)) {
            if (Math.abs(Number(m[1])) > limit) flags.push(`${el.tagName}[${m[0]}]`);
          }
        }
      }
    }
    console.log(flags.length ? "FLAG" : "ok  ", JSON.stringify(tex), flags.slice(0, 3).join(" "));
  }
}
