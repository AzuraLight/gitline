import * as assert from "assert";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const lane = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  fitLanes: (total: number, listWidth: number) => {
    laneW: number; nodeR: number; sidePad: number; columns: number; edgeLane: number; width: number;
  };
};

/** Review probes for 1.11.0 fitLanes. */
describe("1.11.0 review: fitLanes edge values", () => {
  it("width is consistent with columns and laneW for a sweep of inputs", () => {
    for (let lanes = 0; lanes <= 300; lanes += 7) {
      for (let w = 0; w <= 3000; w += 37) {
        const f = lane.fitLanes(lanes, w);
        assert.strictEqual(f.width, 2 * f.sidePad + f.columns * f.laneW);
        // Below 100 px the padding and then the lane width give way (fix for the review's 40% finding).
        if (w === 0 || w >= 100) {
          assert.strictEqual(f.sidePad, 10, `${lanes}/${w}: pad ${f.sidePad}`);
          assert.ok(f.laneW >= 6 && f.laneW <= 14, `${lanes}/${w}: laneW ${f.laneW}`);
          assert.ok(f.nodeR * 2 <= f.laneW, `${lanes}/${w}: node ${f.nodeR} overlaps lane ${f.laneW}`);
        }
        if (f.edgeLane >= 0) {
          assert.strictEqual(f.edgeLane, f.columns - 1);
          assert.ok(f.columns < Math.max(1, lanes), "cut only when lanes do not fit");
        } else assert.strictEqual(f.columns, Math.max(1, lanes));
      }
    }
  });

  it("never wider than 40% of a laid-out list, even a very narrow one", () => {
    const bad: string[] = [];
    for (const w of [1, 20, 40, 60, 79, 80]) {
      const f = lane.fitLanes(50, w);
      // At least 1 px is drawn: a 1 px list allows 0.4 px.
      if (f.width > Math.max(1, Math.floor(w * 0.4))) bad.push(`${w}px list -> ${f.width}px graph`);
    }
    assert.deepStrictEqual(bad, []);
  });

  it("not laid out (0, NaN, negative) falls back to the 220 px limit", () => {
    for (const w of [0, NaN, -5]) assert.ok(lane.fitLanes(100, w).width <= 220);
  });
});
