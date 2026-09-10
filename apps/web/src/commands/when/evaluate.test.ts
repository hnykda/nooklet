import { describe, expect, it } from "vitest";
import { DEFAULT_WHEN_CONTEXT, type WhenContext } from "../types.js";
import { compileWhen } from "./compile.js";
import { areProvablyDisjoint } from "./disjoint.js";
import { WhenClauseError } from "./errors.js";
import { evaluateWhen } from "./evaluate.js";
import { parseWhen } from "./parser.js";

function ctx(partial: Partial<WhenContext>): WhenContext {
  return { ...DEFAULT_WHEN_CONTEXT, ...partial };
}

function run(expr: string, partial: Partial<WhenContext>): boolean {
  return evaluateWhen(compileWhen(expr), ctx(partial));
}

describe("evaluateWhen — spec test-case table (R6-R9)", () => {
  it.each([
    ["editorFocused", { editorFocused: true }, true],
    ["editorFocused && !hasSelection", { editorFocused: true, hasSelection: true }, false],
    ["editorFocused || blockSelected", { blockSelected: true }, true],
    ["platform == 'mac'", { platform: "mac" as const }, true],
    ["platform == 'mac' && mobile", { platform: "mac" as const, mobile: false }, false],
    ["selectionCount == 1", { selectionCount: 1 }, true],
    ["!zoomed", { zoomed: false }, true],
    [
      "(editorFocused || blockSelected) && hasChildren && !isCollapsed",
      { editorFocused: true, hasChildren: true, isCollapsed: false },
      true,
    ],
    ["bogusVar", {}, false],
    ["bogusVar == false", {}, false],
    ["bogusVar != false", {}, true],
  ] as const)("%s", (expr, partial, expected) => {
    expect(run(expr, partial)).toBe(expected);
  });
});

describe("evaluateWhen — precedence and negation", () => {
  it("&& binds tighter than ||", () => {
    // a=false, b=true, c=true: a || (b && c) => true; (a || b) && c would also be true here, so
    // pick values where the two parses diverge.
    const expr = "editorFocused || blockSelected && zoomed";
    // editorFocused=false, blockSelected=true, zoomed=false:
    // correct precedence: false || (true && false) = false
    // wrong (left-to-right, no precedence): (false || true) && false = false -- still same, retry
    expect(run(expr, { editorFocused: false, blockSelected: true, zoomed: false })).toBe(false);
    // editorFocused=true, blockSelected=true, zoomed=false:
    // correct: true || (true && false) = true
    // wrong ((a||b)&&c): (true||true) && false = false — this DOES diverge, proving precedence.
    expect(run(expr, { editorFocused: true, blockSelected: true, zoomed: false })).toBe(true);
  });

  it("! binds tighter than &&", () => {
    // !a && b, a=true b=true: correct = (!true) && true = false.
    // if ! applied to the whole conjunction instead, !(a&&b) = !(true&&true) = false too — need
    // a case that actually diverges: a=false, b=false.
    // correct: (!false) && false = false. still equal. Use a=false,b=true:
    // correct: (!false) && true = true. wrong !(a&&b) = !(false&&true) = !false = true. Same again
    // because && of anything with false is false, and !false is true either reading when a=false.
    // Diverging case needs a=true: correct !a&&b = false always when a=true (since !true=false).
    // !(a&&b) when a=true,b=false = !(false)=true. So a=true,b=false distinguishes them.
    const expr = "!editorFocused && hasSelection";
    expect(run(expr, { editorFocused: true, hasSelection: false })).toBe(false);
  });

  it("parentheses override precedence", () => {
    expect(
      run("!(editorFocused && hasSelection)", { editorFocused: true, hasSelection: true }),
    ).toBe(false);
    expect(
      run("!(editorFocused && hasSelection)", { editorFocused: true, hasSelection: false }),
    ).toBe(true);
  });

  it("double negation", () => {
    expect(run("!!editorFocused", { editorFocused: true })).toBe(true);
    expect(run("!!editorFocused", { editorFocused: false })).toBe(false);
  });

  it("whitespace is insignificant", () => {
    expect(
      run("  editorFocused   &&  ! hasSelection ", { editorFocused: true, hasSelection: false }),
    ).toBe(true);
  });
});

