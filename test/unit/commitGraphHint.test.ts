import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { hasCommitGraph, resetHintSession, shouldSuggest, SLOW_LOAD_MS, writeCommitGraph, type HintStore } from "../../src/commitGraphHint";
import { TempRepo } from "../helpers/tempRepo";

/** 1.10.0: asking to build git's commit-graph file when a first load is slow without one. */
describe("1.10.0: commit-graph suggestion", function () {
  this.timeout(60_000);
  let repo: TempRepo;
  const info = () => path.join(repo.root, ".git", "objects", "info");
  const store = (dismissed: string[] = []): HintStore & { dismissed(): string[] } => ({
    dismissed: () => dismissed,
    dismiss: (r: string) => { dismissed.push(r); },
  });

  beforeEach(() => {
    resetHintSession();
    repo = new TempRepo();
    // Keep git from writing a commit-graph on its own while the test runs.
    repo.git("config", "gc.auto", "0");
    repo.git("config", "gc.writeCommitGraph", "false");
    repo.git("config", "fetch.writeCommitGraph", "false");
    repo.commitEmpty("root");
    repo.commitEmptyMany(50, "c");
  });
  afterEach(() => repo.dispose());

  it("finds no index in a new repository; writing one makes it found", async () => {
    assert.strictEqual(await hasCommitGraph(repo.root), false);
    await writeCommitGraph(repo.root, new AbortController().signal);
    assert.ok(fs.existsSync(path.join(info(), "commit-graph")));
    assert.strictEqual(await hasCommitGraph(repo.root), true);
    assert.strictEqual(repo.git("rev-list", "--count", "HEAD").trim(), "51", "history untouched");
  });

  it("a split commit-graph chain counts as an index too", async () => {
    repo.git("commit-graph", "write", "--reachable", "--split");
    assert.ok(fs.existsSync(path.join(info(), "commit-graphs", "commit-graph-chain")));
    assert.ok(!fs.existsSync(path.join(info(), "commit-graph")));
    assert.strictEqual(await hasCommitGraph(repo.root), true);
  });

  it("core.commitGraph=false is the user's choice: nothing to suggest", async () => {
    repo.git("config", "core.commitGraph", "false");
    assert.strictEqual(await hasCommitGraph(repo.root), true);
    assert.strictEqual(await shouldSuggest(repo.root, 5000, true, store()), false);
  });

  it("asks only after a slow load, once per session, not when dismissed or turned off", async () => {
    assert.strictEqual(await shouldSuggest(repo.root, SLOW_LOAD_MS - 1, true, store()), false, "fast load");
    assert.strictEqual(await shouldSuggest(repo.root, 5000, false, store()), false, "setting off");
    assert.strictEqual(await shouldSuggest(repo.root, 5000, true, store([repo.root])), false, "dismissed here");
    assert.strictEqual(await shouldSuggest(repo.root, 5000, true, store(["/elsewhere"])), true, "dismissed elsewhere only");
    assert.strictEqual(await shouldSuggest(repo.root, 5000, true, store()), false, "already asked this session");
  });

  it("not asked when the index already exists", async () => {
    await writeCommitGraph(repo.root, new AbortController().signal);
    assert.strictEqual(await shouldSuggest(repo.root, 5000, true, store()), false);
  });

  it("cancelling stops the write and leaves no index behind", async () => {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(writeCommitGraph(repo.root, abort.signal));
    assert.strictEqual(await hasCommitGraph(repo.root), false);
  });

  it("works from a linked worktree (the index lives in the main repository)", async () => {
    const wt = path.join(repo.root, "..", path.basename(repo.root) + "-wt");
    repo.git("worktree", "add", "-q", "--detach", wt);
    try {
      assert.strictEqual(await hasCommitGraph(wt), false);
      await writeCommitGraph(wt, new AbortController().signal);
      assert.strictEqual(await hasCommitGraph(repo.root), true);
      assert.strictEqual(await hasCommitGraph(wt), true);
    } finally {
      repo.git("worktree", "remove", "--force", wt);
    }
  });
});
