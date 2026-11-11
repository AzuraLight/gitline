// Edge cases for the 1.7.0 display settings (display.js) and the bottom-details layout math.
import * as assert from "assert";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */
const media = (f: string) => path.resolve(__dirname, "../../../media/webview", f);
type Prefs = {
  columns: { author: boolean; date: boolean; sha: boolean };
  dateFormat: string;
  detailsLocation: string;
  highlightCurrentBranch: boolean;
};
const display = require(media("display.js")) as {
  DEFAULTS: Prefs;
  normalize: (raw: unknown) => Prefs;
  formatAbsolute: (sec: number) => string;
  resolveLocation: (location: string, width: number, height: number) => string;
  toggleColumn: (columns: Record<string, boolean>, key: string) => Record<string, boolean>;
};
const layoutMath = (require(media("layout.js")) as {
  layoutMath: {
    normalize: (raw: unknown) => { sidebarW: number; previewW: number; previewH: number; collapsed: Record<string, boolean> };
    effectiveCollapsed: (c: Record<string, boolean>, w: number, o?: Record<string, boolean>, h?: number, bottom?: boolean) => Record<string, boolean>;
    AUTO_H: number;
    BOTH_FIT_H: number;
  };
}).layoutMath;
/* eslint-enable @typescript-eslint/no-require-imports */

const OPEN = { sidebar: false, log: false, preview: false };
const ABS = /^\d{4}-\d\d-\d\d \d\d:\d\d$/;

describe("display.normalize — odd input", () => {
  it("non-objects give the defaults", () => {
    for (const v of [null, undefined, 0, 1, "", "absolute", true, NaN, [], () => 1, Symbol("x")]) {
      assert.deepStrictEqual(display.normalize(v), display.DEFAULTS, String(v));
    }
  });

  it("__proto__ / constructor keys do not pollute and do not leak", () => {
    const raw = JSON.parse('{"__proto__":{"dateFormat":"absolute","polluted":1},"columns":{"__proto__":{"author":false}},"constructor":{"prototype":{"x":1}}}');
    const out = display.normalize(raw);
    assert.deepStrictEqual(out, display.DEFAULTS);
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
    assert.strictEqual(({} as Record<string, unknown>).author, undefined);
    assert.deepStrictEqual(Object.keys(out.columns), ["author", "date", "sha"]);
  });

  it("inherited values (Object.create) are read like own ones — only explicit false hides", () => {
    const out = display.normalize(Object.create({ dateFormat: "absolute" }));
    // documents current behaviour: prototype values are read
    assert.strictEqual(out.dateFormat, "absolute");
  });

  it("columns as array / string / null → all shown; truthy non-false values show", () => {
    for (const c of [[false, false, false], "author", null, 5]) {
      assert.deepStrictEqual(display.normalize({ columns: c }).columns, { author: true, date: true, sha: true });
    }
    assert.deepStrictEqual(display.normalize({ columns: { author: 0, date: "false", sha: null } }).columns,
      { author: true, date: true, sha: true });
    assert.deepStrictEqual(display.normalize({ columns: { author: false, date: false, sha: false, extra: false } }).columns,
      { author: false, date: false, sha: false });
  });

  it("wrong-case / padded enum strings and non-true booleans fall back", () => {
    const out = display.normalize({ dateFormat: "Absolute", detailsLocation: " bottom", highlightCurrentBranch: "true" });
    assert.deepStrictEqual(out, display.DEFAULTS);
    assert.strictEqual(display.normalize({ highlightCurrentBranch: 1 }).highlightCurrentBranch, false);
  });

  it("returns a fresh object (mutation does not change DEFAULTS)", () => {
    const a = display.normalize(undefined);
    a.columns.author = false;
    assert.strictEqual(display.DEFAULTS.columns.author, true);
    assert.strictEqual(display.normalize(undefined).columns.author, true);
  });

  it("toggleColumn with an unknown / prototype key changes nothing", () => {
    const all = { author: true, date: true, sha: true };
    assert.deepStrictEqual(display.toggleColumn(all, "__proto__"), all);
    assert.deepStrictEqual(display.toggleColumn(all, "constructor"), all);
    assert.deepStrictEqual(display.toggleColumn({}, "sha"), { author: true, date: true, sha: false });
  });
});

