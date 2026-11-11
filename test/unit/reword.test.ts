import * as assert from "assert";
import { readPausedKind, runPausedGitStep } from "../../src/pausedOp";
import { buildRebaseTodo, readRebaseCommits, runInteractiveRebase, type RebaseTodoItem } from "../../src/rebaseRun";
import { TempRepo } from "../helpers/tempRepo";

/** Issue #4: reword in the interactive rebase editor, against real repositories. */

const msgOf = (repo: TempRepo, rev = "HEAD") => repo.git("log", "-1", "--format=%B", rev).replace(/\s+$/, "");
const treeOf = (repo: TempRepo, rev = "HEAD") => repo.git("rev-parse", `${rev}^{tree}`).trim();

function threeCommits(): { repo: TempRepo; base: string } {
  const repo = new TempRepo();
  repo.write("a.txt", "a\n");
  const base = repo.commitAll("base");
  repo.write("b.txt", "b\n");
  repo.commitAll("add b");
  repo.write("c.txt", "c\n");
  repo.commitAll("add c\n\nbody of c");
  return { repo, base };
}

async function rows(repo: TempRepo, base: string): Promise<RebaseTodoItem[]> {
  return (await readRebaseCommits(repo.root, base)).map((r) => ({ sha: r.sha, subject: r.subject, action: "pick" as const }));
}

describe("reword: todo", () => {
  const sha = "a".repeat(40);

  it("an unchanged (or blank) reword is a plain pick", () => {
    const item: RebaseTodoItem = { sha, subject: "s", action: "reword", message: "same\n\nbody\n" };
    assert.strictEqual(buildRebaseTodo([item], { [sha]: "same\n\nbody" }), `pick ${sha} s\n`);
    assert.strictEqual(buildRebaseTodo([{ ...item, message: "  " }], {}), `pick ${sha} s\n`);
  });

  it("a changed reword is pick + exec with one quoted argument per line", () => {
    const todo = buildRebaseTodo([{ sha, subject: "s", action: "reword", message: "it's new\r\n\r\nline" }], { [sha]: "old" });
    const [pick, exec, end] = todo.split("\n");
    assert.strictEqual(pick, `pick ${sha} s`);
    assert.strictEqual(exec, `exec printf '%s\\n' 'it'\\''s new' '' 'line' | git commit --amend --only --allow-empty --no-verify --cleanup=whitespace -F -`);
    assert.strictEqual(end, "");
  });

  it("a subject with a newline cannot start a todo line of its own", () => {
    const todo = buildRebaseTodo([{ sha, subject: "x\nexec touch pwned", action: "pick" }]);
    assert.strictEqual(todo, `pick ${sha} x exec touch pwned\n`);
  });
});

describe("reword: rebase", function () {
  this.timeout(30_000);

  it("the editor gets each commit's full message (subject and body)", async () => {
    const { repo, base } = threeCommits();
    try {
      const r = await readRebaseCommits(repo.root, base);
      assert.deepStrictEqual(r.map((x) => x.message), ["add b", "add c\n\nbody of c"]);
    } finally {
      repo.dispose();
    }
  });

  it("rewrites only the message: quotes, #, leading dash, blank lines and 한글 survive; the tree is the same", async () => {
    const { repo, base } = threeCommits();
    try {
      const before = treeOf(repo);
      const items = await rows(repo, base);
      const message = "-n \"Add\" b's file\n\n# not a comment\n한글 본문 $HOME `x` \\n";
      items[0] = { ...items[0], action: "reword", message };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(msgOf(repo, "HEAD~1"), message);
      assert.strictEqual(msgOf(repo), "add c\n\nbody of c", "the other commit is untouched");
      assert.strictEqual(treeOf(repo), before);
      assert.strictEqual(await readPausedKind(repo.root), null);
    } finally {
      repo.dispose();
    }
  });

  it("reword the first commit, then squash the next into it: the combined message starts with the new one", async () => {
    const { repo, base } = threeCommits();
    try {
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: "b and c" };
      items[1] = { ...items[1], action: "squash" };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(repo.git("rev-list", "--count", `${base}..HEAD`).trim(), "1");
      assert.ok(msgOf(repo).startsWith("b and c"), msgOf(repo));
    } finally {
      repo.dispose();
    }
  });

  it("a rebase that stops on a conflict first still applies the new message after Continue", async () => {
    const repo = new TempRepo();
    try {
      repo.write("a.txt", "0\n");
      const base = repo.commitAll("base");
      repo.write("a.txt", "1\n");
      repo.commitAll("one");
      repo.write("a.txt", "2\n");
      repo.commitAll("two");
      // Swap them: "two" now applies first onto "0" and conflicts.
      const [one, two] = await rows(repo, base);
      await assert.rejects(runInteractiveRebase(repo.root, base, [{ ...two, action: "reword", message: "two, reworded" }, one]));
      assert.strictEqual(await readPausedKind(repo.root), "rebase");
      repo.write("a.txt", "2\n");
      repo.git("add", "a.txt");
      try {
        await runPausedGitStep(repo.root, "rebase", "continue"); // runs the exec, then picks "one" (conflicts again)
      } catch {
        /* the next pick conflicts */
      }
      repo.write("a.txt", "1\n");
      repo.git("add", "a.txt");
      await runPausedGitStep(repo.root, "rebase", "continue");
      assert.strictEqual(await readPausedKind(repo.root), null);
      assert.strictEqual(msgOf(repo, "HEAD~1"), "two, reworded");
      assert.strictEqual(msgOf(repo), "one");
    } finally {
      repo.dispose();
    }
  });

  it("reword on the root commit (--root)", async () => {
    const repo = new TempRepo();
    try {
      repo.write("a.txt", "a\n");
      repo.commitAll("root");
      repo.commitEmpty("second");
      const items = (await readRebaseCommits(repo.root, null)).map((r) => ({ sha: r.sha, subject: r.subject, action: "pick" as const })) as RebaseTodoItem[];
      items[0] = { ...items[0], action: "reword", message: "new root" };
      await runInteractiveRebase(repo.root, null, items);
      assert.strictEqual(msgOf(repo, "HEAD~1"), "new root");
      assert.strictEqual(msgOf(repo), "second", "an empty commit stays");
    } finally {
      repo.dispose();
    }
  });
});
