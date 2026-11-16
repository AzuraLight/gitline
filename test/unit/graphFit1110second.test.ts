import * as assert from "assert";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const lane = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  fitLanes: (total: number, listWidth: number) => {
    laneW: number; nodeR: number; sidePad: number; columns: number; edgeLane: number; width: number;
  };
};

/** Second 1.11.0 review: the narrow-list branch of fitLanes. */
describe("1.11.0 second review: fitLanes narrow lists", () => {
  it("graph never wider than 40% of the list (1..120 px)", () => {
    const bad: string[] = [];
    for (let w = 1; w <= 120; w++) {
      for (const lanes of [1, 3, 40]) {
        const f = lane.fitLanes(lanes, w);
        if (f.width > Math.floor(w * 0.4)) bad.push(`w=${w} lanes=${lanes} width=${f.width}`);
      }
    }
    assert.deepStrictEqual(bad, []);
  });

  it("a node (r = nodeR) fits inside its lane", () => {
    const bad: string[] = [];
    for (let w = 1; w <= 120; w++) {
      const f = lane.fitLanes(40, w);
      if (f.nodeR * 2 > f.laneW) bad.push(`w=${w} laneW=${f.laneW} nodeR=${f.nodeR}`);
    }
    assert.deepStrictEqual(bad, []);
  });

  it("the dotted cut line (x = sidePad + columns*laneW) stays inside the svg, not on its edge", () => {
    const bad: string[] = [];
    for (let w = 1; w <= 120; w++) {
      const f = lane.fitLanes(40, w);
      if (f.edgeLane < 0 || f.width === 0) continue; // width 0: no graph is drawn
      // graphSvg.drawCut, with its clamp to the svg's inside (fix for this finding)
      const x = Math.min(f.sidePad + (f.edgeLane + 1) * f.laneW, f.width - 0.5);
      if (x + 0.5 > f.width) bad.push(`w=${w} x=${x} svg=${f.width}`);
    }
    assert.deepStrictEqual(bad, []);
  });
});
