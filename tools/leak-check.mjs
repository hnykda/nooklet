#!/usr/bin/env node
// Public-repo leak guard. Fails (exit 1) when text about to be committed or pushed contains a
// secret, a piece of personal infrastructure, or — with the owner's private denylist — a string
// from the owner's real notes.
//
//   node tools/leak-check.mjs --staged          pre-commit: the staged version of staged files
//   node tools/leak-check.mjs --tree            every tracked file at HEAD's working tree
//   node tools/leak-check.mjs --range A..B      lines ADDED by the commits in A..B (CI: base..head)
//
// The shape rules mirror .gitleaks.toml (keep them in sync); gitleaks, when installed, is run as
// well and catches generic cloud keys this script does not try to. Neither file may contain the
// real strings it protects. Literal personal terms (people, page names, the tailnet) live in a
// PRIVATE denylist outside the repo: $NOOKLET_LEAK_DENYLIST, else ~/.config/nooklet/leak-denylist.txt.
// One entry per line; `regex:<pattern>` or a literal; a `git filter-repo --replace-text` file works
// as-is (only the part before `==>` is used). Missing denylist = shape rules only (CI's case).
//
// A line that must keep a flagged example can end with the marker `leak-check: allow`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RULES = [
  { id: "nooklet-token", re: /\bnk(?:root|b)?_[0-9a-f]{32,}\b/ },
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?!\s*test)/ },
  { id: "age-secret-key", re: /AGE-SECRET-KEY-1[0-9A-Z]{58}/ },
  { id: "sops-plaintext-marker", re: /\bsops_(?:age|pgp)__list_\d+__map_recipient\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: "home-path",
    re: /(?:\/Users|\/home)\/[A-Za-z][A-Za-z0-9._-]+\//,
    allow: /\/(?:Users|home)\/(?:me|you|user|runner|example|<[^>]+>)\//,
  },
  {
    id: "tailnet-host",
    re: /\b[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.ts\.net\b/,
    allow: /\.(?:example|tailnet|tailnet-name|your-tailnet)\.ts\.net/,
  },
  {
    id: "tailscale-ip",
    re: /\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/,
    allow: /100\.101\.102\.103|100\.64\.0\.[0-9]+/,
  },
  {
    id: "lan-ip",
    re: /\b(?:192\.168|10\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}\b/,
    allow: /192\.168\.1\.[56]\b|192\.168\.139\.3\b|192\.168\.0\.0|10\.0\.0\.[0-9]+/,
  },
  {
    id: "personal-email",
    re: /\b[A-Za-z0-9._%+-]+@(?:gmail|googlemail|icloud|me|outlook|hotmail|proton|protonmail|seznam|email)\.(?:com|cz|me)\b/,
  },
];

const SKIP = [
  /^pnpm-lock\.yaml$/,
  /^apps\/desktop\/src-tauri\/gen\//,
  /\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?)$/,
  /^\.gitleaks\.toml$/,
  /^tools\/leak-check\.mjs$/,
];

function loadDenylist() {
  const path =
    process.env.NOOKLET_LEAK_DENYLIST ?? join(homedir(), ".config/nooklet/leak-denylist.txt");
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split("==>")[0].trim();
    if (!line || line.startsWith("#")) continue;
    // filter-repo regexes are Python; the subset used there (\b, \s, re.escape's identity escapes
    // like `\~`) is valid JS too — but only WITHOUT the `u` flag, which rejects identity escapes.
    const re = line.startsWith("regex:")
      ? new RegExp(line.slice(6))
      : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    out.push({ id: "private-denylist", re, hidden: true });
  }
  return out;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });

/** @returns {Array<{file: string, line: number, text: string}>} */
function* candidates(mode, arg) {
  if (mode === "--range") {
    // Added lines only, so a commit that REMOVES a leak is not itself flagged.
    let file = "";
    let line = 0;
    for (const l of git("log", "-p", "--no-color", "--unified=0", "--format=", arg).split("\n")) {
      if (l.startsWith("+++ ")) file = l.slice(6);
      else if (l.startsWith("@@")) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1;
      else if (l.startsWith("+")) {
        line++;
        yield { file, line, text: l.slice(1) };
      }
    }
    return;
  }
  const files =
    mode === "--staged"
      ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n")
      : git("ls-files").split("\n");
  for (const file of files) {
    if (!file || SKIP.some((s) => s.test(file))) continue;
    let text;
    try {
      text = mode === "--staged" ? git("show", `:${file}`) : readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) yield { file, line: i + 1, text: lines[i] };
  }
}

const [mode = "--tree", arg] = process.argv.slice(2);
if (!["--staged", "--tree", "--range"].includes(mode) || (mode === "--range" && !arg)) {
  console.error("usage: leak-check.mjs --staged | --tree | --range A..B");
  process.exit(2);
}
const rules = [...RULES, ...loadDenylist()];
let hits = 0;
for (const { file, line, text } of candidates(mode, arg)) {
  if (SKIP.some((s) => s.test(file)) || text.includes("leak-check: allow")) continue;
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (!m || rule.allow?.test(m[0])) continue;
    hits++;
    // Never echo a denylisted string back into a CI log.
    const shown = rule.hidden ? "<private denylist entry>" : m[0];
    console.error(`${file}:${line}: [${rule.id}] ${shown}`);
  }
}

// gitleaks adds generic detectors (cloud keys, high-entropy strings) when it is installed.
let gitleaksFailed = false;
try {
  execFileSync("gitleaks", ["version"], { stdio: "ignore" });
  const args =
    mode === "--staged"
      ? ["git", "--staged", "--config", ".gitleaks.toml", "--redact", "--no-banner"]
      : mode === "--range"
        ? ["git", "--log-opts", arg, "--config", ".gitleaks.toml", "--redact", "--no-banner"]
        : ["dir", ".", "--config", ".gitleaks.toml", "--redact", "--no-banner"];
  try {
    execFileSync("gitleaks", args, { stdio: "inherit" });
  } catch {
    gitleaksFailed = true;
  }
} catch {
  // not installed: the rules above still ran
}

if (hits || gitleaksFailed) {
  console.error(
    `\nleak-check: ${hits} finding(s)${gitleaksFailed ? " + gitleaks findings" : ""}. Replace with a placeholder ` +
      '(see CLAUDE.md, "Public repo hygiene"), or end the line with `leak-check: allow` if it is a deliberate example.',
  );
  process.exit(1);
}
console.log(`leak-check (${mode}): clean`);
