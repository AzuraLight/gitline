import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// Webview modules are plain browser JS that also export under Node.
/* eslint-disable @typescript-eslint/no-require-imports */
const media = (f: string) => path.resolve(__dirname, "../../../media/webview", f);
type Prefs = {
  columns: { author: boolean; date: boolean; sha: boolean };
  dateFormat: string;
  detailsLocation: string;
  highlightCurrentBranch: boolean;
};
const display = require(media("display.js")) as {
  COLUMNS: string[];
  DEFAULTS: Prefs;
  normalize: (raw: unknown) => Prefs;
  formatAbsolute: (sec: number) => string;
  dateText: (sec: number, format: string, util: unknown) => { text: string; title: string };
  resolveLocation: (location: string, width: number, height: number) => string;
  toggleColumn: (columns: Record<string, boolean>, key: string) => Record<string, boolean>;
};
const util = require(media("util.js")) as { formatTime: (s: number) => string; formatTimeFull: (s: number) => string };
const layoutMath = (require(media("layout.js")) as {
  layoutMath: {
    effectiveCollapsed: (c: Record<string, boolean>, w: number, o?: Record<string, boolean>, h?: number, bottom?: boolean) => Record<string, boolean>;
    AUTO_H: number;
    BOTH_FIT_H: number;
  };
}).layoutMath;

const OPEN = { sidebar: false, log: false, preview: false };

describe("display settings (1.7.0)", () => {
  it("defaults match package.json, and normalize(undefined) gives them", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));
    const props = pkg.contributes.configuration.properties ?? pkg.contributes.configuration[0].properties;
    assert.deepStrictEqual(display.normalize(undefined), display.DEFAULTS);
    assert.deepStrictEqual(props["gitline.graph.columns"].default, display.DEFAULTS.columns);
    assert.strictEqual(props["gitline.graph.dateFormat"].default, display.DEFAULTS.dateFormat);
    assert.strictEqual(props["gitline.graph.detailsLocation"].default, display.DEFAULTS.detailsLocation);
    assert.strictEqual(props["gitline.graph.highlightCurrentBranch"].default, display.DEFAULTS.highlightCurrentBranch);
    assert.deepStrictEqual(props["gitline.graph.dateFormat"].enum, ["relative", "absolute"]);
    assert.deepStrictEqual(props["gitline.graph.detailsLocation"].enum, ["auto", "right", "bottom"]);
  });

  it("hand-edited junk falls back per value; only an explicit false hides a column", () => {
    for (const raw of [null, 3, "x", [], { columns: [false] }, { columns: "none" }]) {
      assert.deepStrictEqual(display.normalize(raw), display.DEFAULTS, JSON.stringify(raw));
    }
    const n = display.normalize({
      columns: { author: false, date: 0, sha: "no", extra: false },
      dateFormat: "ABSOLUTE",
      detailsLocation: "left",
      highlightCurrentBranch: "true",
    });
    assert.deepStrictEqual(n, { ...display.DEFAULTS, columns: { author: false, date: true, sha: true } });
    assert.deepStrictEqual(display.normalize({ columns: { sha: false } }).columns, { author: true, date: true, sha: false });
    assert.strictEqual(display.normalize({ detailsLocation: "bottom" }).detailsLocation, "bottom");
    assert.strictEqual(display.normalize({ highlightCurrentBranch: true }).highlightCurrentBranch, true);
  });

  it("toggling a column flips only that one, and ignores unknown keys", () => {
    const all = { author: true, date: true, sha: true };
    assert.deepStrictEqual(display.toggleColumn(all, "date"), { author: true, date: false, sha: true });
    assert.deepStrictEqual(display.toggleColumn({ author: false } as Record<string, boolean>, "author"), all);
    assert.deepStrictEqual(display.toggleColumn(all, "bogus"), all);
    let c: Record<string, boolean> = all;
    for (const k of display.COLUMNS) c = display.toggleColumn(c, k);
    assert.deepStrictEqual(c, { author: false, date: false, sha: false }, "all may be hidden");
  });

  it("absolute dates are local YYYY-MM-DD HH:mm, empty for missing values", () => {
    const d = new Date(2026, 0, 5, 7, 3, 59); // local time
    assert.strictEqual(display.formatAbsolute(d.getTime() / 1000), "2026-01-05 07:03");
    assert.strictEqual(display.formatAbsolute(new Date(2026, 11, 31, 23, 59).getTime() / 1000), "2026-12-31 23:59");
    assert.strictEqual(display.formatAbsolute(0), "");
    assert.strictEqual(display.formatAbsolute(Number.NaN), "");
  });

  it("the chosen format shows and the other one is in the tooltip", () => {
    const sec = Math.floor(Date.now() / 1000) - 3 * 3600;
    const rel = display.dateText(sec, "relative", util);
    assert.strictEqual(rel.text, util.formatTime(sec));
    assert.strictEqual(rel.title, util.formatTimeFull(sec));
    const abs = display.dateText(sec, "absolute", util);
    assert.strictEqual(abs.text, display.formatAbsolute(sec));
    assert.ok(abs.title.startsWith(util.formatTime(sec)), abs.title);
    assert.deepStrictEqual(display.dateText(0, "absolute", util), { text: "", title: "" });
  });

  it("auto puts the details below the graph only in a narrow, tall panel", () => {
    assert.strictEqual(display.resolveLocation("auto", 1200, 400), "right");
    assert.strictEqual(display.resolveLocation("auto", 500, 600), "bottom");
    assert.strictEqual(display.resolveLocation("auto", 500, 300), "bottom");
    assert.strictEqual(display.resolveLocation("auto", 500, 299), "right", "too short to split: the preview folds as before");
    assert.strictEqual(display.resolveLocation("auto", 0, 0), "right", "not laid out yet");
    assert.strictEqual(display.resolveLocation("right", 300, 900), "right");
    assert.strictEqual(display.resolveLocation("bottom", 2000, 200), "bottom");
  });
});

describe("pane folding with the details below the graph", () => {
  it("folds the details by height, not width", () => {
    const short = layoutMath.AUTO_H - 1;
    assert.deepStrictEqual(layoutMath.effectiveCollapsed(OPEN, 500, {}, 600, true), OPEN, "narrow but tall: both shown");
    assert.strictEqual(layoutMath.effectiveCollapsed(OPEN, 2000, {}, short, true).preview, true);
    assert.strictEqual(layoutMath.effectiveCollapsed(OPEN, 2000, {}, short, true).log, false);
    // Side by side, the same narrow panel folds the preview (unchanged 1.5.1 behaviour).
    assert.strictEqual(layoutMath.effectiveCollapsed(OPEN, 500, {}, 600, false).preview, true);
  });

  it("a hand-opened preview in a very short panel takes the graph's place", () => {
    const tiny = layoutMath.BOTH_FIT_H - 1;
    const r = layoutMath.effectiveCollapsed(OPEN, 2000, { preview: true }, tiny, true);
    assert.strictEqual(r.preview, false);
    assert.strictEqual(r.log, true);
  });

  it("the branch list still folds by width; height 0 folds nothing", () => {
    assert.strictEqual(layoutMath.effectiveCollapsed(OPEN, 400, {}, 800, true).sidebar, true);
    assert.deepStrictEqual(layoutMath.effectiveCollapsed(OPEN, 1000, {}, 0, true), OPEN);
  });
});
