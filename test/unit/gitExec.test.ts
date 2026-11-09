import * as assert from "assert";
import * as os from "os";
import {
  ALL_REFS,
  looksLikeHash,
  readOffHeadHashes,
  parseChangedFiles,
  readBlobAt,
  readCommitFiles,
  readCompareFiles,
  readFirstParent,
  readRecentCommits,
  readStashFiles,
  repoRelativePath,
} from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

describe("parseChangedFiles (-z output)", () => {
  it("reads plain, renamed and non-ASCII paths with their line stats", () => {
    const nameStatus = "R075\0src/Old.java\0src/New.java\0M\0한글파일.txt\0A\0dir with space/a b.txt\0";
    const numstat = "1\t0\t\0src/Old.java\0src/New.java\0" + "2\t1\t한글파일.txt\0" + "3\t0\tdir with space/a b.txt\0";
    assert.deepStrictEqual(parseChangedFiles(nameStatus, numstat), [
      { status: "R", path: "src/New.java", oldPath: "src/Old.java", insertions: 1, deletions: 0 },
      { status: "M", path: "한글파일.txt", insertions: 2, deletions: 1 },
      { status: "A", path: "dir with space/a b.txt", insertions: 3, deletions: 0 },
    ]);
  });

  it("treats binary numstat (-) as zero", () => {
    assert.deepStrictEqual(parseChangedFiles("M\0logo.png\0", "-\t-\tlogo.png\0"), [
      { status: "M", path: "logo.png", insertions: 0, deletions: 0 },
    ]);
  });

  it("returns nothing for empty output", () => {
    assert.deepStrictEqual(parseChangedFiles("", ""), []);
  });
});

describe("looksLikeHash", () => {
  it("accepts 4–40 hex characters only", () => {
    assert.ok(looksLikeHash("ce97fe4"));
    assert.ok(looksLikeHash("ABCD"));
    assert.ok(!looksLikeHash("abc"));
    assert.ok(!looksLikeHash("fix bug"));
    assert.ok(!looksLikeHash("g1234"));
  });
});

describe("git readers against a real repository", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let renameCommit: string;
  let rootCommit: string;

  before(() => {
    repo = new TempRepo();
    repo.write("src/deep/dir/Old.java", "a\nb\nc\n");
    repo.write("한글파일.txt", "안녕\n");
    rootCommit = repo.commitAll("first");
    repo.git("mv", "src/deep/dir/Old.java", "src/deep/dir/New.java");
    repo.append("src/deep/dir/New.java", "d\n");
    repo.append("한글파일.txt", "둘\n");
    renameCommit = repo.commitAll("rename and edit");
    repo.commitEmptyMany(230, "c");
  });

  after(() => repo.dispose());

  it("lists a renamed file with its real line stats", async () => {
    const files = await readCommitFiles(repo.root, renameCommit);
    const renamed = files.find((f) => f.status === "R");
    assert.deepStrictEqual(renamed, {
      status: "R",
      path: "src/deep/dir/New.java",
      oldPath: "src/deep/dir/Old.java",
      insertions: 1,
      deletions: 0,
    });
  });

  it("keeps non-ASCII paths readable and diffable", async () => {
    const files = await readCommitFiles(repo.root, renameCommit);
    const korean = files.find((f) => f.status === "M");
    assert.strictEqual(korean?.path, "한글파일.txt");
    assert.strictEqual(await readBlobAt(repo.root, renameCommit, korean!.path), "안녕\n둘\n");
  });

  it("compares two commits with the same parser", async () => {
    const files = await readCompareFiles(repo.root, rootCommit, renameCommit);
    assert.deepStrictEqual(files.map((f) => f.path).sort(), ["src/deep/dir/New.java", "한글파일.txt"]);
  });

  it("returns exactly the requested page size, so the webview can ask for more", async () => {
    assert.strictEqual((await readRecentCommits(repo.root, 200)).length, 200);
    assert.strictEqual((await readRecentCommits(repo.root, 400)).length, 232);
  });

  it("finds a commit by (partial) hash", async () => {
    const target = repo.git("rev-parse", "HEAD~5").trim();
    const hits = await readRecentCommits(repo.root, 200, undefined, undefined, target.slice(0, 7));
    assert.strictEqual(hits[0]?.hash, target);
    assert.strictEqual(hits[0]?.subject, "c225");
  });

  it("still searches messages for text queries", async () => {
    const hits = await readRecentCommits(repo.root, 500, undefined, undefined, "rename and");
    assert.deepStrictEqual(hits.map((h) => h.subject), ["rename and edit"]);
  });

  it("reports no parent for the root commit", async () => {
    assert.strictEqual(await readFirstParent(repo.root, rootCommit), "");
    assert.strictEqual(await readFirstParent(repo.root, renameCommit), rootCommit);
  });
});

