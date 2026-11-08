import * as assert from "assert";
import * as path from "path";

type Commit = { hash: string; parents: string[] };
type Layout = {
  perRow: { lane: number; before: (string | null)[]; after: (string | null)[]; parentLanes: number[] }[];
  totalLanes: number;
};
// The webview module is plain JS shared with the browser; it exports via module.exports under Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { computeLaneLayout, passthroughTarget } = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  computeLaneLayout: (commits: Commit[]) => Layout;
  passthroughTarget: (row: Layout["perRow"][number], lane: number) => number;
};

describe("passthroughTarget", () => {
  it("keeps a lane in its column when another lane awaits the same parent", () => {
    // Issue #1 (after 1.3.1): merge m brings in o2→o1, which forked from p; main's c also has
    // parent p. On c's row both lanes await p — the orange lane must run straight down, not
    // bend into c's column.
    const layout = computeLaneLayout([
      { hash: "m", parents: ["c", "o2"] },
      { hash: "o2", parents: ["o1"] },
      { hash: "o1", parents: ["p"] },
      { hash: "c", parents: ["p"] },
      { hash: "p", parents: [] },
    ]);
    const cRow = layout.perRow[3];
    assert.deepStrictEqual(cRow.after, ["p", "p"]);
    assert.strictEqual(passthroughTarget(cRow, 1), 1);
    // On p's row both lanes converge into the node.
    assert.deepStrictEqual(layout.perRow[4].before, ["p", "p"]);
    assert.strictEqual(layout.perRow[4].lane, 0);
  });

  it("follows a lane that moved, and ends one that closed", () => {
    const row = { lane: 0, before: ["a", "b"], after: [null, "a"], parentLanes: [] };
    assert.strictEqual(passthroughTarget(row, 0), 1);
    assert.strictEqual(passthroughTarget(row, 1), -1);
  });
});

