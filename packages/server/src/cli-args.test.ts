import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.js";

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
});
