#!/usr/bin/env node
// Prints the GitHub release notes for a version: the platform downloads with their honest status,
// then that version's CHANGELOG.md section. Used by .github/workflows/release.yml; run locally to
// preview:   node tools/ci/release-notes.mjs 0.1.0
//
// Exits 1 if CHANGELOG.md has no section for the version (pass --allow-missing for a dry run).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractChangelogSection, REPO_URL } from "../release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = process.argv[2]?.replace(/^v/, "");
const allowMissing = process.argv.includes("--allow-missing");
if (!version) {
  console.error("usage: release-notes.mjs <version> [--allow-missing]");
  process.exit(2);
}
const changelogPath = join(root, "CHANGELOG.md");
const section = existsSync(changelogPath)
  ? extractChangelogSection(readFileSync(changelogPath, "utf8"), version)
  : null;
if (section === null && !allowMissing) {
  console.error(`CHANGELOG.md has no "## [${version}]" section: run pnpm release ${version}`);
  process.exit(1);
}

const v = version;
const guide = `${REPO_URL}/blob/v${v}/docs/guide/getting-started.md`;
const report = `${REPO_URL}/issues/new?template=platform-report.yml`;
process.stdout.write(`## Downloads

| Platform | File | Status |
|---|---|---|
| macOS, Apple Silicon | \`nooklet-${v}-macos-arm64.dmg\` | What the maintainer uses daily (built locally from the same source). **Unsigned**: see below. |
| macOS, Intel | \`nooklet-${v}-macos-x64.dmg\` | Built in CI, not tested by the maintainer. Unsigned. |
| Linux x64 | \`nooklet-${v}-linux-x64.AppImage\`, \`.deb\` | Built in CI, not tested by the maintainer. |
| Windows x64 | \`nooklet-${v}-windows-x64-setup.exe\` | Built in CI, not tested by the maintainer. Unsigned (SmartScreen warns). |
| Android | \`nooklet-${v}-android-experimental*.apk\` | **Experimental.** Generated and built in CI, but never run on a device or emulator by the maintainer. [Help test it](${report}). |
| Server | \`docker pull ghcr.io/hnykda/nooklet:${v}\` | Tested on linux/amd64. linux/arm64 only smoke-tested. |
| iOS | none | Build from source with Xcode; no App Store or TestFlight build yet. |

**macOS: the app is not signed or notarized yet**, so macOS says it "is damaged" or "cannot be
opened". After dragging it to Applications, run \`xattr -dr com.apple.quarantine /Applications/nooklet.app\`
(or right-click → Open, then confirm). **Android:** enable installing unknown apps for your browser
or file manager, then open the APK. Details for every platform: [Getting started](${guide}).

Found a problem on Linux, Windows or Android? A [platform report](${report}) with a short
checklist is the most useful thing you can send.

Verify downloads against \`SHA256SUMS\`: \`shasum -a 256 -c SHA256SUMS --ignore-missing\`.

${section ?? "_(no CHANGELOG section: dry run)_"}
`);
