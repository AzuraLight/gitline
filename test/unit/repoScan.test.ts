import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  existingRecent,
  normalizeRecent,
  pushRecent,
  repoLabel,
  scanRepositories,
} from "../../src/repoScan";

/** A folder tree for one test; `.git` marks a repository (a directory, or a file for worktrees). */
function tree(spec: Record<string, "repo" | "worktree" | "dir">): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitline-scan-")));
  for (const [rel, kind] of Object.entries(spec)) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    if (kind === "repo") fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    if (kind === "worktree") fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  }
  return root;
}

const rel = (root: string, list: string[]) => list.map((p) => path.relative(root, p) || ".");

describe("repository scan", () => {
  let root: string;
  before(() => {
    // The layout behind the report: a parent folder that is no repository, repos one and two levels down.
    root = tree({
      "teachers-class-fe": "repo",
      "research/json-editor": "repo",
      "research/json-viewer": "repo",
      "research/text-editor": "repo",
      "research/deep/deeper/too-deep": "repo",
      "web/node_modules/some-pkg": "repo",
      ".cache/hidden-repo": "repo",
      "assets": "dir",
      "wt/feature-worktree": "worktree",
      "teachers-class-fe/vendor/submodule": "repo",
    });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds repositories one and two levels down (default depth 2), not the parent", async () => {
    const found = rel(root, await scanRepositories([root], { depth: 2, ignored: ["node_modules"] }));
    assert.deepStrictEqual(found, [
      "research/json-editor",
      "research/json-viewer",
      "research/text-editor",
      "teachers-class-fe",
      "wt/feature-worktree", // a worktree / submodule checkout has a .git *file*
    ]);
  });

  it("depth 1 behaves like VS Code's default scan, depth 0 checks only the root", async () => {
    assert.deepStrictEqual(rel(root, await scanRepositories([root], { depth: 1, ignored: [] })), ["teachers-class-fe"]);
    assert.deepStrictEqual(await scanRepositories([root], { depth: 0, ignored: [] }), []);
    // A workspace folder that is itself a repository is found at depth 0.
    assert.deepStrictEqual(rel(root, await scanRepositories([path.join(root, "teachers-class-fe")], { depth: 0, ignored: [] })), ["teachers-class-fe"]);
  });

  it("enters repositories, so submodules and nested clones show up at enough depth", async () => {
    const found = rel(root, await scanRepositories([root], { depth: 3, ignored: ["node_modules"] }));
    assert.ok(found.includes("teachers-class-fe/vendor/submodule"), found.join(", "));
  });

  it("skips ignored names and hidden folders, and honours a larger depth", async () => {
    const found = rel(root, await scanRepositories([root], { depth: 4, ignored: ["node_modules"] }));
    assert.ok(found.includes("research/deep/deeper/too-deep"));
    assert.ok(!found.some((p) => p.includes("node_modules")), "node_modules not entered");
    assert.ok(!found.some((p) => p.startsWith(".cache")), "hidden folders not entered");
    const withNm = rel(root, await scanRepositories([root], { depth: 2, ignored: [] }));
    assert.ok(withNm.includes("web/node_modules/some-pkg") === false, "depth still applies (it is 3 levels down)");
  });

  it("does not follow symbolic links (no loops, no escaping the workspace)", async function () {
    const loop = path.join(root, "research", "loop");
    try {
      fs.symlinkSync(root, loop, "dir");
    } catch {
      this.skip(); // Windows without symlink rights
    }
    try {
      const found = rel(root, await scanRepositories([root], { depth: 6, ignored: ["node_modules"] }));
      assert.ok(!found.some((p) => p.includes("loop")), found.join(", "));
    } finally {
      fs.rmSync(loop, { force: true });
    }
  });

  it("stops at the folder budget instead of walking a huge tree", async () => {
    const found = await scanRepositories([root], { depth: 8, ignored: [], maxDirs: 2 });
    assert.ok(found.length <= 2);
  });

  it("survives missing roots, junk options and duplicate roots", async () => {
    const missing = path.join(root, "does-not-exist");
    assert.deepStrictEqual(await scanRepositories([missing], { depth: 2, ignored: [] }), []);
    const twice = await scanRepositories([root, root, path.join(root, ".")], { depth: 1, ignored: [] });
    assert.deepStrictEqual(rel(root, twice), ["teachers-class-fe"]);
    const junk = await scanRepositories([root], { depth: Number.NaN, ignored: undefined as unknown as string[] });
    assert.ok(rel(root, junk).includes("research/json-editor"), "NaN depth falls back to the default (2)");
    const huge = await scanRepositories([root], { depth: 99, ignored: ["node_modules"] });
    assert.ok(rel(root, huge).includes("research/deep/deeper/too-deep"), "depth is capped, not rejected");
  });
});

describe("recent repositories", () => {
  it("moves a repository to the front, without duplicates, capped", () => {
    assert.deepStrictEqual(pushRecent([], "/a"), [path.resolve("/a")]);
    assert.deepStrictEqual(pushRecent(["/a", "/b", "/c"].map((p) => path.resolve(p)), "/b"), ["/b", "/a", "/c"].map((p) => path.resolve(p)));
    const many = Array.from({ length: 12 }, (_, i) => path.resolve(`/r${i}`));
    assert.strictEqual(pushRecent(many, "/new").length, 10);
    assert.strictEqual(pushRecent(many, "/new")[0], path.resolve("/new"));
  });

  it("cleans a stored value: strings only, resolved, de-duplicated, capped", () => {
    assert.deepStrictEqual(normalizeRecent(["/a", "/a/", 3, "", null, "/b"]), ["/a", "/b"].map((p) => path.resolve(p)));
    assert.deepStrictEqual(normalizeRecent("nope"), []);
    assert.strictEqual(normalizeRecent(Array.from({ length: 30 }, (_, i) => `/x${i}`)).length, 10);
  });

  it("drops entries that are no longer repositories", async () => {
    const root = tree({ keep: "repo", gone: "dir" });
    try {
      const kept = await existingRecent([path.join(root, "keep"), path.join(root, "gone"), path.join(root, "missing")]);
      assert.deepStrictEqual(kept, [path.join(root, "keep")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("picker labels", () => {
  const ws = path.resolve("/work/teachers");
  it("names a repository by its folder and shows where it sits in the workspace", () => {
    assert.deepStrictEqual(repoLabel(path.join(ws, "research", "json-editor"), [ws]), { name: "json-editor", detail: path.join("teachers", "research") });
    assert.deepStrictEqual(repoLabel(path.join(ws, "teachers-class-fe"), [ws]), { name: "teachers-class-fe", detail: "teachers" });
    assert.deepStrictEqual(repoLabel(ws, [ws]), { name: "teachers", detail: "" });
  });

  it("outside the workspace, shows the parent directory", () => {
    const other = path.resolve("/elsewhere/clones/json-editor");
    assert.deepStrictEqual(repoLabel(other, [ws]), { name: "json-editor", detail: path.resolve("/elsewhere/clones") });
    // A sibling whose name starts like the workspace folder is not "inside" it.
    const sibling = path.resolve("/work/teachers-old/repo");
    assert.strictEqual(repoLabel(sibling, [ws]).detail, path.resolve("/work/teachers-old"));
  });
});
