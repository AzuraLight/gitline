import * as assert from "assert";
import { readRecentCommits, resetPageCache } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

/**
 * 1.10.0 final review: the cap went from 5,000 to 50,000 commits per view, but `git log` still runs
 * with execGit's default 10 MB stdout buffer. 50,000 rows of VS Code's own history are 8.6 MB;
 * longer subjects push a 50,000-row page past the buffer and the whole read fails.
 */
describe("1.10.0 final: a 50,000-row page fits the git output buffer", function () {
  this.timeout(300_000);
  let repo: TempRepo;

  before(() => {
    resetPageCache();
    repo = new TempRepo();
    repo.commitEmpty("root");
    // ~200-character subjects, common with long conventional-commit or ticket-prefixed messages.
    repo.commitEmptyMany(50_000, "feat(scope): " + "x".repeat(180) + " #");
  });
  after(() => repo.dispose());

  it("reads 50,000 commits with ~200-character subjects", async () => {
    const rows = await readRecentCommits(repo.root, 50_000);
    assert.strictEqual(rows.length, 50_000);
  });
});
