// node --test tools/*.test.mjs (root `pnpm test` runs it). The version bumps run against the REAL
// files in this checkout, so a regenerated Xcode/Gradle project that moves a field fails here,
// not halfway through a release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bugHeadingsFrom,
  buildChangelogSection,
  buildNumber,
  bumpAppGradle,
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  bumpPbxproj,
  bumpTauriConf,
  compareVersions,
  extractChangelogSection,
  githubSlug,
  prependChangelog,
} from "./release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("versions compare and number", () => {
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.2.0-rc.1", "0.2.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(buildNumber("0.1.0"), 1000);
  assert.equal(buildNumber("1.2.3"), 1_002_003);
  assert.ok(buildNumber("0.10.0") > buildNumber("0.9.99"));
  assert.throws(() => buildNumber("v1"));
});

test("package.json: replaces a version, or adds one after name", () => {
  const withV = '{\n  "name": "x",\n  "version": "0.0.1",\n  "deps": { "version": "keep" }\n}\n';
  assert.equal(
    bumpPackageJson(withV, "0.1.0"),
    '{\n  "name": "x",\n  "version": "0.1.0",\n  "deps": { "version": "keep" }\n}\n',
  );
  const noV = '{\n  "name": "nooklet",\n  "private": true\n}\n';
  assert.equal(
    bumpPackageJson(noV, "0.1.0"),
    '{\n  "name": "nooklet",\n  "version": "0.1.0",\n  "private": true\n}\n',
  );
  for (const f of [
    "package.json",
    "apps/web/package.json",
    "apps/desktop/package.json",
    "plugins/mermaid/package.json",
  ]) {
    assert.equal(JSON.parse(bumpPackageJson(read(f), "9.8.7")).version, "9.8.7", f);
  }
});

test("the real desktop, iOS and Android files bump", () => {
  assert.equal(
    JSON.parse(bumpTauriConf(read("apps/desktop/src-tauri/tauri.conf.json"), "9.8.7")).version,
    "9.8.7",
  );
  const toml = bumpCargoToml(read("apps/desktop/src-tauri/Cargo.toml"), "9.8.7");
  assert.match(toml, /\[package\]\nname = "nooklet-desktop"\nversion = "9\.8\.7"/);
  assert.match(toml, /tauri-build = \{ version = "2"/, "dependency versions untouched");
  const lock = bumpCargoLock(read("apps/desktop/src-tauri/Cargo.lock"), "9.8.7");
  assert.match(lock, /name = "nooklet-desktop"\nversion = "9\.8\.7"/);
  const pbx = bumpPbxproj(read("apps/web/ios/App/App.xcodeproj/project.pbxproj"), "9.8.7-rc.1");
  assert.equal(pbx.match(/MARKETING_VERSION = 9\.8\.7;/g)?.length, 2);
  assert.equal(pbx.match(/CURRENT_PROJECT_VERSION = 9008007;/g)?.length, 2);
  const gradle = bumpAppGradle(read("apps/web/android/app/build.gradle"), "9.8.7");
  assert.match(gradle, /versionCode 9008007\n/);
  assert.match(gradle, /versionName "9\.8\.7"\n/);
});

test("a bump that matches nothing fails instead of silently skipping", () => {
  assert.throws(() => bumpTauriConf("{}", "1.0.0"), /expected 1 match/);
  assert.throws(() => bumpPbxproj("MARKETING_VERSION = 1.0;", "1.0.0"), /expected 2/);
});

test("github-slugger anchors for BUGS.md headings", () => {
  // github-slugger's algorithm worked by hand ("·" and backticks dropped, each space a hyphen).
  // NOT checked against github.com: the /markdown API renders headings without ids.
  assert.equal(
    githubSlug("B-653 · `--graph` and `--no-mirror` are missing from `nooklet --help`"),
    "b-653----graph-and---no-mirror-are-missing-from-nooklet---help",
  );
  const headings = bugHeadingsFrom("# Bugs\n\n### B-12 · Thing breaks\n\ntext\n### B-13 · Other\n");
  assert.deepEqual(headings, { "B-12": "B-12 · Thing breaks", "B-13": "B-13 · Other" });
});

test("changelog section: grouped, bugs linked, noise counted", () => {
  const section = buildChangelogSection({
    version: "0.2.0",
    date: "2026-10-04",
    previousTag: "v0.1.0",
    bugHeadings: { "B-12": "B-12 · Thing breaks" },
    commits: [
      { hash: "a".repeat(40), subject: "feat(editor): undo across pages", body: "" },
      { hash: "b".repeat(40), subject: "fix: thing breaks (B-12)", body: "see also B-13" },
      { hash: "c".repeat(40), subject: "docs: words", body: "" },
      { hash: "d".repeat(40), subject: "test: more", body: "" },
      { hash: "e".repeat(40), subject: "docs: more words", body: "" },
      { hash: "f".repeat(40), subject: "Tidy the thing", body: "" },
      { hash: "9".repeat(40), subject: "release: v0.1.0", body: "" },
    ],
  });
  assert.match(
    section,
    /^## \[0\.2\.0\]\(https:\/\/github\.com\/hnykda\/nooklet\/releases\/tag\/v0\.2\.0\) - 2026-10-04/,
  );
  assert.match(section, /### Features\n\n- \*\*editor:\*\* undo across pages \(\[aaaaaaa\]/);
  assert.match(
    section,
    /- thing breaks \(\[B-12\]\(https:\/\/github\.com\/hnykda\/nooklet\/blob\/v0\.2\.0\/docs\/BUGS\.md#b-12--thing-breaks\)\) \(\[B-13\]\([^)]*BUGS\.md\)\)/,
  );
  assert.match(section, /### Other\n\n- Tidy the thing/);
  assert.match(
    section,
    /Also 2 docs, 1 test commits, not listed \(\[full diff\]\([^)]*compare\/v0\.1\.0\.\.\.v0\.2\.0\)\)/,
  );
  assert.doesNotMatch(section, /release: v0\.1\.0/);
});

test("changelog file: prepend and extract round-trip", () => {
  const first = prependChangelog("", "## [0.1.0](x) - 2026-10-04\n\n### Fixes\n\n- one\n");
  const second = prependChangelog(first, "## [0.2.0](x) - 2026-11-01\n\n- two\n");
  assert.ok(second.startsWith("# Changelog"));
  assert.ok(second.indexOf("## [0.2.0]") < second.indexOf("## [0.1.0]"));
  assert.equal(extractChangelogSection(second, "0.2.0"), "- two");
  assert.equal(extractChangelogSection(second, "0.1.0"), "### Fixes\n\n- one");
  assert.equal(extractChangelogSection(second, "9.9.9"), null);
});
