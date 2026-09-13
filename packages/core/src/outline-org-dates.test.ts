/**
 * OUT-23 import tolerance for org timestamps as Logseq actually wrote them (B-143): a one-digit
 * month or day (`<2023-2-17 Fri>`, 20 of the 24 `SCHEDULED:` lines in the owner's graph) and a
 * one-digit hour (`9:30`). Both must land in ADR 011's padded shape — the only one the reducer
 * accepts — or the date is lost.
 */
import { describe, expect, it } from "vitest";
import { parseOutline, serializeOutline } from "./outline.js";

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