describe("computeLaneLayout", () => {
  it("keeps a linear history in one lane", () => {
    const layout = computeLaneLayout([
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    assert.deepStrictEqual(layout.perRow.map((r) => r.lane), [0, 0, 0]);
    assert.strictEqual(layout.totalLanes, 1);
  });

  it("opens a second lane for a merge and closes it at the fork point", () => {
    // m merges f (feature) into b; both come from a.
    const layout = computeLaneLayout([
      { hash: "m", parents: ["b", "f"] },
      { hash: "f", parents: ["a"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    assert.deepStrictEqual(layout.perRow[0].parentLanes, [0, 1]);
    assert.strictEqual(layout.perRow[1].lane, 1);
    assert.strictEqual(layout.perRow[2].lane, 0);
    assert.strictEqual(layout.perRow[3].lane, 0);
    assert.strictEqual(layout.totalLanes, 2);
  });

  it("frees every lane waiting on a fork point, so no phantom lane runs on below it", () => {
    // Issue #1: feature branch f forked from r (unmerged); main continues with x. After r, the
    // lane f reserved for r must be released — the next branch must not be pushed to lane 2.
    const layout = computeLaneLayout([
      { hash: "x", parents: ["r"] },
      { hash: "f", parents: ["r"] },
      { hash: "r", parents: ["m"] },
      { hash: "m", parents: ["b", "g"] },
      { hash: "g", parents: ["b"] },
      { hash: "b", parents: [] },
    ]);
    assert.deepStrictEqual(layout.perRow[2].before, ["r", "r"]);
    assert.deepStrictEqual(layout.perRow[2].after, ["m"]);
    assert.deepStrictEqual(layout.perRow[3].parentLanes, [0, 1]);
    assert.strictEqual(layout.perRow[4].lane, 1);
    assert.strictEqual(layout.totalLanes, 2);
  });

  /**
   * Invariants every layout must keep: a row's commit sits in its lane; once a commit has been
   * drawn no lane waits for it any more (no phantom line); every hash appears in at most one
   * lane after a row unless it is still awaited by several children (allowed until it is drawn).
   */
  function assertSound(commits: Commit[], layout: Layout): void {
    const seen = new Set<string>();
    layout.perRow.forEach((r, i) => {
      const c = commits[i];
      const idx = r.before.indexOf(c.hash);
      if (idx !== -1) assert.ok(r.before[r.lane] === c.hash, `row ${i}: node must sit in a lane awaiting it`);
      seen.add(c.hash);
      for (const h of r.after) assert.ok(h === null || !seen.has(h), `row ${i}: lane still waits for drawn commit ${h}`);
      assert.strictEqual(r.parentLanes.length, (c.parents || []).length, `row ${i}: one lane per parent`);
      r.parentLanes.forEach((l, p) => assert.strictEqual(r.after[l], c.parents[p], `row ${i}: parent ${p} lane`));
      assert.ok(r.after.length === 0 || r.after[r.after.length - 1] !== null, `row ${i}: trailing empty lane`);
      assertDrawable(c, r, i);
    });
  }

  /**
   * What graphSvg draws must be connected: every lane alive below a row is fed either by a
   * passthrough from above or by the node's own parent edge, a lane that still holds the same hash
   * runs straight down, and a passthrough always lands on a lane awaiting that same hash.
   */
  function assertDrawable(c: Commit, r: Layout["perRow"][number], i: number): void {
    const fed = new Set<number>(r.parentLanes);
    r.before.forEach((h, L) => {
      if (!h || h === c.hash) return;
      const t = passthroughTarget(r, L);
      assert.notStrictEqual(t, -1, `row ${i}: lane ${L} (${h}) vanishes without reaching its commit`);
      assert.strictEqual(r.after[t], h, `row ${i}: lane ${L} lands on a lane for another commit`);
      if (r.after[L] === h) assert.strictEqual(t, L, `row ${i}: lane ${L} (${h}) bends although its column stays`);
      fed.add(t);
    });
    r.after.forEach((h, L) => {
      if (h) assert.ok(fed.has(L), `row ${i}: lane ${L} (${h}) starts from nowhere`);
    });
  }

  const cases: { name: string; commits: Commit[]; lanes?: number }[] = [
    {
      name: "three branches forked from one commit",
      commits: [
        { hash: "a", parents: ["r"] }, { hash: "b", parents: ["r"] }, { hash: "c", parents: ["r"] },
        { hash: "r", parents: ["z"] }, { hash: "z", parents: [] },
      ],
      lanes: 3,
    },
    {
      name: "fork point awaited in a lane left of the node's own lane",
      // y takes lane 0 for r's sibling path; r is first reached from lane 1.
      commits: [
        { hash: "m", parents: ["q", "f"] }, { hash: "f", parents: ["r"] }, { hash: "q", parents: ["r"] },
        { hash: "r", parents: [] },
      ],
      lanes: 2,
    },
    {
      name: "octopus merge",
      commits: [
        { hash: "o", parents: ["a", "b", "c"] }, { hash: "c", parents: ["r"] }, { hash: "b", parents: ["r"] },
        { hash: "a", parents: ["r"] }, { hash: "r", parents: [] },
      ],
      lanes: 3,
    },
    {
      name: "merge whose second parent is already in a lane",
      commits: [
        { hash: "t", parents: ["f"] }, { hash: "m", parents: ["b", "f"] }, { hash: "f", parents: ["b"] },
        { hash: "b", parents: [] },
      ],
      lanes: 2,
    },
    {
      name: "criss-cross merges",
      commits: [
        { hash: "m1", parents: ["a", "b"] }, { hash: "m2", parents: ["b", "a"] },
        { hash: "a", parents: ["r"] }, { hash: "b", parents: ["r"] }, { hash: "r", parents: [] },
      ],
    },
    {
      name: "parents outside the loaded page",
      commits: [{ hash: "m", parents: ["x", "y"] }, { hash: "k", parents: ["x"] }],
      lanes: 3,
    },
    {
      name: "two unrelated roots (orphan branch)",
      commits: [
        { hash: "a2", parents: ["a1"] }, { hash: "b2", parents: ["b1"] },
        { hash: "a1", parents: [] }, { hash: "b1", parents: [] },
      ],
      lanes: 2,
    },
    {
      name: "merged branch and main commit share a parent (issue #1 screenshot)",
      commits: [
        { hash: "m", parents: ["c", "o3"] }, { hash: "o3", parents: ["o2"] }, { hash: "o2", parents: ["o1"] },
        { hash: "o1", parents: ["p"] }, { hash: "c", parents: ["p"] }, { hash: "p", parents: ["q"] },
        { hash: "q", parents: [] },
      ],
      lanes: 2,
    },
    {
      name: "several main commits pass while two lanes await the same parent",
      commits: [
        { hash: "m", parents: ["c3", "o1"] }, { hash: "o1", parents: ["p"] }, { hash: "c3", parents: ["c2"] },
        { hash: "c2", parents: ["c1"] }, { hash: "c1", parents: ["p"] }, { hash: "p", parents: [] },
      ],
      lanes: 2,
    },
    {
      name: "three lanes await one parent, a third lane passes between them",
      commits: [
        { hash: "m", parents: ["a", "b", "x"] }, { hash: "x", parents: ["y"] }, { hash: "b", parents: ["p"] },
        { hash: "a", parents: ["p"] }, { hash: "p", parents: ["y"] }, { hash: "y", parents: [] },
      ],
    },
    {
      name: "duplicate-awaited parent with an unrelated lane to its right",
      commits: [
        { hash: "t", parents: ["z"] }, { hash: "m", parents: ["c", "o"] }, { hash: "o", parents: ["p"] },
        { hash: "c", parents: ["p"] }, { hash: "p", parents: ["z"] }, { hash: "z", parents: [] },
      ],
    },
    {
      name: "back-to-back merges of branches forked from the same commit",
      commits: [
        { hash: "m2", parents: ["m1", "g"] }, { hash: "g", parents: ["p"] }, { hash: "m1", parents: ["c", "f"] },
        { hash: "f", parents: ["p"] }, { hash: "c", parents: ["p"] }, { hash: "p", parents: [] },
      ],
    },
    {
      name: "first-parent lane left of a duplicate that frees first",
      commits: [
        { hash: "m", parents: ["o", "c"] }, { hash: "c", parents: ["p"] }, { hash: "o", parents: ["p"] },
        { hash: "p", parents: [] },
      ],
      lanes: 2,
    },
  ];

  for (const tc of cases) {
    it(`stays sound: ${tc.name}`, () => {
      const layout = computeLaneLayout(tc.commits);
      assertSound(tc.commits, layout);
      if (tc.lanes != null) assert.strictEqual(layout.totalLanes, tc.lanes);
    });
  }

  it("reuses a freed fork-point lane for the next branch over a long history", () => {
    // 30 short-lived branches, each forked and merged back: the graph must never widen past 2.
    const commits: Commit[] = [];
    let base = "b0";
    const chain: Commit[] = [{ hash: "b0", parents: [] }];
    for (let i = 1; i <= 30; i++) {
      chain.push({ hash: `f${i}`, parents: [base] });
      chain.push({ hash: `b${i}`, parents: [base, `f${i}`] });
      base = `b${i}`;
    }
    commits.push(...chain.reverse());
    const layout = computeLaneLayout(commits);
    assertSound(commits, layout);
    assert.strictEqual(layout.totalLanes, 2);
  });

  it("returns an empty layout for no commits", () => {
    assert.deepStrictEqual(computeLaneLayout([]), { perRow: [], totalLanes: 0 });
  });
});
