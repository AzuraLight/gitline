import * as assert from "assert";
import { createTagAt } from "../../src/gitPanelActions";
import {
  canSkip,
  readPausedKind,
  readPausedOp,
  runPausedStep,
  type PausedKind,
  type PausedStepMessage,
  type PausedStepTexts,
} from "../../src/pausedOp";
import { TempRepo } from "../helpers/tempRepo";

/**
 * Merge / cherry-pick / revert stopped on a real conflict: what the banner reads, and continue /
 * skip / abort judged by the state git is left in.
 */
const TEXTS: PausedStepTexts = { unresolved: (n) => `unresolved ${n}`, stillPaused: "still paused" };

function recorder() {
  const sent: PausedStepMessage[] = [];
  return { sent, post: (m: PausedStepMessage) => void sent.push(m), types: () => sent.map((m) => m.type) };
}

/** main and `other` both rewrite a.txt. Returns the repo on main with `other` unmerged. */
function diverged(): TempRepo {
  const repo = new TempRepo();
  repo.write("a.txt", "base\n");
  repo.commitAll("base");
  repo.git("checkout", "-q", "-b", "other");
  repo.write("a.txt", "other\n");
  repo.commitAll("other change");
  repo.git("checkout", "-q", "main");
  repo.write("a.txt", "main\n");
  repo.commitAll("main change");
  return repo;
}

function tryGit(repo: TempRepo, ...args: string[]): void {
  try {
    repo.git(...args);
  } catch {
    // expected: stops on the conflict
  }
}

function resolve(repo: TempRepo, content: string, file = "a.txt"): void {
  repo.write(file, content);
  repo.git("add", file);
}

const step = (repo: TempRepo, kind: PausedKind, which: "continue" | "skip" | "abort", post: (m: PausedStepMessage) => void) =>
  runPausedStep(repo.root, kind, which, post, TEXTS, { confirm: async () => true });