describe("evaluateWhen — literal semantics (R9)", () => {
  it("bare 'true'/'false' are grammar literals, not context lookups", () => {
    expect(run("true", {})).toBe(true);
    expect(run("false", {})).toBe(false);
    expect(run("true && editorFocused", { editorFocused: true })).toBe(true);
  });

  it("== requires exact primitive type AND value match, never coerces", () => {
    expect(run("isTask == true", { isTask: true })).toBe(true);
    expect(run("isTask == true", { isTask: false })).toBe(false);
    expect(run("selectionCount == 0", { selectionCount: 0 })).toBe(true);
    // number literal vs boolean-typed field never matches even if "0"/"1"-ish:
    expect(run("isTask == 1", { isTask: true })).toBe(false);
  });

  it("!= is exactly !(==)", () => {
    expect(run("platform != 'mac'", { platform: "windows" })).toBe(true);
    expect(run("platform != 'mac'", { platform: "mac" })).toBe(false);
  });

  it("an unknown identifier never equals anything, including its own negation's target", () => {
    expect(run("unknownVar == 'mac'", {})).toBe(false);
    expect(run("unknownVar != 'mac'", {})).toBe(true);
  });
});

describe("evaluateWhen — totality (never throws)", () => {
  it("handles a hand-built AST with no matching context fields without throwing", () => {
    expect(() =>
      evaluateWhen({ t: "ident", name: "nonexistentField" }, DEFAULT_WHEN_CONTEXT),
    ).not.toThrow();
  });
});

describe("compileWhen — syntax errors (R10)", () => {
  it.each([
    "editorFocused &&",
    "&& editorFocused",
    "editorFocused ||",
    "(editorFocused",
    "editorFocused)",
    "editorFocused = true",
    "editorFocused == ",
    "editorFocused == unquoted",
    "1 == 1",
    "editorFocused &",
    "editorFocused |",
    "'unterminated",
    "editorFocused !!",
  ])("rejects %s", (expr) => {
    expect(() => compileWhen(expr)).toThrow(WhenClauseError);
  });

  it("rejects trailing input after a complete expression", () => {
    expect(() => parseWhen("editorFocused editorFocused")).toThrow(WhenClauseError);
  });

  it("accepts every default-key `when` clause used across the spec's command tables", () => {
    const samples = [
      "editorFocused",
      "editorFocused && atLineStart && !hasSelection",
      "editorFocused && atLineEnd && !hasSelection",
      "editorFocused || blockSelected",
      "editorFocused && onFirstVisualLine",
      "(editorFocused || blockSelected) && hasChildren && !isCollapsed",
      "editorFocused && !popupOpen",
      "blockSelected",
      "zoomed",
      "true",
      "editorFocused && caretInLink",
      "isTask",
      "mobile && editorFocused",
      "selectionCount == 1",
      "editorFocused || (blockSelected && selectionCount == 1)",
    ];
    for (const s of samples) expect(() => compileWhen(s)).not.toThrow();
  });
});

describe("compileWhen — bare non-boolean identifier is a registration-time error (R6)", () => {
  it("rejects a bare `platform` (string-typed)", () => {
    expect(() => compileWhen("platform")).toThrow(WhenClauseError);
  });

  it("rejects a bare `selectionCount` (number-typed)", () => {
    expect(() => compileWhen("selectionCount")).toThrow(WhenClauseError);
  });

  it("allows `platform`/`selectionCount` when used in a comparison", () => {
    expect(() => compileWhen("platform == 'mac'")).not.toThrow();
    expect(() => compileWhen("selectionCount == 1")).not.toThrow();
  });

  it("allows a bare non-boolean identifier nested under && or !, still rejecting it", () => {
    expect(() => compileWhen("editorFocused && platform")).toThrow(WhenClauseError);
    expect(() => compileWhen("!platform")).toThrow(WhenClauseError);
  });

  it("does not reject an unrecognized identifier used bare (unknown, not non-boolean)", () => {
    expect(() => compileWhen("someFuturePluginFlag")).not.toThrow();
  });
});

describe("compileWhen — caches by source string", () => {
  it("returns the same AST reference for the same source string", () => {
    const a = compileWhen("editorFocused && hasSelection");
    const b = compileWhen("editorFocused && hasSelection");
    expect(a).toBe(b);
  });
});

describe("areProvablyDisjoint (R11) — the spec's conflict-detection test table", () => {
  it("does NOT prove disjoint isCollapsed/!isCollapsed guarded by the same (editorFocused||blockSelected) OR term — documented false positive (Open issue 8)", () => {
    const collapse = compileWhen("(editorFocused || blockSelected) && hasChildren && !isCollapsed");
    const expand = compileWhen("(editorFocused || blockSelected) && hasChildren && isCollapsed");
    expect(areProvablyDisjoint(collapse, expand)).toBe(false);
  });

  it("proves editorFocused vs blockSelected top-level terms disjoint", () => {
    const mergeWithPrevious = compileWhen("editorFocused && atLineStart && !hasSelection");
    const deleteSelected = compileWhen("blockSelected");
    expect(areProvablyDisjoint(mergeWithPrevious, deleteSelected)).toBe(true);
  });

  it("does not prove disjoint when neither when references the exclusive pair", () => {
    const a = compileWhen("true");
    const b = compileWhen("true");
    expect(areProvablyDisjoint(a, b)).toBe(false);
  });
});
