import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseDecorate } from "../../src/gitExec";
import { ALL_REFS } from "../../src/viewSelection";
import { errorMessage } from "../../src/errors";

// Webview modules are plain browser JS that also export under Node.
/* eslint-disable @typescript-eslint/no-require-imports */
const media = (f: string) => path.resolve(__dirname, "../../../media/webview", f);
type Chip = { label: string; kind: string; remotes: string[] };
const refChips = require(media("refChips.js")) as {
  groupRefs: (refs: { label: string; kind: string }[]) => Chip[];
  splitInline: (chips: Chip[], max?: number) => { shown: Chip[]; hidden: Chip[] };
  describe: (c: Chip) => string;
};
const nav = require(media("commitNav.js")) as {
  stepIndex: (from: number, key: string, count: number, page: number) => number;
  parentIndex: (commits: { hash: string; parents: string[] }[], i: number, idx: Record<string, number>) => number;
  childIndex: (commits: { hash: string; parents: string[] }[], i: number) => number;
};
const layoutMath = (require(media("layout.js")) as {
  layoutMath: {
    clamp: (w: number, min: number, max: number) => number;
    normalize: (raw: unknown) => { sidebarW: number; previewW: number; collapsed: Record<string, boolean> };
    toggleCollapsed: (c: Record<string, boolean>, pane: string) => Record<string, boolean>;
    effectiveCollapsed: (c: Record<string, boolean>, width: number, opened: Record<string, boolean>) => Record<string, boolean>;
  };
}).layoutMath;
const util = require(media("util.js")) as { formatTime: (sec: number, lang?: string, now?: number) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

describe("ref labels on a row", () => {
  it("folds a remote into the local branch of the same name and drops origin/HEAD", () => {
    const chips = refChips.groupRefs([
      { label: "main", kind: "head" },
      { label: "origin/main", kind: "remote" },
      { label: "origin/HEAD", kind: "remote" },
      { label: "upstream/main", kind: "remote" },
    ]);
    assert.deepStrictEqual(chips, [{ label: "main", kind: "head", remotes: ["origin", "upstream"] }]);
  });

  it("keeps a remote whose local branch is elsewhere, and a local with a slash stays local", () => {
    const chips = refChips.groupRefs([
      { label: "origin/feature/x", kind: "remote" },
      { label: "chore/code-cleanup", kind: "local" },
      { label: "v1", kind: "tag" },
    ]);
    assert.deepStrictEqual(chips.map((c) => `${c.kind}:${c.label}`), ["tag:v1", "local:chore/code-cleanup", "remote:origin/feature/x"]);
  });

  it("orders HEAD, tags, locals, remotes, others and keeps input order within a kind", () => {
    const chips = refChips.groupRefs([
      { label: "origin/z", kind: "remote" },
      { label: "v2", kind: "tag" },
      { label: "b", kind: "local" },
      { label: "stash", kind: "other" },
      { label: "a", kind: "local" },
      { label: "HEAD", kind: "head" },
      { label: "weird", kind: "unknown-kind" },
    ]);
    assert.deepStrictEqual(chips.map((c) => c.label), ["HEAD", "v2", "b", "a", "origin/z", "stash", "weird"]);
    assert.strictEqual(chips[6].kind, "other");
  });

  it("does not fold into a detached HEAD, and ignores junk entries", () => {
    const chips = refChips.groupRefs([{ label: "HEAD", kind: "head" }, { label: "origin/HEAD", kind: "remote" },
      null as unknown as { label: string; kind: string }, { kind: "local" } as unknown as { label: string; kind: string }]);
    assert.deepStrictEqual(chips, [{ label: "HEAD", kind: "head", remotes: [] }]);
    assert.deepStrictEqual(refChips.groupRefs(undefined as unknown as []), []);
  });

  it("shows two labels inline and collapses the rest — but never into a lone +1", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `b${i}`, kind: "local", remotes: [] }));
    assert.deepStrictEqual(refChips.splitInline(mk(3)).hidden.length, 0);
    const four = refChips.splitInline(mk(4));
    assert.deepStrictEqual([four.shown.length, four.hidden.length], [2, 2]);
    assert.deepStrictEqual(refChips.splitInline([]).shown, []);
  });

  it("describes a label for tooltips", () => {
    assert.strictEqual(refChips.describe({ label: "main", kind: "head", remotes: ["origin"] }), "main  ⇄ origin  (HEAD)");
    assert.strictEqual(refChips.describe({ label: "v1", kind: "tag", remotes: [] }), "v1  (tag)");
  });
});

