import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { readPausedKind } from "../../src/pausedOp";
import { buildRebaseTodo, readRebaseCommits, REWORD_TOO_LONG, runInteractiveRebase, type RebaseTodoItem } from "../../src/rebaseRun";
import { TempRepo } from "../helpers/tempRepo";

/** Reword edge cases (issue #4) and the review findings around it, against real repositories. */

const msgOf = (repo: TempRepo, rev = "HEAD") => repo.git("log", "-1", "--format=%B", rev).replace(/\s+$/, "");

function linear(n: number): { repo: TempRepo; base: string } {
  const repo = new TempRepo();
  repo.write("f0.txt", "0\n");
  const base = repo.commitAll("base");
  for (let i = 1; i <= n; i++) {
    repo.write(`f${i}.txt`, `${i}\n`);
    repo.commitAll(`c${i}`);
  }
  return { repo, base };
}

async function rows(repo: TempRepo, base: string | null): Promise<RebaseTodoItem[]> {
  return (await readRebaseCommits(repo.root, base)).map((r) => ({ sha: r.sha, subject: r.subject, action: "pick" as const }));
}

describe("reword edge: messages", function () {
  this.timeout(60_000);

  const SPECIAL = [
    "back\\slash \\n \\t and a trailing \\",
    "$(touch pwned) `touch pwned2` ${HOME} $HOME",
    "%s %d %% %b \\x41",
    "# only comment-like\n# lines",
    "-e -n --help",
    "'single' \"double\" ''' \"\"\"",
    "x".repeat(2000),
  ];

  for (const message of SPECIAL) {
    it(`kept verbatim, nothing executed: ${JSON.stringify(message.slice(0, 40))}`, async () => {
      const { repo, base } = linear(2);
      try {
        const items = await rows(repo, base);
        items[0] = { ...items[0], action: "reword", message };
        await runInteractiveRebase(repo.root, base, items);
        assert.strictEqual(msgOf(repo, "HEAD~1"), message);
        assert.ok(!fs.existsSync(path.join(repo.root, "pwned")) && !fs.existsSync(path.join(repo.root, "pwned2")), "no command ran");
      } finally {
        repo.dispose();
      }
    });
  }

  it("CRLF and a 200-line body", async () => {
    const { repo, base } = linear(1);
    try {
      const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n");
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: `subject\r\n\r\n${body}` };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(msgOf(repo), `subject\n\n${body.replace(/\r\n/g, "\n")}`);
    } finally {
      repo.dispose();
    }
  });

  it("a message too long for one exec line is refused before anything is rewritten", async () => {
    const { repo, base } = linear(1);
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: "y".repeat(40000) };
      await assert.rejects(runInteractiveRebase(repo.root, base, items), new RegExp(REWORD_TOO_LONG));
      assert.strictEqual(repo.git("rev-parse", "HEAD").trim(), head);
      assert.strictEqual(await readPausedKind(repo.root), null);
    } finally {
      repo.dispose();
    }
  });
});

describe("reword edge: todo combinations", function () {
  this.timeout(60_000);

  it("two rewords in one rebase", async () => {
    const { repo, base } = linear(3);
    try {
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: "first" };
      items[2] = { ...items[2], action: "reword", message: "third" };
      await runInteractiveRebase(repo.root, base, items);
      assert.deepStrictEqual(repo.git("log", "--format=%s", `${base}..HEAD`).trim().split("\n"), ["third", "c2", "first"]);
    } finally {
      repo.dispose();
    }
  });

  it("reword then drop the next commit; reword then fixup into it", async () => {
    const { repo, base } = linear(3);
    try {
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: "kept" };
      items[1] = { ...items[1], action: "drop" };
      items[2] = { ...items[2], action: "fixup" };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(repo.git("rev-list", "--count", `${base}..HEAD`).trim(), "1");
      assert.strictEqual(msgOf(repo), "kept", "fixup keeps the reworded message");
      assert.ok(!fs.existsSync(path.join(repo.root, "f2.txt")) && fs.existsSync(path.join(repo.root, "f3.txt")));
    } finally {
      repo.dispose();
    }
  });

  it("a reword for a sha that does not exist fails without leaving a rebase behind", async () => {
    const { repo, base } = linear(1);
    try {
      const items = await rows(repo, base);
      items.push({ sha: "f".repeat(40), subject: "ghost", action: "reword", message: "ghost" });
      await assert.rejects(runInteractiveRebase(repo.root, base, items));
      assert.strictEqual(await readPausedKind(repo.root), null);
    } finally {
      repo.dispose();
    }
  });

  it("a rejecting commit-msg / pre-commit hook does not drop the reword", async () => {
    const { repo, base } = linear(2);
    try {
      const hooks = path.join(repo.root, ".hooks");
      fs.mkdirSync(hooks);
      for (const h of ["commit-msg", "pre-commit"]) {
        fs.writeFileSync(path.join(hooks, h), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      }
      repo.git("config", "core.hooksPath", hooks);
      const items = await rows(repo, base);
      items[0] = { ...items[0], action: "reword", message: "despite hooks" };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(msgOf(repo, "HEAD~1"), "despite hooks");
      assert.strictEqual(await readPausedKind(repo.root), null);
    } finally {
      repo.dispose();
    }
  });
});

describe("rebase list leaves merge commits out (as git rebase -i does)", function () {
  this.timeout(60_000);

  it("a merged side branch: its commits are listed, the merge commit is not, and applying works", async () => {
    const { repo, base } = linear(1);
    try {
      repo.git("checkout", "-q", "-b", "side");
      repo.write("side.txt", "s\n");
      repo.commitAll("side work");
      repo.git("checkout", "-q", "main");
      repo.write("m.txt", "m\n");
      repo.commitAll("main work");
      repo.git("merge", "--no-ff", "-q", "-m", "Merge side", "side");
      const list = await readRebaseCommits(repo.root, base);
      assert.ok(!list.some((r) => r.subject === "Merge side"), list.map((r) => r.subject).join(", "));
      assert.ok(list.some((r) => r.subject === "side work"));
      const items = list.map((r) => ({ sha: r.sha, subject: r.subject, action: "pick" as const })) as RebaseTodoItem[];
      const i = items.findIndex((x) => x.subject === "main work");
      items[i] = { ...items[i], action: "reword", message: "main work, reworded" };
      await runInteractiveRebase(repo.root, base, items);
      assert.strictEqual(await readPausedKind(repo.root), null);
      assert.ok(repo.git("log", "--format=%s").includes("main work, reworded"));
    } finally {
      repo.dispose();
    }
  });
});

describe("todo building guards", () => {
  it("empty item list → just a newline (git then has nothing to do)", () => {
    assert.strictEqual(buildRebaseTodo([]), "\n");
  });
});
