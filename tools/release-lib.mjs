// Pure pieces of `tools/release.mjs`: version bumps as text -> text transforms, and the CHANGELOG
// section built from commit subjects. No git, no file system, so `tools/release.test.mjs` can
// pin every one of them. `tools/ci/changelog-section.mjs` reuses `extractChangelogSection`.

export const REPO_URL = "https://github.com/hnykda/nooklet";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `"0.1.0"` -> `{ major: 0, minor: 1, patch: 0, pre: null }`; throws on anything else. */
export function parseVersion(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`"${v}" is not a version like 0.1.0 or 0.2.0-rc.1`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Negative, zero or positive, like a sort comparator. A prerelease sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The integer build number Android (`versionCode`) and iOS (`CURRENT_PROJECT_VERSION`) need: both
 * must strictly increase between installs/uploads. major*1_000_000 + minor*1_000 + patch keeps
 * that for every minor/patch below 1000. A prerelease gets its release's number, so an rc and
 * its final release cannot both be installed over each other on Android; that is acceptable for
 * a sideloaded APK and documented in RELEASING.md.
 */
export function buildNumber(v) {
  const { major, minor, patch } = parseVersion(v);
  if (minor > 999 || patch > 999) throw new Error(`${v}: minor/patch above 999 break buildNumber`);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/** Apple's MARKETING_VERSION must be numeric dots only. */
export function marketingVersion(v) {
  const { major, minor, patch } = parseVersion(v);
  return `${major}.${minor}.${patch}`;
}

/** Replace exactly-once (or exactly `count` times) and fail loudly otherwise: a bump that silently
 * matched nothing would ship a release whose files disagree about its version. */
function replaceCounted(text, re, replacer, what, count = 1) {
  let n = 0;
  const out = text.replace(re, (...args) => {
    n++;
    return replacer(...args);
  });
  if (n !== count) throw new Error(`${what}: expected ${count} match(es), found ${n}`);
  return out;
}

/** package.json: sets (or adds, right after "name") the top-level "version", keeping formatting. */
export function bumpPackageJson(text, version) {
  const json = JSON.parse(text);
  if (typeof json.version === "string") {
    return replaceCounted(
      text,
      /^(\s*"version":\s*")[^"]*(")/m,
      (_m, a, b) => `${a}${version}${b}`,
      "package.json version",
    );
  }
  return replaceCounted(
    text,
    /^(\s*)("name":\s*"[^"]*",)$/m,
    (_m, indent, name) => `${indent}${name}\n${indent}"version": "${version}",`,
    'package.json "name" line (to add a version after it)',
  );
}

export function bumpTauriConf(text, version) {
  return replaceCounted(
    text,
    /^(\s{2}"version":\s*")[^"]*(")/m,
    (_m, a, b) => `${a}${version}${b}`,
    "tauri.conf.json version",
  );
}

/** Cargo.toml: the `version` inside `[package]` only, not a dependency's. */
export function bumpCargoToml(text, version) {
  return replaceCounted(
    text,
    /(\[package\][^[]*?\nversion = ")[^"]*(")/,
    (_m, a, b) => `${a}${version}${b}`,
    "Cargo.toml [package] version",
  );
}

/** Cargo.lock: the entry for our own crate, so `cargo build --locked` agrees with Cargo.toml. */
export function bumpCargoLock(text, version, crate = "nooklet-desktop") {
  return replaceCounted(
    text,
    new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]*(")`),
    (_m, a, b) => `${a}${version}${b}`,
    `Cargo.lock ${crate} entry`,
  );
}

/** Xcode project: MARKETING_VERSION and CURRENT_PROJECT_VERSION, once per build configuration
 * (Debug and Release, so twice each). */
export function bumpPbxproj(text, version) {
  const mv = marketingVersion(version);
  const bn = buildNumber(version);
  let out = replaceCounted(
    text,
    /(MARKETING_VERSION = )[^;]+(;)/g,
    (_m, a, b) => `${a}${mv}${b}`,
    "pbxproj MARKETING_VERSION",
    2,
  );
  out = replaceCounted(
    out,
    /(CURRENT_PROJECT_VERSION = )[^;]+(;)/g,
    (_m, a, b) => `${a}${bn}${b}`,
    "pbxproj CURRENT_PROJECT_VERSION",
    2,
  );
  return out;
}

/** Android app/build.gradle: versionCode and versionName in defaultConfig. */
export function bumpAppGradle(text, version) {
  let out = replaceCounted(
    text,
    /(\n\s*versionCode )\d+/,
    (_m, a) => `${a}${buildNumber(version)}`,
    "build.gradle versionCode",
  );
  out = replaceCounted(
    out,
    /(\n\s*versionName ")[^"]*(")/,
    (_m, a, b) => `${a}${version}${b}`,
    "build.gradle versionName",
  );
  return out;
}

/**
 * GitHub's heading anchor for a docs/BUGS.md entry (`### B-653 · title`), following
 * github-slugger: lower-case, drop everything that is not a letter, mark, number, connector,
 * space or hyphen, then each space becomes a hyphen (so " · " leaves a double hyphen).
 */
export function githubSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.+)$/i;

/** Types listed in full; anything else conventional or not lands in "Other". */
const LISTED = { feat: "Features", fix: "Fixes" };
/** Types that are counted, not listed: a release note that lists 176 docs commits is unread. */
const QUIET = new Set(["docs", "test", "tests", "style", "chore", "probe", "wip", "release"]);

/**
 * Builds one CHANGELOG section.
 *
 * @param {object} o
 * @param {string} o.version         the new version, without "v"
 * @param {string} o.date            YYYY-MM-DD
 * @param {string|null} o.previousTag  e.g. "v0.1.0", or null for the first release
 * @param {{hash: string, subject: string, body: string}[]} o.commits  newest first, no merges
 * @param {Record<string, string>} [o.bugHeadings]  "B-653" -> its full heading text, for anchors
 */
export function buildChangelogSection({ version, date, previousTag, commits, bugHeadings = {} }) {
  const tag = `v${version}`;
  const groups = { Features: [], Fixes: [], Other: [] };
  const quiet = new Map();
  for (const c of commits) {
    if (/^release: v\d/.test(c.subject)) continue;
    const m = CONVENTIONAL.exec(c.subject);
    const type = m?.groups.type.toLowerCase();
    if (type && QUIET.has(type) && !m.groups.bang) {
      quiet.set(type, (quiet.get(type) ?? 0) + 1);
      continue;
    }
    const group = (type && LISTED[type]) ?? "Other";
    const desc = m ? m.groups.desc : c.subject;
    const scope = m?.groups.scope ? `**${m.groups.scope}:** ` : "";
    const breaking = m?.groups.bang ? "**BREAKING** " : "";
    groups[group].push(
      `- ${breaking}${scope}${linkBugs(desc, tag, bugHeadings)}${bodyBugs(desc, c.body, tag, bugHeadings)} ([${c.hash.slice(0, 7)}](${REPO_URL}/commit/${c.hash}))`,
    );
  }

  const lines = [`## [${version}](${REPO_URL}/releases/tag/${tag}) - ${date}`, ""];
  if (!previousTag) {
    lines.push(
      "First tagged release. Everything before it is listed below; the docs in `docs/guide` say what works.",
      "",
    );
  }
  for (const [title, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    lines.push(`### ${title}`, "", ...items, "");
  }
  if (quiet.size > 0) {
    const parts = [...quiet.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`);
    const range = previousTag ? `${previousTag}...${tag}` : tag;
    lines.push(
      `Also ${parts.join(", ")} commits, not listed ([full diff](${REPO_URL}/${previousTag ? "compare" : "commits"}/${range})).`,
      "",
    );
  }
  return lines.join("\n");
}

function bugUrl(id, tag, bugHeadings) {
  const heading = bugHeadings[id];
  const anchor = heading ? `#${githubSlug(heading)}` : "";
  return `${REPO_URL}/blob/${tag}/docs/BUGS.md${anchor}`;
}

function linkBugs(text, tag, bugHeadings) {
  return text.replace(/\bB-(\d+)\b/g, (id) => `[${id}](${bugUrl(id, tag, bugHeadings)})`);
}

/** Bug ids the body names that the subject does not, appended so a fix is findable by its id. */
function bodyBugs(subject, body, tag, bugHeadings) {
  const inSubject = new Set(subject.match(/\bB-\d+\b/g) ?? []);
  const extra = [...new Set(body.match(/\bB-\d+\b/g) ?? [])].filter((id) => !inSubject.has(id));
  if (extra.length === 0) return "";
  return ` (${extra.map((id) => `[${id}](${bugUrl(id, tag, bugHeadings)})`).join(", ")})`;
}

/** `### B-653 · title` lines of docs/BUGS.md -> { "B-653": "B-653 · title" }. */
export function bugHeadingsFrom(bugsMd) {
  const out = {};
  for (const m of bugsMd.matchAll(/^#{2,4} (B-\d+\b.*)$/gm)) {
    const id = m[1].match(/^B-\d+/)[0];
    out[id] ??= m[1].trim();
  }
  return out;
}

export const CHANGELOG_HEADER = `# Changelog

Every release of nooklet, newest first. Written by \`pnpm release\` (tools/release.mjs) from the
conventional-commit subjects since the previous tag, then edited by hand. Bug ids link to
[docs/BUGS.md](docs/BUGS.md).
`;

/** Inserts a section under the header (creating the file's header if needed). */
export function prependChangelog(existing, section) {
  const body = existing?.trim() ? existing : CHANGELOG_HEADER;
  const idx = body.search(/^## /m);
  if (idx === -1) return `${body.trimEnd()}\n\n${section.trimEnd()}\n`;
  return `${body.slice(0, idx)}${section.trimEnd()}\n\n${body.slice(idx)}`;
}

/** The body of the `## [X.Y.Z]` section, for release notes. Null if there is none. */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}
