#!/usr/bin/env node
// Cuts a release: `pnpm release <version> [flags]`. See RELEASING.md for the whole flow.
//
//   pnpm release 0.1.0 --dry-run     show every check, file change, changelog and git command
//   pnpm release 0.1.0               check, bump, write CHANGELOG (pauses for review), commit, tag
//   pnpm release 0.1.0 --push        ...then, after typing the version to confirm, push main + tag
//
// Flags:
//   --dry-run        change nothing; print what would change
//   --skip-slow      skip typecheck and unit tests (biome and the leak check still run)
//   --no-edit        do not open $EDITOR / pause on the changelog
//   --allow-branch   skip "must be main, up to date with origin" (for rehearsing on a throwaway
//                    branch; never for a real release)
//   --push           push after tagging, with a confirmation prompt
//
// It never pushes without --push and a typed confirmation, and it never talks to GitHub: pushing
// the tag is what starts .github/workflows/release.yml and the Woodpecker images pipeline.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  bugHeadingsFrom,
  buildChangelogSection,
  bumpAppGradle,
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  bumpPbxproj,
  bumpTauriConf,
  compareVersions,
  parseVersion,
  prependChangelog,
} from "./release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
const known = new Set(["dry-run", "skip-slow", "no-edit", "allow-branch", "push"]);
const unknown = args.filter((a) => a.startsWith("--") && !known.has(a.slice(2)));

if (!version || unknown.length > 0) {
  console.error(
    `usage: pnpm release <version> [--dry-run] [--skip-slow] [--no-edit] [--allow-branch] [--push]${
      unknown.length ? `\nunknown flag(s): ${unknown.join(" ")}` : ""
    }`,
  );
  process.exit(2);
}
parseVersion(version);
const dry = flag("dry-run");
const tag = `v${version}`;
const problems = [];

function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
}
function gitOk(...a) {
  return spawnSync("git", a, { cwd: root, stdio: "ignore" }).status === 0;
}
function step(title) {
  console.log(`\n== ${title}`);
}
/** In a dry run a failed precondition is reported and the run continues, so one dry run shows
 * everything that is wrong; in a real run it stops. */
function fail(msg) {
  if (dry) {
    problems.push(msg);
    console.log(`   WOULD STOP: ${msg}`);
  } else {
    console.error(`\nrelease: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- preconditions
step("Preconditions");
const status = git("status", "--porcelain");
if (status) fail(`the working tree is not clean:\n${status}`);
else console.log("   working tree clean");

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (flag("allow-branch")) {
  console.log(`   --allow-branch: on "${branch}", main/origin checks skipped (rehearsal only)`);
} else {
  if (branch !== "main") fail(`releases are cut from main, this is "${branch}"`);
  // Read-only: updates origin/main so the comparison below is current.
  if (!gitOk("fetch", "--quiet", "origin", "main")) fail("git fetch origin main failed (offline?)");
  const head = git("rev-parse", "HEAD");
  const remote = gitOk("rev-parse", "--verify", "--quiet", "origin/main")
    ? git("rev-parse", "origin/main")
    : "";
  if (head !== remote) {
    fail(
      `HEAD (${head.slice(0, 8)}) is not origin/main (${remote.slice(0, 8) || "missing"}): pull or push first`,
    );
  } else console.log("   main is up to date with origin/main");
}

if (gitOk("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`))
  fail(`tag ${tag} already exists`);
const previousTag = gitOk("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*")
  ? git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*")
  : null;
if (previousTag && compareVersions(version, previousTag.slice(1)) <= 0) {
  fail(`${version} is not newer than the last tag ${previousTag}`);
}
console.log(`   previous tag: ${previousTag ?? "(none: first release)"}`);

// ---------------------------------------------------------------- quality checks
const checks = [
  ...(flag("skip-slow")
    ? []
    : [
        ["typecheck", "pnpm", ["-r", "typecheck"]],
        ["unit tests", "pnpm", ["test"]],
      ]),
  ["biome", "pnpm", ["exec", "biome", "check", ".", "--diagnostic-level=error"]],
  ["leak check", "node", ["tools/leak-check.mjs", "--tree"]],
];
step(`Checks${flag("skip-slow") ? " (--skip-slow: typecheck and tests skipped)" : ""}`);
for (const [name, cmd, a] of checks) {
  if (dry) {
    console.log(`   would run: ${cmd} ${a.join(" ")}`);
    continue;
  }
  console.log(`   ${name}: ${cmd} ${a.join(" ")}`);
  const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`${name} failed`);
}

