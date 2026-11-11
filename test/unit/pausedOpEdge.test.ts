import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { createTagAt } from "../../src/gitPanelActions";
import {
  readPausedKind,
  readPausedOp,
  runPausedStep,
  type PausedKind,
  type PausedStepMessage,
  type PausedStepTexts,
} from "../../src/pausedOp";
import { TempRepo } from "../helpers/tempRepo";

/** Edge cases for 1.8.0 paused-operation detection / steps and annotated tags, on real repos. */
const TEXTS: PausedStepTexts = { unresolved: (n) => `unresolved ${n}`, stillPaused: "still paused" };

function recorder() {
  const sent: PausedStepMessage[] = [];
  return { sent, post: (m: PausedStepMessage) => void sent.push(m), types: () => sent.map((m) => m.type) };
}

function tryGit(repo: TempRepo, ...args: string[]): void {
  try {
    repo.git(...args);
  } catch {
    /* expected stop */
  }
}

const step = (root: string, kind: PausedKind, which: "continue" | "skip" | "abort", post: (m: PausedStepMessage) => void) =>
  runPausedStep(root, kind, which, post, TEXTS, { confirm: async () => true });

/** main and `other` each change `files` differently. */
function diverged(files: string[] = ["a.txt"]): TempRepo {
  const repo = new TempRepo();
  for (const f of files) repo.write(f, "base\n");
  repo.commitAll("base");
  repo.git("checkout", "-q", "-b", "other");
  for (const f of files) repo.write(f, "other\n");
  repo.commitAll("other change");
  repo.git("checkout", "-q", "main");
  for (const f of files) repo.write(f, "main\n");
  repo.commitAll("main change");
  return repo;
}

function status(repo: TempRepo): string {
  return repo.git("status", "--porcelain");
}