describe("display.formatAbsolute — time edges", () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

  it("0, NaN, Infinity, out-of-range → empty", () => {
    for (const v of [0, NaN, Infinity, -Infinity, 8.64e12 + 1, -8.64e12 - 1]) assert.strictEqual(display.formatAbsolute(v), "", String(v));
  });

  it("year boundary in local time", () => {
    assert.strictEqual(display.formatAbsolute(local(2025, 12, 31, 23, 59)), "2025-12-31 23:59");
    assert.strictEqual(display.formatAbsolute(local(2026, 1, 1, 0, 0)), "2026-01-01 00:00");
  });

  it("seconds are truncated, not rounded", () => {
    assert.strictEqual(display.formatAbsolute(local(2026, 1, 1, 0, 0) - 1), "2025-12-31 23:59");
    assert.strictEqual(display.formatAbsolute(local(2026, 1, 1, 0, 0) + 59.9), "2026-01-01 00:00");
  });

  it("DST-ish dates still format as wall time", () => {
    // whatever the TZ, the result must equal the Date's local fields
    for (const s of [Date.UTC(2026, 2, 8, 10, 0) / 1000, Date.UTC(2026, 10, 1, 9, 30) / 1000, Date.UTC(2026, 2, 29, 1, 0) / 1000]) {
      const d = new Date(s * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      assert.strictEqual(display.formatAbsolute(s),
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
  });

  it("negative (pre-1970) timestamps format", () => {
    assert.match(display.formatAbsolute(-86400 * 365), ABS);
  });

  it("very large but valid timestamps: 5-digit year breaks the fixed pattern", () => {
    const s = 8.64e12 / 1000; // max Date
    const out = display.formatAbsolute(s);
    assert.ok(out.length > 0);
    assert.ok(/^\+?\d{5,6}-/.test(out) || ABS.test(out), out);
  });

  it("years < 1000 are not zero-padded (documents behaviour)", () => {
    const s = new Date(50, 0, 1).setFullYear(50) / 1000;
    assert.strictEqual(display.formatAbsolute(s).split("-")[0], "50");
  });
});

describe("display.resolveLocation — thresholds", () => {
  it("explicit values win regardless of size", () => {
    assert.strictEqual(display.resolveLocation("right", 100, 2000), "right");
    assert.strictEqual(display.resolveLocation("bottom", 2000, 10), "bottom");
    assert.strictEqual(display.resolveLocation("bottom", 0, 0), "bottom");
  });
  it("auto: 639/300 bottom, 640 right, 299 right", () => {
    assert.strictEqual(display.resolveLocation("auto", 639, 300), "bottom");
    assert.strictEqual(display.resolveLocation("auto", 640, 300), "right");
    assert.strictEqual(display.resolveLocation("auto", 639, 299), "right");
    assert.strictEqual(display.resolveLocation("auto", 639.9, 299.9), "right");
    assert.strictEqual(display.resolveLocation("auto", 1, 300), "bottom");
  });
  it("auto: zero / negative / NaN sizes → right; unknown location acts as auto", () => {
    for (const [w, h] of [[0, 800], [500, 0], [-1, 800], [NaN, 800], [500, NaN]]) {
      assert.strictEqual(display.resolveLocation("auto", w, h), "right", `${w}x${h}`);
    }
    assert.strictEqual(display.resolveLocation("left", 500, 800), "bottom");
    assert.strictEqual(display.resolveLocation(undefined as unknown as string, 500, 800), "bottom");
  });
});

describe("layoutMath.effectiveCollapsed — bottom mode boundaries", () => {
  const { AUTO_H, BOTH_FIT_H } = layoutMath;
  const eff = (h: number, opened?: Record<string, boolean>, c: Record<string, boolean> = OPEN, w = 500) =>
    layoutMath.effectiveCollapsed(c, w, opened, h, true);

  it("constants", () => {
    assert.strictEqual(AUTO_H, 300);
    assert.strictEqual(BOTH_FIT_H, 278);
    assert.ok(BOTH_FIT_H < AUTO_H);
  });

  it("folds at AUTO_H-1, not at AUTO_H", () => {
    assert.strictEqual(eff(AUTO_H - 1).preview, true);
    assert.strictEqual(eff(AUTO_H).preview, false);
    assert.strictEqual(eff(AUTO_H - 0.5).preview, true);
  });

  it("height 0 / undefined folds nothing", () => {
    assert.deepStrictEqual(eff(0), { ...OPEN, sidebar: false });
    assert.strictEqual(layoutMath.effectiveCollapsed(OPEN, 500, undefined, undefined, true).preview, false);
  });

  it("width does not fold the details in bottom mode, but still folds the sidebar", () => {
    const r = layoutMath.effectiveCollapsed(OPEN, 300, undefined, 800, true);
    assert.strictEqual(r.preview, false);
    assert.strictEqual(r.sidebar, true);
  });

  it("folding the details brings a collapsed graph back", () => {
    assert.deepStrictEqual(eff(200, undefined, { sidebar: false, log: true, preview: false }), { sidebar: false, log: false, preview: true });
  });

  it("opened.preview below AUTO_H: graph folds below BOTH_FIT_H, stays at BOTH_FIT_H", () => {
    const o = { preview: true };
    assert.deepStrictEqual(eff(BOTH_FIT_H - 1, o), { sidebar: false, log: true, preview: false });
    assert.deepStrictEqual(eff(BOTH_FIT_H, o), { sidebar: false, log: false, preview: false });
    assert.deepStrictEqual(eff(AUTO_H - 1, o), { sidebar: false, log: false, preview: false });
  });

  it("opened.preview with a saved-collapsed preview does not open it", () => {
    const r = eff(BOTH_FIT_H - 1, { preview: true }, { sidebar: false, log: false, preview: true });
    assert.deepStrictEqual(r, { sidebar: false, log: false, preview: true });
  });

  it("right mode is unaffected by height", () => {
    const r = layoutMath.effectiveCollapsed(OPEN, 800, undefined, 10, false);
    assert.deepStrictEqual(r, OPEN);
  });
});

describe("layoutMath.normalize — previewH junk", () => {
  it("rejects junk previewH, keeps valid, rounds", () => {
    for (const v of [-1, 0, NaN, Infinity, "300", null, {}, [300], 4001, true]) {
      assert.strictEqual(layoutMath.normalize({ previewH: v }).previewH, 0, String(v));
    }
    assert.strictEqual(layoutMath.normalize({ previewH: 4000 }).previewH, 4000);
    assert.strictEqual(layoutMath.normalize({ previewH: 250.6 }).previewH, 251);
    assert.strictEqual(layoutMath.normalize({ previewH: 0.4 }).previewH, 0);
  });
  it("previewH does not affect previewW and vice versa", () => {
    const n = layoutMath.normalize({ previewW: 333, previewH: 222 });
    assert.strictEqual(n.previewW, 333);
    assert.strictEqual(n.previewH, 222);
    assert.strictEqual(layoutMath.normalize({ previewH: 222 }).previewW, 0);
  });
  it("old saved layouts without previewH get 0", () => {
    assert.strictEqual(layoutMath.normalize({ sidebarW: 200, previewW: 300 }).previewH, 0);
  });
});
