// Edge cases for the 1.6.0 repository scan, recent list and picker labels (real temp folders).
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { existingRecent, normalizeRecent, pushRecent, repoLabel, scanRepositories } from "../../src/repoScan";

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitline-scanedge-")));
const repo = (root: string, rel: string) => {
  fs.mkdirSync(path.join(root, rel, ".git"), { recursive: true });
  return path.join(root, rel);
};
const rel = (root: string, list: string[]) => list.map((p) => path.relative(root, p) || ".");
const isWin = process.platform === "win32";

describe("repository scan — edge cases", () => {
  let root: string;
  beforeEach(() => (root = mk()));
  afterEach(() => {
    try {
      fs.chmodSync(path.join(root, "locked"), 0o755);
    } catch {
      /* not created */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an empty roots list finds nothing", async () => {
    assert.deepStrictEqual(await scanRepositories([], { depth: 2, ignored: [] }), []);
  });

  it("negative / fractional depth is clamped (−1 → 0, 1.9 → 1)", async () => {
    repo(root, "a");
    repo(root, "b/c");
    assert.deepStrictEqual(await scanRepositories([root], { depth: -1, ignored: [] }), []);
    assert.deepStrictEqual(rel(root, await scanRepositories([root], { depth: 1.9, ignored: [] })), ["a"]);
    assert.deepStrictEqual(rel(root, await scanRepositories([root], { depth: Infinity, ignored: [] })).sort(), ["a", "b/c"]);
  });

  it("depth cap is 8: a repo 9 levels down is never found", async () => {
    repo(root, "1/2/3/4/5/6/7/8");
    repo(root, "1/2/3/4/5/6/7/8/9x/9");
    const found = rel(root, await scanRepositories([root], { depth: 50, ignored: [] }));
    assert.deepStrictEqual(found, ["1/2/3/4/5/6/7/8"]);
  });

  it("maxDirs 0 visits nothing; maxDirs 1 checks only the first root", async () => {
    const r = repo(root, "r");
    assert.deepStrictEqual(await scanRepositories([r], { depth: 2, ignored: [], maxDirs: 0 }), []);
    assert.deepStrictEqual(await scanRepositories([r], { depth: 2, ignored: [], maxDirs: 1 }), [r]);
  });

  it("very wide tree: the budget stops the walk, breadth-first so shallow repos win", async () => {
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(root, `d${String(i).padStart(3, "0")}`, "inner"), { recursive: true });
    repo(root, "d000");
    repo(root, "d299/inner");
    const t0 = Date.now();
    const limited = rel(root, await scanRepositories([root], { depth: 2, ignored: [], maxDirs: 100 }));
    assert.ok(Date.now() - t0 < 5000);
    assert.deepStrictEqual(limited, ["d000"], "level-2 repo is beyond the budget");
    const full = rel(root, await scanRepositories([root], { depth: 2, ignored: [] }));
    assert.deepStrictEqual(full, ["d000", "d299/inner"]);
  });

  it("permission-denied folders are skipped without failing the scan", async function () {
    if (isWin || process.getuid?.() === 0) this.skip();
    repo(root, "ok");
    repo(root, "locked/inside");
    fs.chmodSync(path.join(root, "locked"), 0o000);
    const found = rel(root, await scanRepositories([root], { depth: 3, ignored: [] }));
    assert.deepStrictEqual(found, ["ok"]);
    // A root that cannot be read at all.
    assert.deepStrictEqual(await scanRepositories([path.join(root, "locked")], { depth: 2, ignored: [] }), []);
  });

  it(".git as directory and as file count; a broken .git symlink does not", async function () {
    repo(root, "dir");
    fs.mkdirSync(path.join(root, "file"));
    fs.writeFileSync(path.join(root, "file", ".git"), "gitdir: ../x\n");
    fs.mkdirSync(path.join(root, "broken"));
    try {
      fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "broken", ".git"));
    } catch {
      this.skip();
    }
    assert.deepStrictEqual(rel(root, await scanRepositories([root], { depth: 1, ignored: [] })), ["dir", "file"]);
  });

  // A `.git` that is a symbolic link to a real git directory is a repository for git itself
  // (`git rev-parse` follows it); the scan follows that one link too (it still never walks into links).
  it("a .git symlink pointing at a real git directory is a repository", async function () {
    fs.mkdirSync(path.join(root, "store", "real.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "linked"));
    try {
      fs.symlinkSync(path.join(root, "store", "real.git"), path.join(root, "linked", ".git"), "dir");
    } catch {
      this.skip();
    }
    assert.deepStrictEqual(rel(root, await scanRepositories([root], { depth: 1, ignored: [] })), ["linked"]);
  });

  it("an ignored name blocks everything below it at any depth, but an ignored root itself is scanned", async () => {
    repo(root, "vendor/a");
    repo(root, "x/vendor/b");
    repo(root, "x/y/vendor/c");
    repo(root, "x/vendorish");
    const found = rel(root, await scanRepositories([root], { depth: 4, ignored: ["vendor"] }));
    assert.deepStrictEqual(found, ["x/vendorish"]);
    // The ignore list applies to names entered, not to the roots given.
    const fromIgnored = rel(root, await scanRepositories([path.join(root, "vendor")], { depth: 1, ignored: ["vendor"] }));
    assert.deepStrictEqual(fromIgnored, ["vendor/a"]);
  });

  it("an ignored repository folder itself is not reported", async () => {
    repo(root, "node_modules");
    assert.deepStrictEqual(await scanRepositories([root], { depth: 1, ignored: ["node_modules"] }), []);
  });

  it("names with spaces and unicode", async () => {
    repo(root, "my repo");
    repo(root, "한글 저장소/프로젝트 ✓");
    repo(root, "café");
    const found = rel(root, await scanRepositories([root], { depth: 2, ignored: [] }));
    assert.deepStrictEqual(found.sort(), ["café", "my repo", "한글 저장소/프로젝트 ✓"].sort());
  });

  it("roots with trailing separators and relative roots resolve to the same absolute paths", async () => {
    const a = repo(root, "a");
    const trailing = await scanRepositories([root + path.sep], { depth: 1, ignored: [] });
    assert.deepStrictEqual(trailing, [a]);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      assert.deepStrictEqual(await scanRepositories(["."], { depth: 1, ignored: [] }), [a]);
      assert.deepStrictEqual(await scanRepositories(["a"], { depth: 0, ignored: [] }), [a]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("overlapping roots (one inside another) report each repository once", async () => {
    repo(root, "outer/inner/r1");
    repo(root, "outer/r0");
    const found = rel(root, await scanRepositories([root, path.join(root, "outer"), path.join(root, "outer", "inner")], { depth: 1, ignored: [] }));
    // depth counts from each root: outer/r0 (1 below "outer") and outer/inner/r1 (1 below "inner").
    assert.deepStrictEqual(found, ["outer/inner/r1", "outer/r0"]);
  });

  it("overlapping roots: inner root listed first does not hide deeper repositories of the outer root", async () => {
    repo(root, "outer/inner/r1");
    const found = rel(root, await scanRepositories([path.join(root, "outer", "inner"), root], { depth: 3, ignored: [] }));
    assert.deepStrictEqual(found, ["outer/inner/r1"]);
  });

  it("repositories given directly as roots are found and still entered (nested clone)", async () => {
    const r = repo(root, "r");
    const nested = repo(root, "r/sub");
    assert.deepStrictEqual(await scanRepositories([r], { depth: 1, ignored: [] }), [r, nested]);
  });

  it("a root that is a file, not a folder, finds nothing", async () => {
    const f = path.join(root, "plain.txt");
    fs.writeFileSync(f, "x");
    assert.deepStrictEqual(await scanRepositories([f], { depth: 2, ignored: [] }), []);
  });

  it("results are sorted and unique across roots", async () => {
    repo(root, "b");
    repo(root, "a");
    const res = await scanRepositories([root, root + path.sep, path.join(root, "b")], { depth: 1, ignored: [] });
    assert.deepStrictEqual(rel(root, res), ["a", "b"]);
  });
});

describe("recent repositories — edge cases", () => {
  it("pushRecent with an already-front entry keeps order; trailing separator dedups", () => {
    const a = path.resolve("/a"), b = path.resolve("/b");
    assert.deepStrictEqual(pushRecent([a, b], a), [a, b]);
    assert.deepStrictEqual(pushRecent([a, b], b + path.sep), [b, a]);
  });

  it("pushRecent respects a custom max, including 0", () => {
    assert.deepStrictEqual(pushRecent([path.resolve("/a")], "/b", 1), [path.resolve("/b")]);
    assert.deepStrictEqual(pushRecent([path.resolve("/a")], "/b", 0), []);
  });

  it("case differences are distinct entries on a case-sensitive comparison (documents behaviour)", () => {
    // On macOS (case-insensitive APFS by default) and Windows /Repo and /repo are the same folder,
    // but the recent list compares strings, so both are kept.
    const list = pushRecent([path.resolve("/Work/Repo")], "/work/repo");
    assert.strictEqual(list.length, 2);
  });

  it("normalizeRecent: whitespace-only, nested arrays, objects and very long paths", () => {
    const long = "/" + Array.from({ length: 200 }, (_, i) => `segment${i}`).join("/");
    const out = normalizeRecent(["   ", ["/x"], { p: "/y" }, long, long + "/"]);
    assert.deepStrictEqual(out, [path.resolve(long)]);
    assert.ok(out[0].length > 1500);
  });

  it("normalizeRecent cap counts only kept entries (duplicates do not use up slots)", () => {
    const stored = ["/a", "/a", "/a", ...Array.from({ length: 10 }, (_, i) => `/r${i}`)];
    const out = normalizeRecent(stored);
    assert.strictEqual(out.length, 10);
    assert.strictEqual(out[0], path.resolve("/a"));
  });

  it("existingRecent keeps order, accepts a .git file, drops a broken .git symlink", async function () {
    const root = mk();
    try {
      const a = repo(root, "a");
      fs.mkdirSync(path.join(root, "wt"));
      fs.writeFileSync(path.join(root, "wt", ".git"), "gitdir: x\n");
      fs.mkdirSync(path.join(root, "broken"));
      try {
        fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "broken", ".git"));
      } catch {
        this.skip();
      }
      const wt = path.join(root, "wt");
      assert.deepStrictEqual(await existingRecent([wt, path.join(root, "broken"), a]), [wt, a]);
      assert.deepStrictEqual(await existingRecent([]), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("picker labels — edge cases", () => {
  it("nested workspace folders: the first listed folder that contains the repo wins", () => {
    const outer = path.resolve("/w/outer");
    const inner = path.join(outer, "inner");
    const r = path.join(inner, "pkg", "repo");
    assert.deepStrictEqual(repoLabel(r, [outer, inner]), { name: "repo", detail: path.join("outer", "inner", "pkg") });
    assert.deepStrictEqual(repoLabel(r, [inner, outer]), { name: "repo", detail: path.join("inner", "pkg") });
  });

  it("a repository equal to a later workspace folder: an earlier containing folder wins over the exact match", () => {
    const outer = path.resolve("/w/outer");
    const inner = path.join(outer, "inner");
    // Documents behaviour: the exact match (inner) would give detail "", but outer is checked first.
    assert.deepStrictEqual(repoLabel(inner, [outer, inner]), { name: "inner", detail: "outer" });
  });

  it("trailing separators on the root or the workspace folder do not matter", () => {
    const ws = path.resolve("/w/proj");
    assert.deepStrictEqual(repoLabel(path.join(ws, "a") + path.sep, [ws + path.sep]), { name: "a", detail: "proj" });
  });

  it("the filesystem root as a repository gets a non-empty name", () => {
    const top = path.parse(process.cwd()).root;
    const l = repoLabel(top, []);
    assert.ok(l.name.length > 0);
  });

  it("no workspace folders: detail is the parent directory", () => {
    assert.deepStrictEqual(repoLabel("/x/y/z", []), { name: "z", detail: path.resolve("/x/y") });
  });

  it("very long paths are labelled without truncation", () => {
    const ws = path.resolve("/w");
    const deep = path.join(ws, ...Array.from({ length: 100 }, (_, i) => `d${i}`), "repo");
    const l = repoLabel(deep, [ws]);
    assert.strictEqual(l.name, "repo");
    assert.ok(l.detail.startsWith("w" + path.sep + "d0"));
  });

  it("case differences in the workspace folder are not treated as containing (documents behaviour)", () => {
    const l = repoLabel(path.resolve("/Work/Proj/repo"), [path.resolve("/work/proj")]);
    // On a case-insensitive disk this is the same folder, but the label falls back to the parent path.
    assert.strictEqual(l.detail, path.resolve("/Work/Proj"));
  });
});