describe("paused edge: detection", function () {
  this.timeout(30_000);

  it("git am stopped (rebase-apply without a rebase) is not reported as a rebase", async () => {
    const repo = diverged();
    try {
      const patch = repo.git("format-patch", "-1", "--stdout", "other");
      const p = path.join(repo.root, "..", path.basename(repo.root) + ".patch");
      fs.writeFileSync(p, patch);
      tryGit(repo, "am", p);
      fs.rmSync(p, { force: true });
      assert.ok(fs.existsSync(path.join(repo.root, ".git", "rebase-apply", "applying")), "git am is paused");
      const kind = await readPausedKind(repo.root);
      // `git rebase --continue/--abort` refuses while `git am` is in progress, so "rebase" would offer buttons that fail.
      assert.notStrictEqual(kind, "rebase", "am session shown as a rebase");
    } finally {
      repo.dispose();
    }
  });

  it("merge --no-commit without conflicts: merge, nothing conflicted, continue commits", async () => {
    const repo = new TempRepo();
    try {
      repo.write("a.txt", "a\n");
      repo.commitAll("base");
      repo.git("checkout", "-q", "-b", "other");
      repo.write("b.txt", "b\n");
      repo.commitAll("add b");
      repo.git("checkout", "-q", "main");
      repo.write("c.txt", "c\n");
      repo.commitAll("add c");
      repo.git("merge", "--no-commit", "--no-ff", "other");
      const op = await readPausedOp(repo.root);
      assert.ok(op);
      assert.strictEqual(op.kind, "merge");
      assert.deepStrictEqual(op.conflicted, []);
      const r = recorder();
      await step(repo.root, "merge", "continue", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.git("rev-list", "--parents", "-1", "HEAD").trim().split(" ").length, 3, "a merge commit");
    } finally {
      repo.dispose();
    }
  });

  for (const kind of ["revert", "cherry-pick"] as const) {
    it(`${kind} --no-commit: whatever is detected, steps leave a consistent state`, async () => {
      const repo = new TempRepo();
      try {
        repo.write("a.txt", "a\n");
        repo.commitAll("base");
        repo.write("b.txt", "b\n");
        const target = repo.commitAll("add b");
        if (kind === "cherry-pick") {
          repo.git("reset", "-q", "--hard", "HEAD~1");
          repo.git("cherry-pick", "--no-commit", target);
        } else {
          repo.git("revert", "--no-commit", target);
        }
        const op = await readPausedOp(repo.root);
        // git leaves no *_HEAD with --no-commit; the changes are just staged. Either null or the
        // right kind is acceptable, never a different kind.
        assert.ok(op === null || op.kind === kind, JSON.stringify(op));
        if (op) {
          const r = recorder();
          await step(repo.root, kind, "abort", r.post);
          assert.strictEqual(await readPausedKind(repo.root), null);
        }
      } finally {
        repo.dispose();
      }
    });
  }

  it("delete/modify and both-added conflicts are listed", async () => {
    const repo = new TempRepo();
    try {
      repo.write("del.txt", "base\n");
      repo.commitAll("base");
      repo.git("checkout", "-q", "-b", "other");
      repo.git("rm", "-q", "del.txt");
      repo.write("added.txt", "other\n");
      repo.commitAll("other");
      repo.git("checkout", "-q", "main");
      repo.write("del.txt", "changed\n");
      repo.write("added.txt", "main\n");
      repo.commitAll("main");
      tryGit(repo, "merge", "other");
      const op = await readPausedOp(repo.root);
      assert.ok(op);
      assert.deepStrictEqual([...op.conflicted].sort(), ["added.txt", "del.txt"]);
    } finally {
      repo.dispose();
    }
  });

  it("file names with spaces, quotes, a newline and non-ASCII", async () => {
    const names = ["with space.txt", "quote\"d'.txt", "한글 파일.txt", "café.txt"];
    if (process.platform !== "win32") names.push("new\nline.txt");
    const repo = diverged(names);
    try {
      tryGit(repo, "merge", "other");
      const op = await readPausedOp(repo.root);
      assert.ok(op);
      assert.deepStrictEqual([...op.conflicted].sort(), [...names].sort());
    } finally {
      repo.dispose();
    }
  });

  it("a linked worktree is paused separately from the main one", async () => {
    const repo = diverged();
    const wt = repo.root + "-wt";
    try {
      repo.git("worktree", "add", "-q", "-b", "wtb", wt, "main");
      tryGit(repo, "-C", wt, "cherry-pick", "other");
      assert.strictEqual((await readPausedOp(wt))?.kind, "cherry-pick");
      assert.strictEqual(await readPausedOp(repo.root), null, "main worktree not paused");
      tryGit(repo, "merge", "other");
      assert.strictEqual((await readPausedOp(repo.root))?.kind, "merge");
      assert.strictEqual((await readPausedOp(wt))?.kind, "cherry-pick");
      const r = recorder();
      await step(wt, "cherry-pick", "abort", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(await readPausedOp(wt), null);
      assert.strictEqual((await readPausedOp(repo.root))?.kind, "merge", "main merge untouched");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      repo.dispose();
    }
  });

  it("a rejecting commit-msg hook (core.hooksPath) during continue: still paused with git's error", async () => {
    const repo = diverged();
    const hooks = path.join(repo.root, ".hooks");
    try {
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\necho 'REJECTED BY HOOK' >&2\nexit 1\n", { mode: 0o755 });
      repo.git("config", "core.hooksPath", hooks);
      tryGit(repo, "merge", "other");
      repo.write("a.txt", "x\n");
      repo.git("add", "a.txt");
      const r = recorder();
      await step(repo.root, "merge", "continue", r.post);
      assert.strictEqual(r.sent[0].type, "opError");
      const msg = (r.sent[0] as { message: string }).message;
      assert.ok(msg.startsWith("still paused"), msg);
      assert.match(msg, /REJECTED BY HOOK/);
      assert.strictEqual(await readPausedKind(repo.root), "merge");
    } finally {
      repo.dispose();
    }
  });
});

describe("paused edge: steps", function () {
  this.timeout(30_000);

  it("abort after partial resolution restores main", async () => {
    const repo = diverged(["a.txt", "b.txt"]);
    try {
      const head = repo.head();
      tryGit(repo, "merge", "other");
      repo.write("a.txt", "resolved\n");
      repo.git("add", "a.txt");
      const op = await readPausedOp(repo.root);
      assert.deepStrictEqual(op?.conflicted, ["b.txt"]);
      const r = recorder();
      await step(repo.root, "merge", "continue", r.post);
      assert.deepStrictEqual(r.sent[0], { type: "opError", message: "unresolved 1" });
      const r2 = recorder();
      await step(repo.root, "merge", "abort", r2.post);
      assert.deepStrictEqual(r2.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(repo.head(), head);
      assert.strictEqual(status(repo), "");
    } finally {
      repo.dispose();
    }
  });

  it("skip on the last commit of a multi-pick ends the cherry-pick", async () => {
    const repo = diverged();
    try {
      repo.git("checkout", "-q", "other");
      repo.write("z.txt", "z\n");
      repo.commitAll("clean pick");
      repo.write("a.txt", "other2\n");
      repo.commitAll("conflicting last");
      repo.git("checkout", "-q", "main");
      tryGit(repo, "cherry-pick", "other~1", "other");
      const op = await readPausedOp(repo.root);
      assert.strictEqual(op?.kind, "cherry-pick");
      assert.strictEqual(op?.subject, "conflicting last");
      const r = recorder();
      await step(repo.root, "cherry-pick", "skip", r.post);
      assert.deepStrictEqual(r.types(), ["opDone", "reloadNow"]);
      assert.strictEqual(await readPausedKind(repo.root), null);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "clean pick");
      assert.strictEqual(status(repo), "");
    } finally {
      repo.dispose();
    }
  });
});

describe("annotated tag edge cases", function () {
  this.timeout(30_000);
  const tagMsg = (repo: TempRepo, t: string) => repo.git("tag", "-l", "--format=%(contents)", t).replace(/\s+$/, "");
  const tagType = (repo: TempRepo, t: string) => repo.git("cat-file", "-t", t).trim();

  it("CRLF message is stored", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("c");
      await createTagAt(repo.root, "v1", "HEAD", "line one\r\n\r\nline two\r\n");
      assert.strictEqual(tagType(repo, "v1"), "tag");
      assert.ok(/line one\r?\n\r?\nline two/.test(tagMsg(repo, "v1")), JSON.stringify(tagMsg(repo, "v1")));
    } finally {
      repo.dispose();
    }
  });

  it("a message starting with '-' is taken as text", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("c");
      await createTagAt(repo.root, "v1", "HEAD", "-d --force\n-m x");
      assert.strictEqual(tagMsg(repo, "v1"), "-d --force\n-m x");
    } finally {
      repo.dispose();
    }
  });

  it("an empty-line-only message makes a lightweight tag", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("c");
      await createTagAt(repo.root, "v1", "HEAD", "\n\n  \r\n");
      assert.strictEqual(tagType(repo, "v1"), "commit");
    } finally {
      repo.dispose();
    }
  });

  it("an existing tag name fails and is not clobbered (annotated and lightweight)", async () => {
    const repo = new TempRepo();
    try {
      const first = repo.commitEmpty("one");
      await createTagAt(repo.root, "v1", "HEAD", "original");
      repo.commitEmpty("two");
      await assert.rejects(createTagAt(repo.root, "v1", "HEAD", "new"));
      await assert.rejects(createTagAt(repo.root, "v1", "HEAD"));
      assert.strictEqual(repo.git("rev-parse", "v1^{commit}").trim(), first);
      assert.strictEqual(tagMsg(repo, "v1"), "original");
    } finally {
      repo.dispose();
    }
  });
});