describe("all-branches view and commits off HEAD", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let base: string, onMain: string, feature: string, tagged: string, merged: string;

  before(() => {
    repo = new TempRepo();
    base = repo.commitEmpty("base");
    repo.git("checkout", "-q", "-b", "feature");
    feature = repo.commitEmpty("feature work");
    repo.git("checkout", "-q", "-b", "topic", base);
    merged = repo.commitEmpty("topic work");
    repo.git("checkout", "-q", "--detach", base);
    tagged = repo.commitEmpty("tagged only");
    repo.git("tag", "v-orphan");
    repo.git("checkout", "-q", "main");
    onMain = repo.commitEmpty("main work");
    repo.git("merge", "-q", "--no-ff", "topic", "-m", "merge topic");
    // A stash must not show up as graph nodes (that is why the view is not `--all`).
    repo.write("wip.txt", "x\n");
    repo.git("add", "wip.txt");
    repo.git("stash", "push", "-q", "-m", "wip");
  });

  after(() => repo.dispose());

  it("lists every branch and tag, but not stash internals", async () => {
    const subjects = (await readRecentCommits(repo.root, 100, ALL_REFS)).map((c) => c.subject);
    for (const s of ["merge topic", "main work", "topic work", "feature work", "tagged only", "base"]) {
      assert.ok(subjects.includes(s), `missing ${s}`);
    }
    assert.ok(!subjects.some((s) => s.includes("wip") || s.startsWith("index on")), subjects.join(", "));
  });

  it("marks only commits HEAD cannot reach", async () => {
    const off = await readOffHeadHashes(repo.root, ALL_REFS, 1000);
    assert.deepStrictEqual([...(off ?? [])].sort(), [feature, tagged].sort());
    assert.ok(!off?.has(merged) && !off?.has(onMain) && !off?.has(base));
  });

  it("dims a single branch's view too, and nothing for HEAD's own log", async () => {
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, "feature", 1000)) ?? [])], [feature]);
    assert.strictEqual(await readOffHeadHashes(repo.root, undefined, 1000), undefined);
    assert.strictEqual(await readOffHeadHashes(repo.root, "", 1000), undefined);
  });
});

