import * as assert from "assert";
import { pageCacheLimit, pageCacheStats, readRecentCommits, resetPageCache } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

/**
 * 1.10.0: pages after the first are cut from one read-ahead while HEAD and every ref tip stay put.
 * What matters is that a cut page is always what git itself would answer.
 */
describe("1.10.0: graph pages from the read-ahead", function () {
  this.timeout(60_000);
  let repo: TempRepo;

  beforeEach(() => {
    resetPageCache();
    repo = new TempRepo();
    repo.commitEmpty("root");
    repo.commitEmptyMany(700, "c");
  });
  afterEach(() => repo.dispose());

  const subjects = (rows: { subject: string }[]) => rows.map((r) => r.subject);

  it("pages 2, 3, 4 come from one read and match git's own answer", async () => {
    const p1 = await readRecentCommits(repo.root, 200);
    const p2 = await readRecentCommits(repo.root, 400);
    const p3 = await readRecentCommits(repo.root, 600);
    const p4 = await readRecentCommits(repo.root, 800);
    assert.deepStrictEqual({ reads: pageCacheStats.reads, hits: pageCacheStats.hits }, { reads: 1, hits: 2 });
    assert.strictEqual(p1.length, 200);
    assert.strictEqual(p3.length, 600);
    assert.strictEqual(p4.length, 701, "the end of history: every commit, no more");
    resetPageCache();
    for (const [n, got] of [[400, p2], [600, p3]] as const) {
      // Read straight from git: the first-page path never uses the cache, so ask in one go.
      const direct = (await readRecentCommits(repo.root, 5000)).slice(0, n);
      assert.deepStrictEqual(subjects(got), subjects(direct), `page of ${n}`);
    }
    assert.deepStrictEqual(subjects(p1), subjects(p2).slice(0, 200));
  });

  it("a new commit, a new tag or a moved branch is seen on the very next page", async () => {
    await readRecentCommits(repo.root, 400);
    repo.commitEmpty("brand new");
    let rows = await readRecentCommits(repo.root, 600);
    assert.strictEqual(rows[0].subject, "brand new");

    repo.git("tag", "v-fresh", "HEAD~3");
    rows = await readRecentCommits(repo.root, 600);
    assert.ok(rows[3].refs.some((r) => r.label.includes("v-fresh")), JSON.stringify(rows[3].refs));

    repo.git("branch", "-f", "side", "HEAD~5");
    rows = await readRecentCommits(repo.root, 800, ":all");
    assert.ok(rows.some((r) => r.refs.some((x) => x.label.includes("side"))));
    assert.strictEqual(pageCacheStats.hits, 0, "every change above moved a ref: nothing came from the cache");
  });

  it("a stash and a reset that moves no other ref still refresh the pages", async () => {
    await readRecentCommits(repo.root, 400, ":all");
    repo.write("f.txt", "x\n");
    repo.git("add", "f.txt");
    repo.git("stash", "push", "-q", "-m", "keep me");
    let rows = await readRecentCommits(repo.root, 400, ":all");
    assert.ok(rows.length > 0);
    repo.git("stash", "drop", "-q");
    repo.git("reset", "-q", "--hard", "HEAD~10");
    rows = await readRecentCommits(repo.root, 400);
    assert.strictEqual(rows[0].subject, "c690");
  });

  it("each view, search, file filter and merge mode keeps its own pages", async () => {
    repo.git("checkout", "-q", "-b", "side", "HEAD~300");
    repo.commitEmpty("only on side");
    repo.git("checkout", "-q", "main");
    const head = await readRecentCommits(repo.root, 400);
    const side = await readRecentCommits(repo.root, 400, "side");
    const search = await readRecentCommits(repo.root, 400, ":all", undefined, "only on");
    assert.ok(!subjects(head).includes("only on side"));
    assert.strictEqual(side[0].subject, "only on side");
    assert.deepStrictEqual(subjects(search), ["only on side"]);
    assert.ok(!subjects(await readRecentCommits(repo.root, 400)).includes("only on side"), "HEAD's pages again");
  });

  it("not cached in a shallow clone (deepening changes history without moving a ref)", async () => {
    const clone = new TempRepo();
    try {
      clone.git("fetch", "-q", "--depth=500", `file://${repo.root}`, "main:refs/remotes/o/main");
      clone.git("reset", "-q", "--hard", "o/main");
      await readRecentCommits(clone.root, 400);
      await readRecentCommits(clone.root, 600);
      assert.strictEqual(pageCacheStats.hits, 0);
      assert.strictEqual(pageCacheStats.reads, 0, "shallow: straight to git, no read-ahead");
    } finally {
      try { clone.dispose(); } catch { /* Windows may still hold a handle */ }
    }
  });

  it("reads ahead in growing steps: past 5,000 rows the next read is 10,000, not everything", async () => {
    repo.commitEmptyMany(5600, "d"); // 6,301 commits in all
    const p2 = await readRecentCommits(repo.root, 400);
    assert.strictEqual(p2.length, 400);
    assert.strictEqual(pageCacheStats.reads, 1);
    const deep = await readRecentCommits(repo.root, 5200);
    assert.strictEqual(deep.length, 5200);
    assert.strictEqual(pageCacheStats.reads, 2, "5,000 rows read first; 5,200 asks for the next step");
    const end = await readRecentCommits(repo.root, 6400);
    assert.strictEqual(end.length, 6301, "the 10,000 step holds the whole history");
    assert.strictEqual(pageCacheStats.reads, 2);
    assert.strictEqual(pageCacheStats.hits, 1);
    assert.strictEqual(end[0].subject, "d5600");
    assert.strictEqual(end[6300].subject, "root");
  });

  it("keeps at most the row limit in all, dropping the least recently used view first", async () => {
    const saved = pageCacheLimit.rows;
    pageCacheLimit.rows = 1500; // each view below caches its whole 701-row history
    try {
      await readRecentCommits(repo.root, 400);              // HEAD: read 1
      await readRecentCommits(repo.root, 400, ":all");      // All: read 2 (1,402 rows kept)
      await readRecentCommits(repo.root, 400);              // HEAD again: hit, now most recent
      await readRecentCommits(repo.root, 400, "main");      // main: read 3 → 2,103 rows: All goes
      assert.deepStrictEqual({ reads: pageCacheStats.reads, hits: pageCacheStats.hits }, { reads: 3, hits: 1 });
      await readRecentCommits(repo.root, 400);              // HEAD kept: hit
      assert.strictEqual(pageCacheStats.hits, 2);
      await readRecentCommits(repo.root, 400, ":all");      // All was dropped: read again
      assert.strictEqual(pageCacheStats.reads, 4);
    } finally {
      pageCacheLimit.rows = saved;
    }
  });

  it("a log.* setting that changes the labels is seen on the next page (1.10.0 review)", async () => {
    repo.git("tag", "v-hidden", "HEAD~2");
    let rows = await readRecentCommits(repo.root, 400);
    assert.ok(rows[2].refs.some((r) => r.label.includes("v-hidden")));
    repo.git("config", "log.excludeDecoration", "refs/tags/");
    rows = await readRecentCommits(repo.root, 400);
    assert.ok(!rows[2].refs.some((r) => r.label.includes("v-hidden")), JSON.stringify(rows[2].refs));
  });
});