describe("decorations with full ref names", () => {
  it("tells local branches with a slash from remote ones", () => {
    assert.deepStrictEqual(
      parseDecorate("HEAD -> refs/heads/chore/code-cleanup, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.4.0, refs/heads/fix/editor"),
      [
        { label: "chore/code-cleanup", kind: "head" },
        { label: "origin/main", kind: "remote" },
        { label: "origin/HEAD", kind: "remote" },
        { label: "v1.4.0", kind: "tag" },
        { label: "fix/editor", kind: "local" },
      ],
    );
  });

  it("handles a detached HEAD, stash and notes refs, and empty input", () => {
    assert.deepStrictEqual(parseDecorate("HEAD, refs/stash, refs/notes/commits"), [
      { label: "HEAD", kind: "head" },
      { label: "stash", kind: "other" },
      { label: "notes/commits", kind: "other" },
    ]);
    assert.deepStrictEqual(parseDecorate(""), []);
    assert.deepStrictEqual(parseDecorate(" , "), []);
  });
});

describe("keyboard movement in the commit list", () => {
  it("steps, pages and jumps, clamped to the list", () => {
    assert.strictEqual(nav.stepIndex(3, "ArrowDown", 10, 5), 4);
    assert.strictEqual(nav.stepIndex(9, "ArrowDown", 10, 5), 9);
    assert.strictEqual(nav.stepIndex(0, "ArrowUp", 10, 5), 0);
    assert.strictEqual(nav.stepIndex(3, "PageDown", 10, 5), 8);
    assert.strictEqual(nav.stepIndex(8, "PageDown", 10, 5), 9);
    assert.strictEqual(nav.stepIndex(3, "PageUp", 10, 5), 0);
    assert.strictEqual(nav.stepIndex(3, "Home", 10, 5), 0);
    assert.strictEqual(nav.stepIndex(3, "End", 10, 5), 9);
    assert.strictEqual(nav.stepIndex(3, "x", 10, 5), -1);
    assert.strictEqual(nav.stepIndex(0, "ArrowDown", 0, 5), -1);
  });

  it("starts from the top or the bottom when nothing is selected", () => {
    assert.strictEqual(nav.stepIndex(-1, "ArrowDown", 10, 5), 0);
    assert.strictEqual(nav.stepIndex(-1, "ArrowUp", 10, 5), 9);
    assert.strictEqual(nav.stepIndex(-1, "PageDown", 10, 5), 4);
  });

  it("follows the first parent down and the same-branch child up", () => {
    // m merges f into b; f and b both come from a.
    const commits = [
      { hash: "m", parents: ["b", "f"] },
      { hash: "f", parents: ["a"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ];
    const idx = { m: 0, f: 1, b: 2, a: 3 };
    assert.strictEqual(nav.parentIndex(commits, 0, idx), 2); // first parent, not the merged branch
    assert.strictEqual(nav.parentIndex(commits, 3, idx), -1); // root
    assert.strictEqual(nav.parentIndex([{ hash: "x", parents: ["not-loaded"] }], 0, {}), -1);
    assert.strictEqual(nav.childIndex(commits, 2), 0); // b → m (m's first parent)
    assert.strictEqual(nav.childIndex(commits, 1), 0); // f → m (only via the merge)
    assert.strictEqual(nav.childIndex(commits, 3), 2); // a → b: nearest first-parent child wins over f
    assert.strictEqual(nav.childIndex(commits, 0), -1);
  });
});

describe("pane layout values", () => {
  it("normalizes saved layouts, including junk and pre-1.5.1 state", () => {
    assert.deepStrictEqual(layoutMath.normalize(undefined), {
      sidebarW: 220, previewW: 0, collapsed: { sidebar: false, log: false, preview: false },
    });
    const n = layoutMath.normalize({ sidebarW: 300.6, previewW: -5, collapsed: { log: true, preview: true, sidebar: "yes" } });
    assert.deepStrictEqual(n, { sidebarW: 301, previewW: 0, collapsed: { sidebar: false, log: true, preview: false } });
  });

  it("never collapses the graph and the preview together", () => {
    const none = { sidebar: false, log: false, preview: false };
    const logShut = layoutMath.toggleCollapsed(none, "log");
    assert.deepStrictEqual(logShut, { sidebar: false, log: true, preview: false });
    assert.deepStrictEqual(layoutMath.toggleCollapsed(logShut, "preview"), { sidebar: false, log: false, preview: true });
    assert.deepStrictEqual(layoutMath.toggleCollapsed(none, "sidebar"), { sidebar: true, log: false, preview: false });
    assert.deepStrictEqual(none, { sidebar: false, log: false, preview: false }, "input left untouched");
  });

  it("folds the preview below 640 px and the branch list below 420 px, never the graph", () => {
    const open = { sidebar: false, log: false, preview: false };
    const eff = layoutMath.effectiveCollapsed;
    assert.deepStrictEqual(eff(open, 1200, {}), open);
    assert.deepStrictEqual(eff(open, 640, {}), open, "640 is wide enough");
    assert.deepStrictEqual(eff(open, 639, {}), { sidebar: false, log: false, preview: true });
    assert.deepStrictEqual(eff(open, 419, {}), { sidebar: true, log: false, preview: true });
    assert.deepStrictEqual(eff(open, 0, {}), open, "not laid out yet: fold nothing");
    // The graph was collapsed by the user; folding the preview must bring the graph back.
    assert.deepStrictEqual(eff({ sidebar: false, log: true, preview: false }, 500, {}), { sidebar: false, log: false, preview: true });
  });

  it("keeps a pane the user opened by hand while the panel is narrow, and the saved choice untouched", () => {
    const saved = { sidebar: false, log: false, preview: false };
    const eff = layoutMath.effectiveCollapsed;
    assert.deepStrictEqual(eff(saved, 600, { preview: true }), { sidebar: false, log: false, preview: false });
    // Too narrow for graph and preview side by side: the hand-opened preview replaces the graph.
    assert.deepStrictEqual(eff(saved, 400, { preview: true }), { sidebar: true, log: true, preview: false });
    assert.deepStrictEqual(eff(saved, 294, { preview: true, sidebar: true }), { sidebar: false, log: true, preview: false });
    assert.deepStrictEqual(eff(saved, 466, { preview: true }), { sidebar: false, log: false, preview: false }, "both fit at 466");
    // A pane the user collapsed stays collapsed at any width.
    assert.deepStrictEqual(eff({ sidebar: true, log: false, preview: false }, 1200, {}), { sidebar: true, log: false, preview: false });
    assert.deepStrictEqual(saved, { sidebar: false, log: false, preview: false }, "input not mutated");
  });

  it("clamps widths, preferring the minimum when space runs out", () => {
    assert.strictEqual(layoutMath.clamp(50, 140, 600), 140);
    assert.strictEqual(layoutMath.clamp(900, 140, 600), 600);
    assert.strictEqual(layoutMath.clamp(300.4, 140, 600), 300);
    assert.strictEqual(layoutMath.clamp(300, 140, 100), 140);
  });
});

describe("errorMessage", () => {
  // Every catch block reports through this; it once recursed into itself (stack overflow on any git error).
  it("returns the message of an Error and stringifies anything else", () => {
    assert.strictEqual(errorMessage(new Error("git failed")), "git failed");
    assert.strictEqual(errorMessage("plain"), "plain");
    assert.strictEqual(errorMessage(42), "42");
    assert.strictEqual(errorMessage(undefined), "undefined");
  });
});

describe("constants shared by the host and the webview", () => {
  it("uses the same All-branches view id on both sides", () => {
    // The webview cannot import TS, so the value is written twice; this keeps them equal.
    const js = fs.readFileSync(media("branchTree.js"), "utf8");
    const m = js.match(/GV\.ALL_REFS\s*=\s*"([^"]+)"/);
    assert.ok(m, "GV.ALL_REFS assignment found in branchTree.js");
    assert.strictEqual(m![1], ALL_REFS);
  });
});

describe("relative commit time", () => {
  const now = 2_000_000_000;
  const ago = (s: number, lang: string) => util.formatTime(now - s, lang, now);

  it("speaks the UI language", () => {
    assert.strictEqual(ago(360, "ko"), "6분 전");
    assert.strictEqual(ago(86400 * 3, "ko"), "3일 전");
    assert.strictEqual(ago(360, "ja"), "6分前");
  });

  it("keeps English numbers short, with words only for now and yesterday", () => {
    assert.strictEqual(ago(360, "en"), "6m ago");
    assert.strictEqual(ago(3600 * 17, "en"), "17h ago");
    assert.strictEqual(ago(86400, "en"), "yesterday");
    assert.strictEqual(ago(86400 * 2, "en"), "2d ago");
    assert.strictEqual(ago(86400 * 31, "en"), "1mo ago"); // not "last mo."
    assert.strictEqual(ago(86400 * 95, "en"), "3mo ago");
    assert.strictEqual(ago(86400 * 366, "en"), "1y ago"); // not "last yr."
    assert.strictEqual(ago(86400 * 800, "en"), "2y ago");
    assert.strictEqual(ago(5, "en"), "now");
  });

  it("uses the unit boundaries 60 s / 1 h / 1 d", () => {
    assert.strictEqual(ago(59, "en"), "now");
    assert.strictEqual(ago(60, "en"), "1m ago");
    assert.strictEqual(ago(3599, "en"), "59m ago");
    assert.strictEqual(ago(3600, "en"), "1h ago");
    assert.strictEqual(ago(86399, "en"), "23h ago");
  });

  it("falls back to English for an unknown language tag, and handles empty and future times", () => {
    assert.strictEqual(ago(360, "!!not-a-locale"), "6m ago");
    assert.strictEqual(util.formatTime(0, "en", now), "");
    assert.strictEqual(util.formatTime(now + 500, "en", now), "now");
  });
});
