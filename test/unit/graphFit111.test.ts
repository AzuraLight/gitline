import * as assert from "assert";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const lane = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  fitLanes: (total: number, listWidth: number) => {
    laneW: number; nodeR: number; sidePad: number; columns: number; edgeLane: number; width: number;
  };
};

/** 1.11.0: the graph takes up to 40% of the list, then narrower lanes, then a cut. */
describe("1.11.0: fitting the graph to the list", () => {
  it("a graph that fits keeps 14 px lanes and draws every lane", () => {
    const f = lane.fitLanes(3, 1000);
    assert.deepStrictEqual(f, { laneW: 14, nodeR: 5, sidePad: 10, columns: 3, edgeLane: -1, width: 62 });
  });

  it("never wider than 40% of the list", () => {
    for (const [lanes, w] of [[20, 1000], [43, 1000], [244, 1000], [209, 1600], [40, 300], [1000, 2400]]) {
      const f = lane.fitLanes(lanes, w);
      assert.ok(f.width <= Math.floor(w * 0.4), `${lanes} lanes at ${w}px: ${f.width}`);
    }
  });

  it("narrower lanes before cutting: 43 lanes in a 1,000 px list all fit at 6 px", () => {
    const f = lane.fitLanes(43, 1000);
    assert.strictEqual(f.edgeLane, -1);
    assert.strictEqual(f.columns, 43);
    assert.ok(f.laneW >= 6 && f.laneW < 14, String(f.laneW));
  });

  it("cut at 6 px lanes: the last column is the edge, lanes past it share it", () => {
    const f = lane.fitLanes(244, 1000);
    assert.strictEqual(f.laneW, 6);
    assert.strictEqual(f.edgeLane, f.columns - 1);
    assert.strictEqual(f.width, 20 + f.columns * 6);
  });

  it("nodes shrink with the lanes, never below 2 px", () => {
    assert.strictEqual(lane.fitLanes(3, 1000).nodeR, 5);
    assert.strictEqual(lane.fitLanes(244, 1000).nodeR, 2);
  });

  it("a list not laid out yet (width 0) uses the old 220 px cap", () => {
    const f = lane.fitLanes(5, 0);
    assert.strictEqual(f.width, 90);
    assert.ok(lane.fitLanes(100, 0).width <= 220);
  });

  it("a very narrow list: one column within the 40% share, padding given up first", () => {
    const f = lane.fitLanes(50, 40);
    assert.ok(f.columns === 1 && f.edgeLane === 0 && f.width <= 16, JSON.stringify(f));
    assert.ok(f.sidePad < 10, JSON.stringify(f));
  });

  it("narrowed lanes keep each node's halo inside its lane; full-width lanes look as before", () => {
    // graphSvg.js: halo = laneW >= 14 ? nodeR + 3 : min(nodeR + 3, laneW / 2)
    const halo = (f: { laneW: number; nodeR: number }) => (f.laneW >= 14 ? f.nodeR + 3 : Math.min(f.nodeR + 3, f.laneW / 2));
    assert.strictEqual(halo(lane.fitLanes(3, 1000)), 8);
    for (const n of [43, 100, 244]) {
      const f = lane.fitLanes(n, 1000);
      assert.ok(halo(f) * 2 <= f.laneW, `${n} lanes: halo ${halo(f)} in ${f.laneW}px`);
    }
  });
});
