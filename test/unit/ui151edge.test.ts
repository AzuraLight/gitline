// Edge cases for the 1.5.1 pure webview modules and the --decorate=full parsing, end to end.
import * as assert from "assert";
import * as path from "path";
import { parseDecorate, readRecentCommits } from "../../src/gitExec";
import { ALL_REFS } from "../../src/viewSelection";
import { TempRepo } from "../helpers/tempRepo";

/* eslint-disable @typescript-eslint/no-require-imports */
const media = (f: string) => path.resolve(__dirname, "../../../media/webview", f);
type Ref = { label: string; kind: string };
type Chip = { label: string; kind: string; remotes: string[] };
const refChips = require(media("refChips.js")) as {
  groupRefs: (refs: Ref[]) => Chip[];
  splitInline: (chips: Chip[], max?: number) => { shown: Chip[]; hidden: Chip[] };
  describe: (c: Chip) => string;
};
const nav = require(media("commitNav.js")) as {
  stepIndex: (from: number, key: string, count: number, page: number) => number;
  parentIndex: (commits: { hash: string; parents?: string[] }[], i: number, idx: Record<string, number>) => number;
  childIndex: (commits: { hash: string; parents?: string[] }[], i: number) => number;
};
const layoutMath = (require(media("layout.js")) as {
  layoutMath: {
    clamp: (w: number, min: number, max: number) => number;
    normalize: (raw: unknown) => { sidebarW: number; previewW: number; collapsed: Record<string, boolean> };
    toggleCollapsed: (c: Record<string, boolean>, pane: string) => Record<string, boolean>;
  };
}).layoutMath;
const util = require(media("util.js")) as { formatTime: (sec: number, lang?: string, now?: number) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

const kl = (chips: Chip[]) => chips.map((c) => `${c.kind}:${c.label}${c.remotes.length ? "<" + c.remotes.join("+") : ""}`);

describe("ref labels — edge cases", () => {
  it("remote-only refs stay remote labels, origin/HEAD still dropped", () => {
    assert.deepStrictEqual(kl(refChips.groupRefs([
      { label: "origin/main", kind: "remote" }, { label: "upstream/main", kind: "remote" }, { label: "origin/HEAD", kind: "remote" },
    ])), ["remote:origin/main", "remote:upstream/main"]);
  });

  it("folds several remotes into one local, in input order, and leaves an unrelated remote", () => {
    assert.deepStrictEqual(kl(refChips.groupRefs([
      { label: "upstream/dev", kind: "remote" }, { label: "dev", kind: "local" },
      { label: "origin/dev", kind: "remote" }, { label: "origin/other", kind: "remote" },
    ])), ["local:dev<upstream+origin", "remote:origin/other"]);
  });

  it("a tag named like a branch does not absorb the remote; the local does", () => {
    assert.deepStrictEqual(kl(refChips.groupRefs([
      { label: "main", kind: "tag" }, { label: "main", kind: "local" }, { label: "origin/main", kind: "remote" },
    ])), ["tag:main", "local:main<origin"]);
    // tag only: the remote is kept as its own label
    assert.deepStrictEqual(kl(refChips.groupRefs([{ label: "main", kind: "tag" }, { label: "origin/main", kind: "remote" }])),
      ["tag:main", "remote:origin/main"]);
  });

  it("detached HEAD plus branches: HEAD first, branches still fold their remotes", () => {
    assert.deepStrictEqual(kl(refChips.groupRefs([
      { label: "origin/main", kind: "remote" }, { label: "main", kind: "local" }, { label: "HEAD", kind: "head" },
    ])), ["head:HEAD", "local:main<origin"]);
  });

  it("remote label without a slash is kept and a local with a slash folds origin/<it>", () => {
    assert.deepStrictEqual(kl(refChips.groupRefs([{ label: "lonely", kind: "remote" }])), ["remote:lonely"]);
    assert.deepStrictEqual(kl(refChips.groupRefs([
      { label: "feature/a/b", kind: "local" }, { label: "origin/feature/a/b", kind: "remote" },
    ])), ["local:feature/a/b<origin"]);
  });

  it("very long names pass through untouched; describe lists remotes", () => {
    const long = "feature/" + "x".repeat(500);
    const chips = refChips.groupRefs([{ label: long, kind: "head" }, { label: "origin/" + long, kind: "remote" }]);
    assert.strictEqual(chips.length, 1);
    assert.strictEqual(chips[0].label, long);
    assert.strictEqual(refChips.describe(chips[0]), `${long}  ⇄ origin  (HEAD)`);
    assert.strictEqual(refChips.describe({ label: "HEAD", kind: "head", remotes: [] }), "HEAD");
  });

  it("splitInline: never a lone +1 for any size, honours custom max, does not mutate", () => {
    for (let n = 0; n <= 10; n++) {
      const chips = Array.from({ length: n }, (_, i) => ({ label: `b${i}`, kind: "local", remotes: [] }));
      const { shown, hidden } = refChips.splitInline(chips);
      assert.notStrictEqual(hidden.length, 1, `n=${n}`);
      assert.strictEqual(shown.length + hidden.length, n);
      assert.ok(shown.length <= 3);
      assert.strictEqual(chips.length, n);
    }
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `b${i}`, kind: "local", remotes: [] }));
    assert.deepStrictEqual([refChips.splitInline(five, 0).shown.length, refChips.splitInline(five, 0).hidden.length], [0, 5]);
    assert.deepStrictEqual(refChips.splitInline(five, 4).hidden.length, 0);
  });
});