describe("all-branches view: edge cases", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let base: string, feature: string, remoteOnly: string;

  before(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    base = repo.commitAll("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.append("a.txt", "2\n");
    feature = repo.commitAll("feature edits a.txt");
    repo.commitEmpty("feature empty");
    repo.git("checkout", "-q", "--detach", base);
    remoteOnly = repo.commitEmpty("only on origin");
    // A remote-tracking branch with no local counterpart.
    repo.git("update-ref", "refs/remotes/origin/remote-only", remoteOnly);
    repo.git("checkout", "-q", "-b", "topic", base);
    repo.commitEmpty("topic work");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "merge topic", "topic");
    // A tag that points at a tree, not a commit (git.git and linux.git have these).
    repo.git("tag", "tree-tag", `${base}^{tree}`);
  });

  after(() => repo.dispose());

  const subjects = (rows: { subject: string }[]) => rows.map((r) => r.subject);

  it("includes remote-only branches and survives a tag that points at a tree", async () => {
    const rows = await readRecentCommits(repo.root, 100, ALL_REFS);
    assert.ok(subjects(rows).includes("only on origin"));
    assert.ok(subjects(rows).includes("feature empty"));
    const off = await readOffHeadHashes(repo.root, ALL_REFS, 1000);
    assert.ok(off?.has(remoteOnly) && off?.has(feature) && !off?.has(base));
  });

  it("keeps dimming right under search, hidden merges and a file filter", async () => {
    const searched = await readRecentCommits(repo.root, 100, ALL_REFS, undefined, "feature");
    assert.deepStrictEqual(subjects(searched).sort(), ["feature edits a.txt", "feature empty"]);
    const all = await readRecentCommits(repo.root, 100, ALL_REFS);
    assert.ok(all.some((r) => r.parents.length === 2), "fixture has a merge");
    const noMerges = await readRecentCommits(repo.root, 100, ALL_REFS, undefined, undefined, "hide");
    assert.ok(noMerges.length === all.length - 1 && noMerges.every((r) => r.parents.length < 2));
    const onlyMerges = await readRecentCommits(repo.root, 100, ALL_REFS, undefined, undefined, "only");
    assert.deepStrictEqual(subjects(onlyMerges), ["merge topic"]);
    const fileHistory = await readRecentCommits(repo.root, 100, ALL_REFS, "a.txt");
    assert.deepStrictEqual(subjects(fileHistory), ["feature edits a.txt", "base"]);
    // The dim set is computed independently of the filters, so filtered rows keep their status.
    const off = await readOffHeadHashes(repo.root, ALL_REFS, 1000);
    assert.ok(searched.every((r) => off?.has(r.hash)), "searched feature commits stay dimmed");
    assert.deepStrictEqual(fileHistory.map((r) => off?.has(r.hash) ?? false), [true, false]);
    assert.ok(onlyMerges.every((r) => !off?.has(r.hash)), "the merge on main is not dimmed");
  });

  it("follows a detached HEAD", async () => {
    repo.git("checkout", "-q", "--detach", feature);
    try {
      const rows = await readRecentCommits(repo.root, 100, ALL_REFS);
      assert.ok(rows.some((r) => r.hash === feature));
      const off = await readOffHeadHashes(repo.root, ALL_REFS, 1000);
      assert.ok(!off?.has(feature) && !off?.has(base), "HEAD's own ancestry is not dimmed");
      assert.ok(off?.has(remoteOnly));
    } finally {
      repo.git("checkout", "-q", "main");
    }
  });

  it("dims nothing when the chosen branch is HEAD itself", async () => {
    assert.strictEqual((await readOffHeadHashes(repo.root, "main", 1000))?.size, 0);
  });

  it("stops at the cap instead of failing", async () => {
    assert.strictEqual((await readOffHeadHashes(repo.root, ALL_REFS, 1))?.size, 1);
  });
});

