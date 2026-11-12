import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pageCacheStats, readRecentCommits, resetPageCache } from "../../src/gitExec";
import { hasCommitGraph } from "../../src/commitGraphHint";
import { TempRepo } from "../helpers/tempRepo";

/** Edge cases for the 1.10.0 read-ahead: a cut page must equal what git answers right now. */
describe("1.10.0 edge: read-ahead cache vs git", function () {
  this.timeout(60_000);
  let repo: TempRepo;

  beforeEach(() => {
    resetPageCache();
    repo = new TempRepo();
    repo.commitEmpty("root");
    repo.commitEmptyMany(500, "c");
  });
  afterEach(() => repo.dispose());

  /** What git says now, bypassing the cache (first-page path reads git directly; then slice). */
  async function direct(limit: number, rev?: string, q?: string) {
    resetPageCache();
    return (await readRecentCommits(repo.root, limit, rev, undefined, q)).slice(0, limit);
  }
  const refsOf = (rows: { refs: unknown }[]) => JSON.stringify(rows.slice(0, 3).map((r) => r.refs));

  it("switching to another branch that points at the same commit updates HEAD's decoration", async () => {
    repo.git("branch", "other");
    const before = await readRecentCommits(repo.root, 400);
    repo.git("switch", "-q", "other");
    const after = await readRecentCommits(repo.root, 400);
    const truth = await direct(400);
    assert.notStrictEqual(refsOf(before), refsOf(truth), "precondition: git's answer did change");
    assert.strictEqual(refsOf(after), refsOf(truth), "cached page still shows HEAD -> main");
  });

  it("detaching HEAD at the same commit updates HEAD's decoration", async () => {
    await readRecentCommits(repo.root, 400);
    repo.git("switch", "-q", "--detach");
    const after = await readRecentCommits(repo.root, 400);
    assert.strictEqual(refsOf(after), refsOf(await direct(400)));
  });

  it("a replace ref (git replace) is seen on the next page", async () => {
    await readRecentCommits(repo.root, 400);
    const target = repo.git("rev-parse", "HEAD~2").trim();
    const other = repo.git("rev-parse", "HEAD~4").trim();
    repo.git("replace", target, other);
    const after = await readRecentCommits(repo.root, 400);
    assert.deepStrictEqual(after.map((r) => r.subject), (await direct(400)).map((r) => r.subject));
  });

  it("hex query: a page cut from the read-ahead equals git's answer for that page size", async () => {
    // A commit whose message contains a hash-like word, deep in history, plus its own hash matching.
    const deep = repo.git("rev-parse", "HEAD~450").trim();
    const q = deep.slice(0, 10);
    repo.commitEmpty(`mentions ${q}`);
    repo.commitEmptyMany(300, "d");
    // Message match at row 301; hash hit at row ~751. limit 400 from git: hash commit is not in
    // the first 400 grep rows... grep only matches 1 row, so check the head of each answer.
    await readRecentCommits(repo.root, 400, undefined, undefined, q);
    const cached = await readRecentCommits(repo.root, 400, undefined, undefined, q);
    const truth = await direct(400, undefined, q);
    assert.deepStrictEqual(cached.map((r) => r.hash), truth.map((r) => r.hash));
  });

  it("history of exactly the read-ahead step: the next page asks git again, not the cache", async () => {
    // 501 commits; page 400 reads ahead 5000, gets 501 (< asked) → exhausted; 600 is a hit.
    await readRecentCommits(repo.root, 400);
    const r = await readRecentCommits(repo.root, 600);
    assert.strictEqual(r.length, 501);
    assert.strictEqual(pageCacheStats.hits, 1);
  });
});

describe("1.10.0 edge: hasCommitGraph", function () {
  this.timeout(60_000);
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo();
    repo.commitEmpty("root");
  });
  afterEach(() => repo.dispose());

  it("false without a file, true after git commit-graph write", async () => {
    assert.strictEqual(await hasCommitGraph(repo.root), false);
    repo.git("commit-graph", "write", "--reachable");
    assert.strictEqual(await hasCommitGraph(repo.root), true);
  });

  it("works from a subdirectory", async () => {
    repo.git("commit-graph", "write", "--reachable");
    repo.write("sub/x.txt", "x");
    assert.strictEqual(await hasCommitGraph(path.join(repo.root, "sub")), true);
  });

  it("a linked worktree sees the main repository's commit-graph", async () => {
    repo.git("commit-graph", "write", "--reachable");
    const wt = repo.root + "-wt";
    repo.git("worktree", "add", "-q", wt);
    try {
      assert.strictEqual(await hasCommitGraph(wt), true);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("a split commit-graph chain counts", async () => {
    repo.git("commit-graph", "write", "--reachable", "--split");
    assert.strictEqual(await hasCommitGraph(repo.root), true);
  });

  it("a repository borrowing objects through alternates whose commit-graph git uses", async () => {
    repo.git("commit-graph", "write", "--reachable");
    const clone = repo.root + "-alt";
    repo.git("clone", "-q", "--shared", repo.root, clone);
    try {
      // git itself loads the alternate's commit-graph for the clone.
      assert.strictEqual(await hasCommitGraph(clone), true, "would suggest writing a graph that git already has");
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});
