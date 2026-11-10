import * as assert from "assert";
import { continueRebase, isRebaseInProgress, runRebaseStep, skipRebase, type RebaseStepMessage } from "../../src/rebaseRun";
import { TempRepo } from "../helpers/tempRepo";

/**
 * Continue / skip of a paused rebase, against real conflicts. `feature` has two commits that both
 * rewrite the line `main` also changed, so rebasing feature onto main stops twice.
 */
function conflictingRebase(): TempRepo {
  const repo = new TempRepo();
  repo.write("a.txt", "base\n");
  repo.commitAll("base");
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("a.txt", "feature one\n");
  repo.commitAll("feature 1");
  repo.write("a.txt", "feature two\n");
  repo.commitAll("feature 2");
  repo.git("checkout", "-q", "main");
  repo.write("a.txt", "main\n");
  repo.commitAll("main change");
  repo.git("checkout", "-q", "feature");
  try {
    repo.git("rebase", "main");
  } catch {
    // expected: stops on the first conflicting commit
  }
  return repo;
}

/** Resolves the current conflict by taking `content` and stages it (no commit — the rebase does that). */
function resolve(repo: TempRepo, content: string): void {
  repo.write("a.txt", content);
  repo.git("add", "a.txt");
}

function recorder() {
  const sent: RebaseStepMessage[] = [];
  return { sent, post: (m: RebaseStepMessage) => void sent.push(m), types: () => sent.map((m) => m.type) };
}

describe("rebase continue / skip step", function () {
  this.timeout(30_000);
  const STILL = "still paused";

  it("with no rebase running: reports done and reloads, without running the step", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("only");
      const r = recorder();
      let ran = false;
      await runRebaseStep(repo.root, async () => { ran = true; }, r.post, { stillPausedMessage: STILL });
      assert.deepStrictEqual(r.types(), ["rebaseDone", "reloadNow"]);
      assert.strictEqual(ran, false);
    } finally {
      repo.dispose();
    }
  });

  it("continue with the conflict unresolved: says it is still paused (with git's detail) and reloads", async () => {
    const repo = conflictingRebase();
    try {
      assert.ok(await isRebaseInProgress(repo.root), "fixture is paused on a conflict");
      const r = recorder();
      await runRebaseStep(repo.root, continueRebase, r.post, { stillPausedMessage: STILL });
      // git exits non-zero, but the rebase is still paused: the friendly message, plus git's detail.
      assert.deepStrictEqual(r.types(), ["rebaseError", "reloadNow"]);
      const err = r.sent[0] as { message: string };
      assert.ok(err.message.startsWith(STILL + "\n") && err.message.length > STILL.length + 1, err.message);
      assert.ok(await isRebaseInProgress(repo.root));
    } finally {
      repo.dispose();
    }
  });

  it("continue that stops on the next conflict: says it is still paused", async () => {
    const repo = conflictingRebase();
    try {
      resolve(repo, "feature one (resolved)\n");
      const r = recorder();
      await runRebaseStep(repo.root, continueRebase, r.post, { stillPausedMessage: STILL });
      assert.deepStrictEqual(r.types(), ["rebaseError", "reloadNow"]);
      const err = r.sent[0] as { message: string };
      assert.ok(err.message.startsWith(STILL), err.message);
      assert.ok(/a\.txt|CONFLICT|conflict/i.test(err.message), "git's detail names the conflict: " + err.message);
      assert.ok(await isRebaseInProgress(repo.root), "stopped on feature 2");
    } finally {
      repo.dispose();
    }
  });

  it("continue after the last conflict is resolved: done", async () => {
    const repo = conflictingRebase();
    try {
      resolve(repo, "one\n");
      await runRebaseStep(repo.root, continueRebase, () => undefined, { stillPausedMessage: STILL });
      resolve(repo, "two\n");
      const r = recorder();
      await runRebaseStep(repo.root, continueRebase, r.post, { stillPausedMessage: STILL });
      assert.deepStrictEqual(r.types(), ["rebaseDone", "reloadNow"]);
      assert.ok(!(await isRebaseInProgress(repo.root)));
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "feature 2");
    } finally {
      repo.dispose();
    }
  });

  it("skip declined in the confirmation: nothing is sent and nothing changes", async () => {
    const repo = conflictingRebase();
    try {
      const before = repo.git("status", "--porcelain");
      const r = recorder();
      let asked = 0;
      await runRebaseStep(repo.root, skipRebase, r.post, { confirm: async () => { asked++; return false; } });
      assert.strictEqual(asked, 1);
      assert.deepStrictEqual(r.sent, []);
      assert.ok(await isRebaseInProgress(repo.root));
      assert.strictEqual(repo.git("status", "--porcelain"), before);
    } finally {
      repo.dispose();
    }
  });

  it("skip confirmed twice: drops both feature commits and finishes", async () => {
    const repo = conflictingRebase();
    try {
      const yes = { confirm: async () => true, stillPausedMessage: STILL };
      const first = recorder();
      await runRebaseStep(repo.root, skipRebase, first.post, yes);
      // Skipping onto the next conflicting commit: still paused, said once, then reload.
      assert.deepStrictEqual(first.types(), ["rebaseError", "reloadNow"]);
      assert.ok((first.sent[0] as { message: string }).message.startsWith(STILL));
      assert.ok(await isRebaseInProgress(repo.root));
      const second = recorder();
      await runRebaseStep(repo.root, skipRebase, second.post, yes);
      assert.deepStrictEqual(second.types(), ["rebaseDone", "reloadNow"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "main change");
    } finally {
      repo.dispose();
    }
  });

  it("without a still-paused message, a failing step that leaves the rebase paused reports git's error", async () => {
    const repo = conflictingRebase();
    try {
      const r = recorder();
      await runRebaseStep(repo.root, continueRebase, r.post);
      assert.deepStrictEqual(r.types(), ["rebaseError", "reloadNow"]);
      assert.ok((r.sent[0] as { message: string }).message.length > 0);
    } finally {
      repo.dispose();
    }
  });

  it("a step that fails and leaves no rebase behind reports the failure, not done", async () => {
    const repo = conflictingRebase();
    try {
      const r = recorder();
      await runRebaseStep(repo.root, async (root) => {
        repo.git("rebase", "--abort");
        throw new Error("aborted underneath " + root.length);
      }, r.post, { stillPausedMessage: STILL });
      assert.strictEqual(r.sent[0].type, "rebaseError");
      assert.ok((r.sent[0] as { message: string }).message.startsWith("aborted underneath"));
      assert.deepStrictEqual(r.types(), ["rebaseError", "reloadNow"]);
    } finally {
      repo.dispose();
    }
  });

  it("a step that throws a non-Error still reports a readable message", async () => {
    const repo = conflictingRebase();
    try {
      const r = recorder();
      await runRebaseStep(repo.root, async () => { throw "plain string failure"; }, r.post, { stillPausedMessage: STILL });
      assert.deepStrictEqual(r.sent, [{ type: "rebaseError", message: STILL + "\nplain string failure" }, { type: "reloadNow" }]);
    } finally {
      repo.dispose();
    }
  });
});