describe("all-branches view: refs that must stay out, odd tags, shallow history", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let base: string, side: string, annotatedOff: string;

  before(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    base = repo.commitAll("base");
    // Two branches on the same tip: the commit must be listed once.
    repo.git("branch", "twin");
    repo.git("checkout", "-q", "-b", "side");
    side = repo.commitEmpty("side work");
    repo.git("update-ref", "refs/remotes/origin/side", side);
    repo.git("checkout", "-q", "--detach", base);
    annotatedOff = repo.commitEmpty("annotated tag only");
    repo.git("tag", "-a", "v-annotated", "-m", "release notes");
    // An annotated tag that points at a blob.
    const blob = repo.git("rev-parse", `${base}:a.txt`).trim();
    repo.git("tag", "-a", "blob-tag", "-m", "a file", blob);
    repo.git("checkout", "-q", "main");
    // Notes and an untracked-files stash create commits under refs/notes and refs/stash.
    repo.git("notes", "add", "-m", "a note", base);
    repo.write("untracked.txt", "u\n");
    repo.git("stash", "push", "-q", "-u", "-m", "with untracked");
  });

  after(() => repo.dispose());

  it("keeps notes and stash commits (incl. the untracked-files commit) out of the graph", async () => {
    const rows = await readRecentCommits(repo.root, 100, ALL_REFS);
    const subjects = rows.map((r) => r.subject);
    assert.ok(!subjects.some((s) => /Notes added|with untracked|untracked files on|index on/.test(s)), subjects.join(" | "));
    assert.ok(rows.every((r) => r.parents.length <= 2), "a 3-parent stash commit leaked in");
  });

  it("lists a commit shared by several branches once", async () => {
    const rows = await readRecentCommits(repo.root, 100, ALL_REFS);
    assert.strictEqual(rows.filter((r) => r.hash === base).length, 1);
    assert.strictEqual(new Set(rows.map((r) => r.hash)).size, rows.length);
  });

  it("follows annotated tags to their commit and ignores one that points at a blob", async () => {
    const rows = await readRecentCommits(repo.root, 100, ALL_REFS);
    assert.ok(rows.some((r) => r.hash === annotatedOff));
    const off = await readOffHeadHashes(repo.root, ALL_REFS, 1000);
    assert.deepStrictEqual([...(off ?? [])].sort(), [side, annotatedOff].sort());
  });

  it("dims a remote branch's own commits when it is viewed alone", async () => {
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, "origin/side", 1000)) ?? [])], [side]);
  });

  it("works on a shallow fetch whose parents are missing", async () => {
    const shallow = new TempRepo();
    try {
      shallow.commitEmpty("local only");
      shallow.git("fetch", "-q", "--depth=1", `file://${repo.root}`, `side:refs/remotes/origin/side`);
      const rows = await readRecentCommits(shallow.root, 100, ALL_REFS);
      const tip = rows.find((r) => r.hash === side);
      assert.ok(tip, "shallow tip listed");
      assert.ok(rows.every((r) => r.hash !== base), "beyond the shallow boundary is not listed");
      const off = await readOffHeadHashes(shallow.root, ALL_REFS, 1000);
      assert.deepStrictEqual([...(off ?? [])], [side]);
    } finally {
      shallow.dispose();
    }
  });
});

describe("views when a file shares a name with a ref", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let side: string;
  before(() => {
    repo = new TempRepo();
    repo.commitEmpty("base");
    repo.git("checkout", "-q", "-b", "side");
    side = repo.commitEmpty("side work");
    repo.git("checkout", "-q", "main");
    // Untracked files named like HEAD and like a branch: git must not read them as paths.
    repo.write("HEAD", "not a ref\n");
    repo.write("side", "not a branch\n");
  });
  after(() => repo.dispose());

  it("still lists every view", async () => {
    assert.ok((await readRecentCommits(repo.root, 100, ALL_REFS)).some((r) => r.hash === side));
    assert.ok((await readRecentCommits(repo.root, 100, "side")).some((r) => r.hash === side));
    assert.strictEqual((await readRecentCommits(repo.root, 100)).length, 1);
  });

  it("still dims", async () => {
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, ALL_REFS, 1000)) ?? [])], [side]);
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, "side", 1000)) ?? [])], [side]);
  });
});

