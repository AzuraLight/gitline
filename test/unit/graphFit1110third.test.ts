import * as assert from "assert";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const lane = require(path.resolve(__dirname, "../../../media/webview/laneLayout.js")) as {
  fitLanes: (total: number, listWidth: number) => {
    laneW: number; nodeR: number; sidePad: number; columns: number; edgeLane: number; width: number;
  };
};

/**
 * Third 1.11.0 review. commitList.js's ResizeObserver re-renders when laneW, edgeLane, columns,
 * sidePad or width differ (width was missing: 14 -> 15 px kept the graph hidden). Two fits equal
 * in those fields must be equal in everything, or a change would go unnoticed.
 */
describe("1.11.0 third review: resize change detection", () => {
  it("fits equal in every field the ResizeObserver compares are equal in everything", () => {
    const bad: string[] = [];
    for (const lanes of [1, 2, 5, 40]) {
      for (let a = 1; a <= 400; a++) {
        for (let b = a + 1; b <= 400; b++) {
          const fa = lane.fitLanes(lanes, a), fb = lane.fitLanes(lanes, b);
          const same = fa.laneW === fb.laneW && fa.edgeLane === fb.edgeLane && fa.columns === fb.columns &&
            fa.sidePad === fb.sidePad && fa.width === fb.width;
          if (same && JSON.stringify(fa) !== JSON.stringify(fb)) { bad.push(`lanes=${lanes} ${a}px->${b}px ${JSON.stringify(fa)} vs ${JSON.stringify(fb)}`); break; }
        }
      }
    }
    assert.deepStrictEqual(bad.slice(0, 5), []);
  });
});
