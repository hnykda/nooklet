// node --test tools/*.test.mjs (root `pnpm test` runs it). Stamps the REAL cask in
// packaging/homebrew/, so an edit there that moves the version or sha256 lines fails here rather
// than in the release workflow after the release is already public.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dmgNames, parseSha256Sums, stampCask } from "./ci/homebrew-cask.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cask = readFileSync(join(root, "packaging/homebrew/Casks/nooklet.rb"), "utf8");
const A = "a".repeat(64);
const B = "b".repeat(64);

function sumsFor(version) {
  const n = dmgNames(version);
  // The shape `sha256sum -- *` writes in the release job, plus files the cask must ignore.
  return parseSha256Sums(
    [
      `${"c".repeat(64)}  nooklet-${version}-linux-x64.AppImage`,
      `${A}  ${n.arm}`,
      `${B} *${n.intel}`,
      `${"d".repeat(64)}  nooklet-${version}-windows-x64-setup.exe`,
      "",
    ].join("\n"),
  );
}

test("the dmg names match what desktop-bundle.sh publishes", () => {
  const script = readFileSync(join(root, "tools/ci/desktop-bundle.sh"), "utf8");
  assert.match(script, /"nooklet-\$version-\$label\.dmg"/);
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /label: macos-arm64/);
  assert.match(workflow, /label: macos-x64/);
  assert.deepEqual(dmgNames("1.2.3"), {
    arm: "nooklet-1.2.3-macos-arm64.dmg",
    intel: "nooklet-1.2.3-macos-x64.dmg",
  });
});

test("stamps version and both checksums into the real cask", () => {
  const out = stampCask(cask, "1.2.3", sumsFor("1.2.3"));
  assert.match(out, /^ {2}version "1\.2\.3"$/m);
  assert.match(out, new RegExp(`sha256 arm: +"${A}",\\n +intel: +"${B}"`));
  // Nothing else moves: the URL keeps its #{version}/#{arch} interpolation.
  assert.equal(out.split("\n").length, cask.split("\n").length);
  assert.match(out, /releases\/download\/v#\{version\}\/nooklet-#\{version\}-macos-#\{arch\}\.dmg/);
  // Idempotent: stamping a stamped cask again with new values works (the tap is re-stamped).
  const again = stampCask(out, "1.2.4", sumsFor("1.2.4"));
  assert.match(again, /^ {2}version "1\.2\.4"$/m);
});

test("refuses prereleases, missing dmgs and a cask it cannot parse", () => {
  assert.throws(() => stampCask(cask, "1.2.3-rc.1", sumsFor("1.2.3-rc.1")), /not a final/);
  assert.throws(() => stampCask(cask, "1.2.3", sumsFor("1.2.2")), /no nooklet-1\.2\.3-macos-arm64/);
  assert.throws(
    () => stampCask(cask.replace(/^ {2}version .*$/m, ""), "1.2.3", sumsFor("1.2.3")),
    /exactly one version line/,
  );
});