describe("all-branches view: names, worktrees and searches", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let base: string, korean: string, dup: string;

  before(() => {
    repo = new TempRepo();
    base = repo.commitEmpty("base");
    repo.git("checkout", "-q", "-b", "기능/검색");
    korean = repo.commitEmpty("korean branch work");
    // A branch and a tag with the same name: git warns "refname is ambiguous" on stderr only.
    repo.git("checkout", "-q", "-b", "dup", base);
    dup = repo.commitEmpty("dup branch work");
    repo.git("tag", "dup", base);
    repo.git("checkout", "-q", "main");
  });

  after(() => repo.dispose());

  it("handles a Korean branch name in both views", async () => {
    assert.ok((await readRecentCommits(repo.root, 100, "기능/검색")).some((r) => r.hash === korean));
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, "기능/검색", 100)) ?? [])], [korean]);
  });

  it("treats an ambiguous name (branch and tag) as a warning, not an error", async () => {
    const rows = await readRecentCommits(repo.root, 100, "dup");
    assert.ok(rows.length > 0, "the view lists something rather than failing");
    const off = await readOffHeadHashes(repo.root, "dup", 100);
    assert.ok(off !== undefined, "dimming is still computed");
    // git resolves an ambiguous name to the tag first; the branch commit still shows under All.
    assert.ok((await readRecentCommits(repo.root, 100, ALL_REFS)).some((r) => r.hash === dup));
  });

  it("never reads a search starting with '-' as a git option", async () => {
    for (const q of ["--all", "-n", "--output=/tmp/x", "@-x"]) {
      const rows = await readRecentCommits(repo.root, 100, ALL_REFS, undefined, q);
      assert.deepStrictEqual(rows, [], `query ${q}`);
    }
  });

  it("marks a hash-search hit that is not on HEAD", async () => {
    const rows = await readRecentCommits(repo.root, 100, ALL_REFS, undefined, korean.slice(0, 8));
    assert.strictEqual(rows[0]?.hash, korean);
    assert.ok((await readOffHeadHashes(repo.root, ALL_REFS, 1000))?.has(korean));
  });

  it("dims relative to a linked worktree's own HEAD", async () => {
    const wt = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", wt, "기능/검색");
    try {
      const off = await readOffHeadHashes(wt, ALL_REFS, 1000);
      assert.ok(off && !off.has(korean), "the worktree's branch is its HEAD, so not dimmed");
      assert.ok(off.has(dup));
      assert.ok((await readRecentCommits(wt, 100, ALL_REFS)).some((r) => r.hash === korean));
    } finally {
      repo.git("worktree", "remove", "--force", wt);
    }
  });
});

describe("all-branches view in a repository with no commits", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  before(() => { repo = new TempRepo(); });
  after(() => repo.dispose());

  it("dims nothing and does not throw from the off-HEAD lookup", async () => {
    assert.strictEqual(await readOffHeadHashes(repo.root, ALL_REFS, 1000), undefined);
  });

  it("returns an empty log for both views instead of a git error", async () => {
    assert.deepStrictEqual(await readRecentCommits(repo.root, 100), []);
    assert.deepStrictEqual(await readRecentCommits(repo.root, 100, ALL_REFS), []);
    assert.deepStrictEqual(await readRecentCommits(repo.root, 100, undefined, undefined, "abc1234"), []);
  });
});

describe("orphan branch (unborn HEAD next to real branches)", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let first: string;
  before(() => {
    repo = new TempRepo();
    first = repo.commitEmpty("first");
    repo.git("checkout", "-q", "--orphan", "fresh");
  });
  after(() => repo.dispose());

  it("shows an empty HEAD log, and the other branches under All branches", async () => {
    assert.deepStrictEqual(await readRecentCommits(repo.root, 100), []);
    const all = await readRecentCommits(repo.root, 100, ALL_REFS);
    assert.deepStrictEqual(all.map((r) => r.hash), [first]);
  });

  it("dims nothing it cannot compare against", async () => {
    assert.strictEqual(await readOffHeadHashes(repo.root, ALL_REFS, 1000), undefined);
  });
});

describe("stash files", function () {
  this.timeout(30_000);
  let repo: TempRepo;

  before(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.append("a.txt", "2\n");
    repo.git("stash", "push", "-q", "-m", "wip");
  });

  after(() => repo.dispose());

  it("lists the files in a stash entry", async () => {
    assert.deepStrictEqual(await readStashFiles(repo.root, "stash@{0}"), [
      { status: "M", path: "a.txt", insertions: 1, deletions: 0 },
    ]);
  });
});

describe("repoRelativePath", () => {
  it("resolves symlinks on both sides (macOS /var → /private/var)", () => {
    const repo = new TempRepo();
    try {
      repo.write("a/b.txt", "x\n");
      const gitRoot = repo.git("rev-parse", "--show-toplevel").trim();
      assert.strictEqual(repoRelativePath(gitRoot, `${repo.root}/a/b.txt`), "a/b.txt");
      assert.strictEqual(repoRelativePath(repo.root, `${gitRoot}/a/b.txt`), "a/b.txt");
      assert.ok(repoRelativePath(repo.root, os.tmpdir()).startsWith(".."));
    } finally {
      repo.dispose();
    }
  });
});
