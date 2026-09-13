import { describe, expect, it } from "vitest";
import { mapThroughRewrite, TextVersions } from "./remote-text.js";

// Real HLC shape (`@nooklet/core`'s `hlc.ts`): lexicographic order is the clock's order.
const h = (ms: number, device = "aaaaaaaa") =>
  `${new Date(Date.UTC(2026, 8, 13, 12, 0, 0, ms)).toISOString()}-0000-${device}`;

const text = (entity: string, hlc: string) => ({
  hlc,
  entity,
  payload: { kind: "block.text" as const, content: "x" },
});

describe("TextVersions (B-192)", () => {
  it("a refetch that read before this tab's own write is not a remote change", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100)); // the text the editor was loaded with
    v.noteWrites([text("b", h(200))]); // this tab's flush
    // The refetch read the database before the flush landed: it carries the older version, with
    // the old text. It must not reach the editor.
    expect(v.decide("b", h(100), { sameText: false, unsaved: false })).toBe("keep");
    // …nor must the read that came after it, which is this tab's own write.
    expect(v.decide("b", h(200), { sameText: true, unsaved: false })).toBe("keep");
  });

  it("a stale read stays a stale read while typing is unsaved, too", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    v.noteWrites([text("b", h(200))]);
    expect(v.decide("b", h(100), { sameText: false, unsaved: true })).toBe("keep");
  });

  it("a write elsewhere that the database kept over ours is taken when nothing is unsaved", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    v.noteWrites([text("b", h(200))]);
    expect(v.decide("b", h(300, "bbbbbbbb"), { sameText: false, unsaved: false })).toBe("take");
    // Taken is known: the same version again is not a change.
    expect(v.decide("b", h(300, "bbbbbbbb"), { sameText: false, unsaved: false })).toBe("keep");
  });

  it("a write elsewhere older than ours lost last-writer-wins and is not taken", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    v.noteWrites([text("b", h(300))]);
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: false })).toBe("keep");
  });

  it("a newer version with unsaved typing is offered once, and held after that", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
    // Every later refetch of the same version while typing: the notice stands or was dismissed.
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("hold");
    // A newer one still is offered again.
    expect(v.decide("b", h(250, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
  });

  it("an offered version that the typing's write did not beat is taken once the typing is saved", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(300, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
    // The flush of the typing got an older HLC (the other clock runs ahead): the database kept the
    // other version, and the editor must not go on showing text the database does not hold.
    v.noteWrites([text("b", h(250))]);
    expect(v.decide("b", h(300, "bbbbbbbb"), { sameText: false, unsaved: false })).toBe("take");
  });

  it("an offered version that the typing's write beat is not taken afterwards", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
    v.noteWrites([text("b", h(300))]);
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: false })).toBe("keep");
    expect(v.decide("b", h(300), { sameText: true, unsaved: false })).toBe("keep");
  });

  it("a newer version saying what the buffer says is 'same'", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: true, unsaved: true })).toBe("same");
    expect(v.isNewer("b", h(200, "bbbbbbbb"))).toBe(false);
  });

  it("block.create counts as a text write; other ops do not", () => {
    const v = new TextVersions();
    v.noteWrites([
      {
        hlc: h(100),
        entity: "n",
        payload: {
          kind: "block.create",
          place: { pageId: "p", parentId: null, order: "a0" },
          content: "",
          createdAt: 0,
        },
      },
      {
        hlc: h(500),
        entity: "n",
        payload: { kind: "block.prop", key: "collapsed", value: "true" },
      },
    ]);
    expect(v.isNewer("n", h(200))).toBe(true);
  });

  it("a block never seen is not newer: the buffer wins, and the version becomes known", () => {
    const v = new TextVersions();
    expect(v.isNewer("b", h(100))).toBe(false);
    expect(v.decide("b", h(100), { sameText: false, unsaved: false })).toBe("keep");
    expect(v.decide("b", h(200), { sameText: false, unsaved: false })).toBe("take");
  });

  it("a newer version that left the text the typing started from is not offered (B-462)", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    // An agent flipped the task marker: a `block.text` of the same content, a newer `content_hlc`.
    const flip = h(200, "bbbbbbbb");
    const state = { sameText: false, unsaved: true, sameAsBeforeTyping: true };
    expect(v.decide("b", flip, state)).toBe("untouched");
    expect(v.decide("b", flip, state)).toBe("untouched");
    // Not known: if the typing's write lost to it, the database holds it, and with nothing unsaved
    // the editor takes it.
    expect(v.decide("b", flip, { sameText: false, unsaved: false })).toBe("take");
  });

  it("a version that puts back the text the typing started from clears a standing offer (B-462)", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
    expect(
      v.decide("b", h(300, "bbbbbbbb"), {
        sameText: false,
        unsaved: true,
        sameAsBeforeTyping: true,
      }),
    ).toBe("untouched");
    // The first version is no longer "already offered": offered again, it is a notice again.
    expect(v.decide("b", h(400, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
  });

  it("an offered version's text again under a newer HLC is held, not offered again (B-464)", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    const typing = { sameText: false, unsaved: true };
    expect(v.decide("b", h(200, "bbbbbbbb"), { ...typing, text: "theirs" })).toBe("offer");
    // Dismissed, still typing; the other writer flips the marker: same text, newer HLC.
    expect(v.decide("b", h(300, "bbbbbbbb"), { ...typing, text: "theirs" })).toBe("hold");
    // A different text is a new version.
    expect(v.decide("b", h(400, "bbbbbbbb"), { ...typing, text: "theirs, again" })).toBe("offer");
    // Without a text to compare, only the HLC decides, as before.
    expect(v.decide("b", h(500, "bbbbbbbb"), typing)).toBe("offer");
    expect(v.decide("b", h(600, "bbbbbbbb"), typing)).toBe("offer");
  });

  it("taking an offered version makes it known and clears the offer", () => {
    const v = new TextVersions();
    v.noteShown("b", h(100));
    expect(v.decide("b", h(200, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
    v.taken("b", h(200, "bbbbbbbb"));
    expect(v.isNewer("b", h(200, "bbbbbbbb"))).toBe(false);
    expect(v.decide("b", h(300, "bbbbbbbb"), { sameText: false, unsaved: true })).toBe("offer");
  });
});

describe("mapThroughRewrite", () => {
  it("keeps a caret at the end of a wrapped line at the end", () => {
    expect(mapThroughRewrite("Probe kickoff", "[[Probe kickoff]]", 13)).toBe(17);
  });

  it("keeps a caret before the change where it is", () => {
    expect(mapThroughRewrite("alpha beta gamma", "alpha beta GAMMA", 5)).toBe(5);
  });

  it("moves a caret after the change with the text after it", () => {
    expect(mapThroughRewrite("alpha beta gamma", "ALPHA-ONE beta gamma", 10)).toBe(14);
  });

  it("puts a caret inside the changed span at the end of the new span", () => {
    expect(mapThroughRewrite("one two three", "one 2 three", 6)).toBe(5);
  });

  it("keeps a caret at the end at the end, clamps one past it, and handles an emptied block", () => {
    expect(mapThroughRewrite("abc", "abcdef", 3)).toBe(6);
    expect(mapThroughRewrite("abc", "abcdef", 99)).toBe(6);
    expect(mapThroughRewrite("abc", "", 2)).toBe(0);
    // An empty block's only caret is its end.
    expect(mapThroughRewrite("", "new", 0)).toBe(3);
  });

  it("never lands between the halves of a surrogate pair", () => {
    // U+1F600 and U+1F603: two UTF-16 units each, the same high half, different low halves.
    const before = "a\u{1F600}b";
    const after = "a\u{1F603}b";
    const pos = mapThroughRewrite(before, after, 3); // after the emoji
    expect(pos).toBe(3);
    expect(mapThroughRewrite(before, after, 2)).not.toBe(2);
  });
});