describe("paused operations: detection", function () {
  this.timeout(30_000);

  it("nothing in progress → null", async () => {
    const repo = diverged();
    try {
      assert.strictEqual(await readPausedOp(repo.root), null);
    } finally {
      repo.dispose();
    }
  });

  it("merge: kind, merge message as subject, conflicted files", async () => {
    const repo = diverged();
    try {
      tryGit(repo, "merge", "other");
      const op = await readPausedOp(repo.root);
      assert.ok(op);
      assert.strictEqual(op.kind, "merge");
      assert.match(op.subject, /Merge branch 'other'/);
      assert.deepStrictEqual(op.conflicted, ["a.txt"]);
      assert.strictEqual(canSkip("merge"), false);
    } finally {
      repo.dispose();
    }
  });

  it("cherry-pick and revert: the commit's subject; non-ASCII file names come through", async () => {
    const repo = diverged();
    try {
      repo.git("checkout", "-q", "other");
      repo.write("한글 파일.txt", "other\n");
      repo.commitAll("add 한글");
      repo.git("checkout", "-q", "main");
      repo.write("한글 파일.txt", "main\n");
      repo.commitAll("main 한글");
      tryGit(repo, "cherry-pick", "other");
      const pick = await readPausedOp(repo.root);
      assert.strictEqual(pick?.kind, "cherry-pick");
      assert.strictEqual(pick?.subject, "add 한글");
      assert.deepStrictEqual(pick?.conflicted, ["한글 파일.txt"]);
      repo.git("cherry-pick", "--abort");

      repo.write("a.txt", "main again\n");
      repo.commitAll("touch a again");
      tryGit(repo, "revert", "--no-edit", "HEAD~2"); // reverting "main change" clashes with the newer edit
      const rev = await readPausedOp(repo.root);
      assert.strictEqual(rev?.kind, "revert");
      assert.strictEqual(rev?.subject, "main change");
      assert.ok(rev && rev.conflicted.length === 1);
    } finally {
      repo.dispose();
    }
  });

  it("a multi-commit cherry-pick resolved and committed by hand still shows as paused (sequencer)", async () => {
    const repo = diverged();
    try {
      repo.git("checkout", "-q", "other");
      repo.write("b.txt", "b\n");
      repo.commitAll("other b");
      repo.git("checkout", "-q", "main");
      tryGit(repo, "cherry-pick", "other~1", "other");
      resolve(repo, "picked\n");
      repo.git("-c", "core.editor=true", "commit", "--no-edit"); // the user commits the resolution
      assert.strictEqual(await readPausedKind(repo.root), "cherry-pick", "the second pick is still to do");
      const r = recorder();
      await step(repo, "cherry-pick", "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "other b");
    } finally {
      repo.dispose();
    }
  });

  it("a rebase shows the branch and its progress", async () => {
    const repo = diverged();
    try {
      repo.git("checkout", "-q", "other");
      tryGit(repo, "rebase", "main");
      const op = await readPausedOp(repo.root);
      assert.strictEqual(op?.kind, "rebase");
      assert.strictEqual(op?.subject, "other");
      assert.strictEqual(op?.step, 1);
      assert.strictEqual(op?.total, 1);
    } finally {
      repo.dispose();
    }
  });
});

describe("paused operations: continue / skip / abort", function () {
  this.timeout(30_000);

  it("merge: continue refused while conflicted, then finishes without an editor", async () => {
    const repo = diverged();
    try {
      tryGit(repo, "merge", "other");
      const r = recorder();
      await step(repo, "merge", "continue", r.post);
      assert.deepStrictEqual(r.sent, [{ type: "opError", message: "unresolved 1" }]);
      resolve(repo, "both\n");
      const r2 = recorder();
      await step(repo, "merge", "continue", r2.post);
      assert.deepStrictEqual(r2.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(await readPausedKind(repo.root), null);
      assert.strictEqual(repo.git("log", "-1", "--format=%P").trim().split(" ").length, 2, "a merge commit");
      assert.match(repo.git("log", "-1", "--format=%s"), /Merge branch 'other'/, "git's prepared message kept");
    } finally {
      repo.dispose();
    }
  });

  it("merge: abort restores the branch; declined confirmation changes nothing", async () => {
    const repo = diverged();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      tryGit(repo, "merge", "other");
      const no = recorder();
      await runPausedStep(repo.root, "merge", "abort", no.post, TEXTS, { confirm: async () => false });
      assert.deepStrictEqual(no.sent, []);
      assert.strictEqual(await readPausedKind(repo.root), "merge");
      const r = recorder();
      await step(repo, "merge", "abort", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("rev-parse", "HEAD").trim(), head);
      assert.strictEqual(repo.git("status", "--porcelain").trim(), "");
    } finally {
      repo.dispose();
    }
  });

  it("cherry-pick: continue after resolving keeps the original message; skip drops it", async () => {
    const repo = diverged();
    try {
      tryGit(repo, "cherry-pick", "other");
      resolve(repo, "resolved\n");
      const r = recorder();
      await step(repo, "cherry-pick", "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "other change");

      repo.git("reset", "-q", "--hard", "HEAD~1");
      tryGit(repo, "cherry-pick", "other");
      const s = recorder();
      await step(repo, "cherry-pick", "skip", s.post);
      assert.deepStrictEqual(s.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "main change");
    } finally {
      repo.dispose();
    }
  });

  it("revert: continue after resolving makes the revert commit", async () => {
    const repo = diverged();
    try {
      repo.write("a.txt", "main again\n");
      repo.commitAll("touch a again");
      tryGit(repo, "revert", "--no-edit", "HEAD~1");
      resolve(repo, "reverted by hand\n");
      const r = recorder();
      await step(repo, "revert", "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.match(repo.git("log", "-1", "--format=%s"), /^Revert "main change"/);
    } finally {
      repo.dispose();
    }
  });

  it("a stale banner (operation already finished, or another one running) only reloads", async () => {
    const repo = diverged();
    try {
      const r = recorder();
      await step(repo, "merge", "abort", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      tryGit(repo, "cherry-pick", "other");
      const r2 = recorder();
      await step(repo, "merge", "abort", r2.post);
      assert.deepStrictEqual(r2.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(await readPausedKind(repo.root), "cherry-pick", "the cherry-pick was not touched");
    } finally {
      repo.dispose();
    }
  });
});

describe("annotated tags", function () {
  this.timeout(30_000);

  it("with a message: annotated, message kept verbatim; without: lightweight", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("one");
      await createTagAt(repo.root, "v1", "HEAD", "-n Release one\n\nwith \"quotes\" and 한글");
      assert.strictEqual(repo.git("cat-file", "-t", "v1").trim(), "tag");
      assert.strictEqual(repo.git("tag", "-l", "--format=%(contents)", "v1").trim(), "-n Release one\n\nwith \"quotes\" and 한글");
      await createTagAt(repo.root, "v2", "HEAD", "   ");
      assert.strictEqual(repo.git("cat-file", "-t", "v2").trim(), "commit", "blank message → lightweight");
      await createTagAt(repo.root, "v3", "HEAD");
      assert.strictEqual(repo.git("cat-file", "-t", "v3").trim(), "commit");
    } finally {
      repo.dispose();
    }
  });
});

describe("paused operations: --no-commit (review follow-up)", function () {
  this.timeout(30_000);

  for (const cmd of [["cherry-pick", "--no-commit", "other"], ["revert", "--no-commit", "HEAD"]] as const) {
    it(`${cmd[0]} --no-commit without conflicts matches what git status says, and Continue / Abort work`, async () => {
      const repo = new TempRepo();
      try {
        repo.write("a.txt", "base\n");
        repo.commitAll("base");
        repo.git("checkout", "-q", "-b", "other");
        repo.write("b.txt", "b\n");
        repo.commitAll("other b");
        repo.git("checkout", "-q", "main");
        repo.write("c.txt", "c\n");
        repo.commitAll("main c");
        repo.git(...cmd);
        const kind = await readPausedKind(repo.root);
        const gitSays = /(cherry-pick|revert)ing|in progress/i.test(repo.git("status"));
        assert.strictEqual(kind !== null, gitSays, `kind=${kind}, git status:\n${repo.git("status")}`);
        if (kind) {
          const r = recorder();
          await step(repo, kind, "abort", r.post);
          assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
          assert.strictEqual(await readPausedKind(repo.root), null);
        }
      } finally {
        repo.dispose();
      }
    });
  }
});
