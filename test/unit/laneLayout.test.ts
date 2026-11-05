import * as assert from "assert";
import * as path from "path";

type Commit = { hash: string; parents: string[] };
type Layout = {
  perRow: { lane: number; before: (string | null)[]; after: (string | null)[]; parentLanes: number[] }[];
  totalLanes: number;
};
// The webview module is plain JS shared with the browser; it exports via module.exports under Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { computeLaneLayout } = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  computeLaneLayout: (commits: Commit[]) => Layout;
};

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

  it("returns an empty layout for no commits", () => {
    assert.deepStrictEqual(computeLaneLayout([]), { perRow: [], totalLanes: 0 });
  });
});