describe("commit list keyboard — edge cases", () => {
  it("single-row list: every key lands on row 0", () => {
    for (const k of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]) {
      assert.strictEqual(nav.stepIndex(0, k, 1, 10), 0, k);
      assert.strictEqual(nav.stepIndex(-1, k, 1, 10), 0, `none ${k}`);
    }
  });

  it("page size 0/negative/undefined behaves like 1; huge page clamps", () => {
    assert.strictEqual(nav.stepIndex(3, "PageDown", 10, 0), 4);
    assert.strictEqual(nav.stepIndex(3, "PageUp", 10, -7), 2);
    assert.strictEqual(nav.stepIndex(3, "PageDown", 10, undefined as unknown as number), 4);
    assert.strictEqual(nav.stepIndex(3, "PageDown", 10, 1e9), 9);
    assert.strictEqual(nav.stepIndex(-1, "PageDown", 3, 50), 2);
    assert.strictEqual(nav.stepIndex(-1, "End", 10, 5), 9);
    assert.strictEqual(nav.stepIndex(-1, "Home", 10, 5), 0);
  });

  it("negative count is empty", () => {
    assert.strictEqual(nav.stepIndex(0, "Home", -3, 5), -1);
  });

  it("parent/child with missing parents arrays and out-of-range rows", () => {
    const commits = [{ hash: "a" }, { hash: "b", parents: [] }];
    assert.strictEqual(nav.parentIndex(commits, 0, { a: 0, b: 1 }), -1);
    assert.strictEqual(nav.parentIndex(commits, 5, {}), -1);
    assert.strictEqual(nav.parentIndex(commits, -1, {}), -1);
    assert.strictEqual(nav.childIndex(commits, 1), -1);
    assert.strictEqual(nav.childIndex(commits, 9), -1);
    assert.strictEqual(nav.childIndex([], 0), -1);
  });

  it("child prefers the nearest same-branch child even when a merge child is nearer", () => {
    // rows newest first: m (merges x into c) is nearer, c continues a on its first parent
    const commits = [{ hash: "c2", parents: ["a"] }, { hash: "m", parents: ["z", "a"] }, { hash: "a", parents: [] }];
    assert.strictEqual(nav.childIndex(commits, 2), 0);
    // only a merge child → that one
    assert.strictEqual(nav.childIndex([{ hash: "m", parents: ["z", "a"] }, { hash: "a", parents: [] }], 1), 0);
  });
});

describe("pane layout values — junk", () => {
  const DEF = { sidebarW: 220, previewW: 0, previewH: 0, collapsed: { sidebar: false, log: false, preview: false } };

  it("rejects strings, NaN, null, arrays and primitives", () => {
    for (const raw of [null, 0, "x", [], true, { sidebarW: "300", previewW: "400" }, { sidebarW: NaN, previewW: NaN },
      { sidebarW: 0, previewW: -1, collapsed: "all" }, { collapsed: null }, { collapsed: [true, true] }]) {
      assert.deepStrictEqual(layoutMath.normalize(raw), DEF, JSON.stringify(raw));
    }
  });

  it("JSON round trip of a saved layout is stable", () => {
    const n = layoutMath.normalize({ sidebarW: 333, previewW: 512, collapsed: { sidebar: true, log: true } });
    assert.deepStrictEqual(layoutMath.normalize(JSON.parse(JSON.stringify(n))), n);
  });

  it("rejects saved widths no screen has (Infinity, 99999) and keeps real ones", () => {
    assert.strictEqual(layoutMath.normalize({ sidebarW: Infinity }).sidebarW, 220);
    assert.strictEqual(layoutMath.normalize({ sidebarW: 99999, previewW: 99999 }).previewW, 0);
    assert.strictEqual(layoutMath.normalize({ sidebarW: 99999 }).sidebarW, 220);
    assert.strictEqual(layoutMath.normalize({ sidebarW: 3000 }).sidebarW, 3000);
    assert.strictEqual(layoutMath.clamp(Infinity, 140, 600), 600);
  });

  it("clamp at the exact bounds and with min == max", () => {
    assert.strictEqual(layoutMath.clamp(140, 140, 600), 140);
    assert.strictEqual(layoutMath.clamp(600, 140, 600), 600);
    assert.strictEqual(layoutMath.clamp(1, 200, 200), 200);
    assert.strictEqual(layoutMath.clamp(-1e9, 140, 600), 140);
  });

  it("toggle never ends with log and preview both collapsed, from any start", () => {
    const bools = [false, true];
    for (const s of bools) for (const l of bools) for (const p of bools) {
      for (const pane of ["sidebar", "log", "preview"]) {
        const n = layoutMath.toggleCollapsed({ sidebar: s, log: l, preview: p }, pane);
        if (!(l && p)) assert.ok(!(n.log && n.preview), `${s}${l}${p} ${pane}`);
      }
    }
  });
});

