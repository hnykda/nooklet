/**
 * OUT-23 import tolerance for org timestamps as Logseq actually wrote them (B-143): a one-digit
 * month or day (`<2023-2-17 Fri>`, 20 of the 24 `SCHEDULED:` lines in the owner's graph) and a
 * one-digit hour (`9:30`). Both must land in ADR 011's padded shape — the only one the reducer
 * accepts — or the date is lost.
 */
import { describe, expect, it } from "vitest";
import { findOrgDateLines, orgDateLine, parseOutline, serializeOutline } from "./outline.js";

describe("parseOutline — org timestamps as Logseq wrote them (B-143)", () => {
  it("pads a one-digit month or day", () => {
    const p = parseOutline(
      "- DONE Mirek\n  SCHEDULED: <2023-2-17 Fri>\n- TODO other\n  DEADLINE: <2022-12-8 Thu>\n",
    );
    expect(p.blocks[0]?.content).toBe("Mirek");
    expect(p.blocks[0]?.properties).toEqual({ scheduled: "2023-02-17" });
    expect(p.blocks[1]?.content).toBe("other");
    expect(p.blocks[1]?.properties).toEqual({ deadline: "2022-12-08" });
  });

  it("pads a one-digit hour, keeping the repeater", () => {
    const p = parseOutline("- TODO standup\n  SCHEDULED: <2026-9-14 Mon 9:30 .+1d>\n");
    expect(p.blocks[0]?.properties).toEqual({ scheduled: "2026-09-14 09:30", repeat: "1d" });
  });

  it("an impossible date or time is still kept as text rather than stored wrong", () => {
    const p = parseOutline(
      "- a\n  SCHEDULED: <2023-2-30 Thu>\n- b\n  DEADLINE: <2023-02-10 Fri 25:00>\n",
    );
    expect(p.blocks[0]?.content).toBe("a\nSCHEDULED: <2023-2-30 Thu>");
    expect(p.blocks[0]?.properties).toEqual({});
    expect(p.blocks[1]?.content).toBe("b\nDEADLINE: <2023-02-10 Fri 25:00>");
  });

  it("round-trips to the padded property form, never back to org syntax", () => {
    const out = serializeOutline(parseOutline("- DONE x\n  SCHEDULED: <2023-2-17 Fri>\n"));
    expect(out).toContain("scheduled:: 2023-02-17");
    expect(out).not.toContain("SCHEDULED");
  });
});

/**
 * `nooklet repair org-dates` reads stored block text with these, so a graph imported before B-143
 * gets exactly the dates a re-import would give it — and no line a re-import keeps as text.
 */
describe("findOrgDateLines — org dates still sitting in a stored block's text", () => {
  it("finds the owner's shape, with its line index and padded value", () => {
    expect(findOrgDateLines("Mirek\nSCHEDULED: <2023-2-17 Fri>")).toEqual([
      { key: "scheduled", value: "2023-02-17", repeat: undefined, index: 1 },
    ]);
    expect(findOrgDateLines("x\nDEADLINE: <2026-9-14 Mon 9:30 .+1w>\nmore")).toEqual([
      { key: "deadline", value: "2026-09-14 09:30", repeat: "1w", index: 1 },
    ]);
  });

  it("takes no line the parser keeps as text", () => {
    const kept = [
      "SCHEDULED: <2023-2-30 Thu>",
      "see SCHEDULED: <2023-02-17 Fri>",
      "scheduled: <2023-02-17 Fri>",
      "```\nSCHEDULED: <2023-02-17 Fri>\n```",
    ];
    for (const text of kept) {
      expect(findOrgDateLines(text)).toEqual([]);
      const indented = text.split("\n").join("\n  ");
      expect(parseOutline(`- x\n  ${indented}\n`).blocks[0]?.properties).toEqual({});
    }
  });

  it("skips lines inside a code fence or a LOGBOOK drawer, and finds the ones after", () => {
    const text = [
      "notes",
      "```org",
      "SCHEDULED: <2023-02-17 Fri>",
      "```",
      ":LOGBOOK:",
      "DEADLINE: <2023-02-18 Sat>",
      ":END:",
      "DEADLINE: <2023-2-19 Sun>",
    ].join("\n");
    expect(findOrgDateLines(text).map((d) => [d.index, d.value])).toEqual([[7, "2023-02-19"]]);
  });

  it("agrees with the parser on the same line", () => {
    const d = orgDateLine("  SCHEDULED: <2022-12-8 Thu>  ");
    expect(d).toEqual({ key: "scheduled", value: "2022-12-08", repeat: undefined });
    expect(parseOutline("- x\n  SCHEDULED: <2022-12-8 Thu>\n").blocks[0]?.properties).toEqual({
      scheduled: d?.value,
    });
  });
});
