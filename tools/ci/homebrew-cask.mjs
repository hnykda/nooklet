#!/usr/bin/env node
/**
 * Stamps a release's version and macOS .dmg checksums into the Homebrew cask.
 *
 *   node tools/ci/homebrew-cask.mjs <version> <SHA256SUMS> <cask in> [<cask out>]
 *
 * Run by .github/workflows/homebrew-tap.yml against packaging/homebrew/Casks/nooklet.rb, writing
 * the tap's copy. The checksums come from the release's own SHA256SUMS (the file users verify
 * against), never from re-hashing a download in the workflow: if the two ever disagreed, the cask
 * should fail to install rather than vouch for a file the release does not list.
 *
 * Only a final X.Y.Z is accepted. A prerelease in the cask would move every `brew upgrade` user
 * onto it, and `livecheck` (`github_latest`) ignores prereleases anyway.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The asset names tools/ci/desktop-bundle.sh gives the two macOS builds, keyed by cask arch. */
export function dmgNames(version) {
  return {
    arm: `nooklet-${version}-macos-arm64.dmg`,
    intel: `nooklet-${version}-macos-x64.dmg`,
  };
}

/** `sha256sum` output (`<hex>  <name>`, or `<hex> *<name>` in binary mode) → Map name → hex. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/** Replaces exactly one match of `re` (which must have one capture group: the value), or throws. */
function replaceOne(text, re, value, what) {
  const matches = [...text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${what} in the cask, found ${matches.length}`);
  }
  return text.replace(re, (whole, old) => whole.replace(old, value));
}

export function stampCask(cask, version, sums) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`not a final release version: ${JSON.stringify(version)}`);
  }
  const names = dmgNames(version);
  const sha = {};
  for (const [arch, name] of Object.entries(names)) {
    const hex = sums.get(name);
    if (!hex) throw new Error(`SHA256SUMS has no ${name}`);
    sha[arch] = hex;
  }
  let out = cask;
  out = replaceOne(out, /^ {2}version "([^"]*)"$/m, version, "version line");
  out = replaceOne(out, /sha256 arm: +"([0-9a-f]{64})"/, sha.arm, "arm sha256");
  out = replaceOne(out, /^ +intel: +"([0-9a-f]{64})"$/m, sha.intel, "intel sha256");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, sumsPath, caskIn, caskOut = caskIn] = process.argv.slice(2);
  if (!version || !sumsPath || !caskIn) {
    console.error("usage: homebrew-cask.mjs <version> <SHA256SUMS> <cask in> [<cask out>]");
    process.exit(2);
  }
  const stamped = stampCask(
    readFileSync(caskIn, "utf8"),
    version,
    parseSha256Sums(readFileSync(sumsPath, "utf8")),
  );
  writeFileSync(caskOut, stamped);
  console.log(`${caskOut}: nooklet ${version}`);
}
