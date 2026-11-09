import * as assert from "assert";
import {
  ALL_REFS,
  classifyRevs,
  defaultViewForRevs,
  normalizeRevs,
  revsForDefaultView,
} from "../../src/viewSelection";

describe("view selection", () => {
  it("normalizes untrusted message input, and reads the pre-1.5 single rev", () => {
    assert.deepStrictEqual(normalizeRevs([" main ", "main", "", 3, null, "origin/x"]), ["main", "origin/x"]);
    assert.deepStrictEqual(normalizeRevs(undefined, "feature"), ["feature"]);
    assert.deepStrictEqual(normalizeRevs(undefined, ""), []);
    assert.deepStrictEqual(normalizeRevs("main"), []);
    assert.strictEqual(normalizeRevs(Array.from({ length: 5000 }, (_, i) => `b${i}`)).length, 2000);
  });

  it("classifies head, all, a single click and a list", () => {
    assert.deepStrictEqual(classifyRevs([]), { kind: "head" });
    assert.deepStrictEqual(classifyRevs([ALL_REFS]), { kind: "all" });
    assert.deepStrictEqual(classifyRevs(["main", ALL_REFS]), { kind: "all" });
    assert.deepStrictEqual(classifyRevs(["main"]), { kind: "single", rev: "main" });
    assert.deepStrictEqual(classifyRevs(["team/*"]), { kind: "list", revs: ["team/*"] });
    assert.deepStrictEqual(classifyRevs(["a", "b"]), { kind: "list", revs: ["a", "b"] });
  });

  it("maps settings to the opening selection", () => {
    assert.deepStrictEqual(revsForDefaultView("current", ["x"]), []);
    assert.deepStrictEqual(revsForDefaultView(undefined, undefined), []);
    assert.deepStrictEqual(revsForDefaultView("bogus", ["x"]), []);
    assert.deepStrictEqual(revsForDefaultView("all", ["x"]), [ALL_REFS]);
    assert.deepStrictEqual(revsForDefaultView("selected", ["main", " origin/team/* ", 7]), ["main", "origin/team/*"]);
    assert.deepStrictEqual(revsForDefaultView("selected", "main"), []);
    assert.deepStrictEqual(revsForDefaultView("selected", []), []);
  });

  it("edge cases: a revs array wins over the legacy rev, cap counts unique entries, patterns save as selected", () => {
    assert.deepStrictEqual(normalizeRevs([], "main"), []);
    assert.deepStrictEqual(normalizeRevs(["x"], "main"), ["x"]);
    assert.deepStrictEqual(normalizeRevs(null, 5), []);
    assert.strictEqual(normalizeRevs([...Array(3000).fill("same"), ...Array.from({ length: 2500 }, (_, i) => `u${i}`)]).length, 2000);
    assert.deepStrictEqual(classifyRevs(["*"]), { kind: "list", revs: ["*"] });
    assert.deepStrictEqual(defaultViewForRevs(["team/*"]), { view: "selected", branches: ["team/*"] });
    assert.deepStrictEqual(defaultViewForRevs(["main", ALL_REFS]), { view: "all", branches: undefined });
    assert.deepStrictEqual(defaultViewForRevs([]), { view: "current", branches: undefined });
    assert.deepStrictEqual(revsForDefaultView("selected", ["", "  ", "a", "a"]), ["a"]);
    assert.deepStrictEqual(revsForDefaultView("ALL", []), []);
  });

  it("round-trips a selection through the settings", () => {
    for (const revs of [[], [ALL_REFS], ["main"], ["main", "origin/team/*"]]) {
      const { view, branches } = defaultViewForRevs(revs);
      assert.deepStrictEqual(revsForDefaultView(view, branches), revs, JSON.stringify(revs));
    }
  });
});
