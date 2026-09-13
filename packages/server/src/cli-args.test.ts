import { describe, expect, it } from "vitest";
import { CliArgError, checkFlags, parseArgs, parseGcFlags, wantsHelp } from "./cli-args.js";

describe("parseArgs", () => {
  it("separates positionals from flags and takes the next token as a flag's value", () => {
    const a = parseArgs(["serve", "--port", "6100", "--data", "/tmp/g", "extra"]);
    expect(a._).toEqual(["serve", "extra"]);
    expect(a.flags.get("port")).toBe("6100");
    expect(a.flags.get("data")).toBe("/tmp/g");
  });

  it("a flag with no value is true; one followed by another flag is too", () => {
    const a = parseArgs(["import", "--dry-run", "--verbose"]);
    expect(a.flags.get("dry-run")).toBe(true);
    expect(a.flags.get("verbose")).toBe(true);
  });

  it("--no-<flag> sets <flag> to false (B-109: --no-mirror used to set 'no-mirror', read by nobody)", () => {
    const a = parseArgs(["serve", "--no-mirror", "--port", "1"]);
    expect(a.flags.get("mirror")).toBe(false);
    expect(a.flags.has("no-mirror")).toBe(false);
    expect(a.flags.get("port")).toBe("1");
  });

  it("--flag=value is the flag with that value, split at the first =", () => {
    const a = parseArgs(["serve", "--port=6100", "--host=http://x/?a=b"]);
    expect(a.flags.get("port")).toBe("6100");
    expect(a.flags.get("host")).toBe("http://x/?a=b");
    expect(a.flags.has("port=6100")).toBe(false);
  });
});

describe("parseGcFlags (B-109 follow-up: gc's flags went through a grammar that changed under them)", () => {
  const gc = (...argv: string[]) => parseGcFlags(parseArgs(["gc", ...argv]));

  it("--no-backup skips the backup (it used to read a 'no-backup' key that no longer existed)", () => {
    expect(gc("--no-backup")).toEqual({ dryRun: false, noBackup: true, assetGraceDays: undefined });
    expect(gc()).toEqual({ dryRun: false, noBackup: false, assetGraceDays: undefined });
  });

  it("--dry-run=true is a dry run, not a key called 'dry-run=true' that left gc destructive", () => {
    expect(gc("--dry-run=true").dryRun).toBe(true);
    expect(gc("--dry-run").dryRun).toBe(true);
    expect(gc("--dry-run=false").dryRun).toBe(false);
  });

  it("refuses what it does not understand rather than running gc for real", () => {
    expect(() => gc("--dryrun")).toThrow(CliArgError);
    expect(() => gc("--dry-run=maybe")).toThrow(/--dry-run/);
    expect(() => gc("--asset-grace")).toThrow(/--asset-grace/);
    expect(() => gc("--asset-grace", "-1")).toThrow(/--asset-grace/);
    expect(gc("--asset-grace=0", "--data", "/tmp/g").assetGraceDays).toBe(0);
  });
});

describe("checkFlags", () => {
  it("names every flag outside the known set", () => {
    expect(() => checkFlags(parseArgs(["restore", "x", "--forse"]), ["data", "force"])).toThrow(
      "unknown flag --forse",
    );
    expect(() =>
      checkFlags(parseArgs(["restore", "x", "--force"]), ["data", "force"]),
    ).not.toThrow();
  });

  it("--help, -h or help in any position is a request for usage, never a command (B-146)", () => {
    for (const argv of [["serve", "--help"], ["import", "x", "-h"], ["help"], ["--help"]]) {
      expect(wantsHelp(parseArgs(argv), argv)).toBe(true);
    }
    const plain = ["serve", "--port", "6100"];
    expect(wantsHelp(parseArgs(plain), plain)).toBe(false);
  });
});