// ---------------------------------------------------------------- version bump
step(`Version -> ${version}`);
const packageJsons = git("ls-files", "package.json", "*/package.json").split("\n").filter(Boolean);
const bumps = [
  ...packageJsons.map((f) => [f, bumpPackageJson]),
  ["apps/desktop/src-tauri/tauri.conf.json", bumpTauriConf],
  ["apps/desktop/src-tauri/Cargo.toml", bumpCargoToml],
  ["apps/desktop/src-tauri/Cargo.lock", bumpCargoLock],
  ["apps/web/ios/App/App.xcodeproj/project.pbxproj", bumpPbxproj],
  ["apps/web/android/app/build.gradle", bumpAppGradle],
];
// The help menu's version comes from apps/web/package.json through vite.config.ts, so it moves
// with the package.json bump above; there is no separate literal to change.
const writes = [];
for (const [file, bump] of bumps) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = bump(before, version);
  const changed = diffLines(before, after);
  console.log(`   ${file}${changed.length ? "" : "  (already at this version)"}`);
  for (const [a, b] of changed) console.log(`      - ${a.trim()}\n      + ${b.trim()}`);
  if (changed.length) writes.push([path, after]);
}

/** Line pairs that differ (the bumps never add or remove lines except one added "version"). */
function diffLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length !== y.length) {
    const added = y.filter((l) => !x.includes(l));
    return added.map((l) => ["(none)", l]);
  }
  return x.flatMap((l, i) => (l === y[i] ? [] : [[l, y[i]]]));
}

// ---------------------------------------------------------------- changelog
step("CHANGELOG.md");
const SEP = "\x1f";
const REC = "\x1e";
const log = execFileSync(
  "git",
  [
    "log",
    "--no-merges",
    `--format=%H${SEP}%s${SEP}%b${REC}`,
    ...(previousTag ? [`${previousTag}..HEAD`] : ["HEAD"]),
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const commits = log
  .split(REC)
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [hash, subject, body = ""] = r.split(SEP);
    return { hash, subject, body };
  });
const bugsPath = join(root, "docs", "BUGS.md");
const section = buildChangelogSection({
  version,
  date: new Date().toISOString().slice(0, 10),
  previousTag,
  commits,
  bugHeadings: existsSync(bugsPath) ? bugHeadingsFrom(readFileSync(bugsPath, "utf8")) : {},
});
console.log(`   ${commits.length} commits since ${previousTag ?? "the beginning"}; new section:\n`);
console.log(
  section
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n"),
);
const changelogPath = join(root, "CHANGELOG.md");
const changelog = prependChangelog(
  existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "",
  section,
);

// ---------------------------------------------------------------- git
const commitMsg = `release: ${tag}`;
const pushCmds = ["git push origin main", `git push origin ${tag}`];
step("Git");
if (dry) {
  console.log(`   would commit: "${commitMsg}" (${writes.length + 1} files)`);
  console.log(`   would tag:    ${tag} (annotated, "nooklet ${tag}")`);
  console.log(`   then you run: ${pushCmds.join(" && ")}`);
  console.log(
    problems.length
      ? `\nDry run: ${problems.length} problem(s) would stop a real run (marked WOULD STOP above).`
      : "\nDry run: nothing written.",
  );
  process.exit(problems.length ? 1 : 0);
}

for (const [path, text] of writes) writeFileSync(path, text);
writeFileSync(changelogPath, changelog);
console.log("   files written");

if (!flag("no-edit")) await reviewChangelog();

git("add", "-A", "--", ...writes.map(([p]) => p), changelogPath);
const stray = git("status", "--porcelain", "--untracked-files=no")
  .split("\n")
  .filter((l) => l && !/^[MA] /.test(l));
if (stray.length) fail(`unexpected unstaged changes after the bump:\n${stray.join("\n")}`);
git("commit", "--quiet", "-m", commitMsg);
git("tag", "-a", tag, "-m", `nooklet ${tag}`);
console.log(`   committed ${git("rev-parse", "--short", "HEAD")} "${commitMsg}" and tagged ${tag}`);

if (!flag("push")) {
  console.log(
    `\nNothing is pushed. Check the commit (git show), then:\n\n   ${pushCmds.join(" && ")}\n`,
  );
  console.log("Pushing the tag starts the GitHub release workflow (a draft release) and the");
  console.log("Woodpecker images pipeline. To undo before pushing:");
  console.log(`   git tag -d ${tag} && git reset --hard HEAD~1`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nPush main and ${tag} to origin? Type ${version} to confirm: `);
rl.close();
if (answer.trim() !== version) {
  console.log(`Not pushed. To push later: ${pushCmds.join(" && ")}`);
  process.exit(0);
}
for (const c of pushCmds) {
  const [cmd, ...a] = c.split(" ");
  const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`"${c}" failed`);
}
console.log(`\nPushed. Watch the release workflow, then publish the draft: RELEASING.md step 4.`);

async function reviewChangelog() {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor && process.stdin.isTTY) {
    console.log(`   opening CHANGELOG.md in ${editor}: edit the new section, save and close`);
    // Through the shell: $EDITOR is often "code --wait" or similar, with arguments.
    const r = spawnSync(`${editor} "${changelogPath}"`, { shell: true, stdio: "inherit" });
    if (r.status !== 0)
      fail(`the editor exited with ${r.status}; nothing committed (files are bumped)`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.log("   no terminal: CHANGELOG.md written without review (use --no-edit to say so)");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    "   Review/edit CHANGELOG.md now, then press Enter to commit (Ctrl-C aborts): ",
  );
  rl.close();
}