describe("relative commit time — boundaries", () => {
  const now = 2_000_000_000;
  const ago = (s: number, lang = "en") => util.formatTime(now - s, lang, now);

  it("59 s is 'now', 60 s is a minute, 3599 s still minutes, 3600 s an hour", () => {
    assert.strictEqual(ago(59), "now");
    assert.strictEqual(ago(1), "now");
    assert.strictEqual(ago(60), "1m ago");
    assert.strictEqual(ago(3599), "59m ago");
    assert.strictEqual(ago(3600), "1h ago");
    assert.strictEqual(ago(86399), "23h ago");
    assert.strictEqual(ago(86400), "yesterday");
    assert.strictEqual(ago(86400 * 2), "2d ago");
  });

  it("far-future and fractional timestamps do not go negative", () => {
    assert.strictEqual(util.formatTime(now + 1e7, "en", now), "now");
    assert.strictEqual(util.formatTime(now - 120.9, "en", now), "2m ago");
  });

  it("odd language values fall back without throwing", () => {
    for (const lang of ["", "zz", "en-US-x-whatever", "@@", "ko-KR"]) {
      assert.doesNotThrow(() => ago(360, lang));
      assert.ok(ago(360, lang).length > 0, lang);
    }
    assert.strictEqual(ago(360, ""), "6m ago"); // empty → <html lang> → "en" under Node
  });
});

describe("decorations end to end in a real repository", () => {
  let repo: TempRepo;
  let first: string;
  before(function () {
    this.timeout(20000);
    repo = new TempRepo();
    first = repo.commitEmpty("one");
    repo.git("branch", "feature/x");
    repo.git("update-ref", "refs/remotes/origin/main", first);
    repo.git("update-ref", "refs/remotes/origin/feature/x", first);
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    repo.git("tag", "-a", "-m", "annotated", "v1");
    repo.git("tag", "main"); // a tag named like a branch
    repo.git("update-ref", "refs/stash", first);
    repo.commitEmpty("two");
  });
  after(() => repo.dispose());

  it("classifies a slash branch, remotes, tags and stash; groups them on the row", async () => {
    const rows = await readRecentCommits(repo.root, 10, ALL_REFS);
    const row = rows.find((r) => r.hash === first)!;
    assert.ok(row, "first commit loaded");
    const got = row.refs.map((r) => `${r.kind}:${r.label}`).sort();
    assert.deepStrictEqual(got, [
      "local:feature/x", "other:stash", "remote:origin/HEAD", "remote:origin/feature/x", "remote:origin/main",
      "tag:main", "tag:v1",
    ].sort());
    assert.deepStrictEqual(kl(refChips.groupRefs(row.refs)).slice(0, 3).map((s) => s.split(":")[0]), ["tag", "tag", "local"]);
    assert.ok(kl(refChips.groupRefs(row.refs)).includes("local:feature/x<origin"));
    assert.ok(kl(refChips.groupRefs(row.refs)).includes("remote:origin/main"), "no local main here → stays remote");
    const head = rows[0];
    assert.deepStrictEqual(head.refs, [{ label: "main", kind: "head" }]);
  });

  it("detached HEAD shows HEAD plus the branch as local", async () => {
    repo.git("checkout", "-q", "--detach");
    try {
      const rows = await readRecentCommits(repo.root, 5);
      assert.deepStrictEqual(rows[0].refs, [{ label: "HEAD", kind: "head" }, { label: "main", kind: "local" }]);
    } finally {
      repo.git("checkout", "-q", "main");
    }
  });

  // git allows "," (but never a space) in ref names; decorations are joined with ", ".
  it("keeps a branch with a comma in its name as one label", () => {
    assert.deepStrictEqual(parseDecorate("refs/heads/a,b"), [{ label: "a,b", kind: "local" }]);
    assert.deepStrictEqual(parseDecorate("HEAD -> refs/heads/x,y, refs/remotes/origin/x,y, tag: refs/tags/v,1"), [
      { label: "x,y", kind: "head" },
      { label: "origin/x,y", kind: "remote" },
      { label: "v,1", kind: "tag" },
    ]);
  });
});
