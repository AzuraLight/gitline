import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pageCacheStats, readRecentCommits, resetPageCache } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

/** 1.10.0 bug hunt: inputs to `git log` that change without any ref moving. */
describe("1.10.0 bug: read-ahead cache keys", function () {
  this.timeout(60_000);
  let repo: TempRepo;

  beforeEach(() => {
    resetPageCache();
    repo = new TempRepo();
    repo.commitEmpty("root");
    repo.commitEmptyMany(500, "c");
  });
  afterEach(() => repo.dispose());

  it("@author search sees a .mailmap edit (git log --author applies the mailmap)", async () => {
    const before = await readRecentCommits(repo.root, 400, undefined, undefined, "@Mapped Person");
    assert.strictEqual(before.length, 0, "precondition: nobody is called Mapped Person yet");
    fs.writeFileSync(path.join(repo.root, ".mailmap"), "Mapped Person <test@example.com>\n");
    const after = await readRecentCommits(repo.root, 400, undefined, undefined, "@Mapped Person");
    resetPageCache();
    const truth = await readRecentCommits(repo.root, 400, undefined, undefined, "@Mapped Person");
    assert.ok(truth.length > 0, "precondition: git now finds the commits");
    assert.strictEqual(after.length, truth.length, "cached (exhausted) empty page is served after the .mailmap change");
  });

  it("the same branch list in another order reuses the cached read-ahead", async () => {
    repo.git("branch", "a");
    repo.git("branch", "b");
    await readRecentCommits(repo.root, 400, ["refs/heads/a", "refs/heads/b"]);
    const reads = pageCacheStats.reads;
    await readRecentCommits(repo.root, 400, ["refs/heads/b", "refs/heads/a"]);
    assert.strictEqual(pageCacheStats.reads, reads, "a second full read-ahead for the same selection");
  });
});
