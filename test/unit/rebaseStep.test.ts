import * as assert from "assert";
import { isRebaseInProgress } from "../../src/rebaseRun";
import { runPausedGitStep, runPausedStep, type PausedStepMessage, type PausedStepTexts } from "../../src/pausedOp";
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
  const sent: PausedStepMessage[] = [];
  return { sent, post: (m: PausedStepMessage) => void sent.push(m), types: () => sent.map((m) => m.type) };
}

const STILL = "still paused";
const TEXTS: PausedStepTexts = { unresolved: (n) => `unresolved ${n}`, stillPaused: STILL };
type StepFn = (root: string) => Promise<unknown>;
/** The banner's rebase step; `run` replaces the git call (to simulate failures). */
const step = (root: string, which: "continue" | "skip", post: (m: PausedStepMessage) => void,
  opts: { confirm?: () => Promise<boolean>; run?: StepFn } = {}) =>
  runPausedStep(root, "rebase", which, post, TEXTS, {
    confirm: opts.confirm,
    run: opts.run ? (r) => opts.run!(r).then(() => undefined) : runPausedGitStep,
  });

describe("rebase continue / skip step", function () {
  this.timeout(30_000);

  it("with no rebase running: reports done and reloads, without running the step", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("only");
      const r = recorder();
      let ran = false;
      await step(repo.root, "continue", r.post, { run: async () => { ran = true; } });
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(ran, false);
    } finally {
      repo.dispose();
    }
  });

  it("continue with the conflict unresolved: refused with the count, git is not run", async () => {
    const repo = conflictingRebase();
    try {
      assert.ok(await isRebaseInProgress(repo.root), "fixture is paused on a conflict");
      const r = recorder();
      let ran = false;
      await step(repo.root, "continue", r.post, { run: async () => { ran = true; } });
      assert.deepStrictEqual(r.sent, [{ type: "opError", message: "unresolved 1" }]);
      assert.strictEqual(ran, false);
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
      await step(repo.root, "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opError", "reloadNow"]);
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
      await step(repo.root, "continue", () => undefined);
      resolve(repo, "two\n");
      const r = recorder();
      await step(repo.root, "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
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
      await step(repo.root, "skip", r.post, { confirm: async () => { asked++; return false; } });
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
      const yes = { confirm: async () => true };
      const first = recorder();
      await step(repo.root, "skip", first.post, yes);
      // Skipping onto the next conflicting commit: still paused, said once, then reload.
      assert.deepStrictEqual(first.types(), ["opError", "reloadNow"]);
      assert.ok((first.sent[0] as { message: string }).message.startsWith(STILL));
      assert.ok(await isRebaseInProgress(repo.root));
      const second = recorder();
      await step(repo.root, "skip", second.post, yes);
      assert.deepStrictEqual(second.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "main change");
    } finally {
      repo.dispose();
    }
  });

  it("a step that fails and leaves no rebase behind reports the failure, not done", async () => {
    const repo = conflictingRebase();
    try {
      const r = recorder();
      await step(repo.root, "skip", r.post, { run: async (root) => {
        repo.git("rebase", "--abort");
        throw new Error("aborted underneath " + root.length);
      } });
      assert.strictEqual(r.sent[0].type, "opError");
      assert.ok((r.sent[0] as { message: string }).message.startsWith("aborted underneath"));
      assert.deepStrictEqual(r.types(), ["opError", "reloadNow"]);
    } finally {
      repo.dispose();
    }
  });

  it("a step that throws a non-Error still reports a readable message", async () => {
    const repo = conflictingRebase();
    try {
      const r = recorder();
      await step(repo.root, "skip", r.post, { run: async () => { throw "plain string failure"; } });
      assert.deepStrictEqual(r.sent, [{ type: "opError", message: STILL + "\nplain string failure" }, { type: "reloadNow" }]);
    } finally {
      repo.dispose();
    }
  });
});
