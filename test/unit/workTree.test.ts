import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  canStashStagedOnly,
  cleanUntracked,
  commit,
  discardAllTracked,
  discardFile,
  EMPTY_MESSAGE,
  headIsPushed,
  lastCommitMessage,
  NO_COMMIT_YET,
  parseStatusV2,
  planDiscard,
  readWorkingFiles,
  stageAll,
  stagePaths,
  stashPush,
  unstagePaths,
  untrackedToClean,
} from "../../src/workTree";
import { TempRepo } from "../helpers/tempRepo";

/** 1.9.0 working-tree writes, against real repositories. */

const names = (list: { path: string }[]) => list.map((f) => f.path).sort();
const exists = (repo: TempRepo, p: string) => fs.existsSync(path.join(repo.root, p));
const read = (repo: TempRepo, p: string) => fs.readFileSync(path.join(repo.root, p), "utf8");

describe("work tree: status", () => {
  it("parses porcelain v2: renames, both staged and unstaged, spaces, untracked, conflicts", () => {
    const out = [
      "1 M. N... 100644 100644 100644 aaa bbb staged only.txt",
      "1 MM N... 100644 100644 100644 aaa bbb both.txt",
      "1 .D N... 100644 100644 000000 aaa aaa gone.txt",
      "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc fight.txt",
      "? 한글 파일.txt",
      "",
    ].join("\0");
    const f = parseStatusV2(out);
    assert.deepStrictEqual(f.staged, [
      { path: "staged only.txt", status: "M" },
      { path: "both.txt", status: "M" },
      { path: "new name.txt", status: "R", orig: "old name.txt" },
    ]);
    assert.deepStrictEqual(f.unstaged, [{ path: "both.txt", status: "M" }, { path: "gone.txt", status: "D" }]);
    assert.deepStrictEqual(f.untracked, [{ path: "한글 파일.txt", status: "?" }]);
    assert.deepStrictEqual(f.conflicted, [{ path: "fight.txt", status: "U" }]);
  });
});

describe("work tree: stage, unstage, commit, amend", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo();
  });
  afterEach(() => repo.dispose());

  it("first commit on a branch with no commits: stage, unstage, stage, commit", async () => {
    repo.write("a.txt", "a\n");
    repo.write("-dash.txt", "d\n");
    repo.write("dir/한글 파일.txt", "k\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), ["-dash.txt", "a.txt", "dir/한글 파일.txt"]);
    await stagePaths(repo.root, ["a.txt", "-dash.txt", "dir/한글 파일.txt"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), ["-dash.txt", "a.txt", "dir/한글 파일.txt"]);
    await unstagePaths(repo.root, ["-dash.txt"]); // no HEAD yet
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), ["a.txt", "dir/한글 파일.txt"]);
    assert.deepStrictEqual(names(f.untracked), ["-dash.txt"]);
    await commit(repo.root, "first\n\n# kept as typed");
    assert.strictEqual(await lastCommitMessage(repo.root), "first\n\n# kept as typed");
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), []);
    assert.deepStrictEqual(names(f.untracked), ["-dash.txt"]);
  });

  it("unstage after HEAD exists keeps the working copy; a deletion can be staged", async () => {
    repo.write("a.txt", "1\n");
    repo.write("b.txt", "b\n");
    repo.commitAll("base");
    repo.write("a.txt", "2\n");
    fs.rmSync(path.join(repo.root, "b.txt"));
    await stagePaths(repo.root, ["a.txt", "b.txt"]);
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged.map((x) => x.status).sort(), ["D", "M"]);
    await unstagePaths(repo.root, ["a.txt"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.unstaged), ["a.txt"]);
    assert.strictEqual(read(repo, "a.txt"), "2\n");
  });

  it("empty message refused before git; amend rewrites HEAD with staged files and a new message", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.write("a.txt", "2\n");
    await stagePaths(repo.root, ["a.txt"]);
    await assert.rejects(commit(repo.root, "  \n "), new RegExp(EMPTY_MESSAGE));
    await commit(repo.root, "second");
    const before = repo.git("rev-list", "--count", "HEAD").trim();
    repo.write("c.txt", "c\n");
    await stagePaths(repo.root, ["c.txt"]);
    await commit(repo.root, "second, amended", { amend: true });
    assert.strictEqual(repo.git("rev-list", "--count", "HEAD").trim(), before, "no new commit");
    assert.strictEqual(await lastCommitMessage(repo.root), "second, amended");
    assert.ok(repo.git("show", "--name-only", "--format=", "HEAD").includes("c.txt"));
  });

  it("CRLF messages are normalized; nothing staged gives git's error; stageAll adds everything", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    await assert.rejects(commit(repo.root, "nothing"));
    repo.write("a.txt", "2\n");
    repo.write("new.txt", "n\n");
    await stageAll(repo.root);
    await commit(repo.root, "line one\r\n\r\nbody");
    assert.strictEqual(await lastCommitMessage(repo.root), "line one\n\nbody");
    assert.deepStrictEqual((await readWorkingFiles(repo.root)).untracked, []);
  });

  it("a failing pre-commit hook stops the commit and its output reaches the error", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    const hooks = path.join(repo.root, ".hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'lint failed: a.txt' >&2\nexit 1\n", { mode: 0o755 });
    repo.git("config", "core.hooksPath", hooks);
    repo.write("a.txt", "2\n");
    await stagePaths(repo.root, ["a.txt"]);
    await assert.rejects(commit(repo.root, "blocked"), /lint failed: a\.txt/);
    assert.strictEqual(await lastCommitMessage(repo.root), "base");
  });

  it("headIsPushed: false before pushing, true after", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-bare-"));
    try {
      repo.git("init", "-q", "--bare", bare);
      repo.commitEmpty("base");
      repo.git("remote", "add", "origin", bare);
      assert.strictEqual(await headIsPushed(repo.root), false);
      repo.git("push", "-q", "-u", "origin", "main");
      assert.strictEqual(await headIsPushed(repo.root), true);
      repo.commitEmpty("local only");
      assert.strictEqual(await headIsPushed(repo.root), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("work tree: stash and discard", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo();
    repo.write(".gitignore", "ignored.log\n");
    repo.write("a.txt", "1\n");
    repo.write("b.txt", "b\n");
    repo.commitAll("base");
  });
  afterEach(() => repo.dispose());

  it("stash includes untracked files by default and keeps the message", async () => {
    repo.write("a.txt", "2\n");
    repo.write("new.txt", "n\n");
    await stashPush(repo.root, { message: "wip: try\nsomething" });
    assert.strictEqual(read(repo, "a.txt"), "1\n");
    assert.ok(!exists(repo, "new.txt"));
    assert.match(repo.git("stash", "list"), /wip: try something/);
  });

  it("stash without untracked leaves them; staged-only stashes just the index (git 2.35+)", async function () {
    repo.write("a.txt", "2\n");
    repo.write("new.txt", "n\n");
    await stashPush(repo.root, { includeUntracked: false });
    assert.ok(exists(repo, "new.txt"));
    repo.git("stash", "pop", "-q");
    if (!(await canStashStagedOnly(repo.root))) this.skip();
    repo.write("b.txt", "b2\n");
    await stagePaths(repo.root, ["b.txt"]);
    await stashPush(repo.root, { stagedOnly: true });
    assert.strictEqual(read(repo, "b.txt"), "b\n", "staged change stashed");
    assert.strictEqual(read(repo, "a.txt"), "2\n", "unstaged change kept");
  });

  it("discard all keeps untracked and ignored files; clean removes untracked, keeps ignored", async () => {
    repo.write("a.txt", "2\n");
    repo.write("b.txt", "b2\n");
    await stagePaths(repo.root, ["b.txt"]);
    repo.write("new dir/x.txt", "x\n");
    repo.write("ignored.log", "log\n");
    await discardAllTracked(repo.root);
    assert.strictEqual(read(repo, "a.txt"), "1\n");
    assert.strictEqual(read(repo, "b.txt"), "b\n");
    assert.ok(exists(repo, "new dir/x.txt"));
    assert.deepStrictEqual(await untrackedToClean(repo.root), ["new dir/"]);
    await cleanUntracked(repo.root);
    assert.ok(!exists(repo, "new dir"));
    assert.ok(exists(repo, "ignored.log"), "ignored files are not cleaned");
  });

  it("discard one file per group", async () => {
    repo.write("a.txt", "2\n");
    await discardFile(repo.root, "a.txt", "unstaged");
    assert.strictEqual(read(repo, "a.txt"), "1\n");

    repo.write("b.txt", "b2\n");
    await stagePaths(repo.root, ["b.txt"]);
    repo.write("b.txt", "b3\n");
    await discardFile(repo.root, "b.txt", "staged");
    assert.strictEqual(read(repo, "b.txt"), "b\n");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), { staged: [], unstaged: [], untracked: [], conflicted: [] });

    repo.write("added.txt", "x\n");
    await stagePaths(repo.root, ["added.txt"]);
    await discardFile(repo.root, "added.txt", "staged");
    assert.ok(!exists(repo, "added.txt"), "an added file goes away");

    repo.write("-new.txt", "n\n");
    await discardFile(repo.root, "-new.txt", "untracked");
    assert.ok(!exists(repo, "-new.txt"));
    await assert.rejects(discardFile(repo.root, "a.txt", "conflicted"));
  });

  it("names are not patterns: '*.txt' and '[ab].txt' touch only themselves", async function () {
    if (process.platform === "win32") this.skip(); // * is not allowed in Windows file names
    repo.write("*.txt", "star\n");
    repo.write("keep.txt", "k\n");
    await discardFile(repo.root, "*.txt", "untracked");
    assert.ok(!exists(repo, "*.txt") && exists(repo, "keep.txt"));
    repo.write("[ab].txt", "x\n");
    repo.write("a.txt", "2\n");
    await stagePaths(repo.root, ["[ab].txt"]);
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), ["[ab].txt"], "a.txt not staged by the pattern");
    assert.deepStrictEqual(names(f.unstaged), ["a.txt"]);
  });

  it("discard all on a branch with no commits is refused", async () => {
    const fresh = new TempRepo();
    try {
      fresh.write("a.txt", "a\n");
      await stagePaths(fresh.root, ["a.txt"]);
      await assert.rejects(discardAllTracked(fresh.root), new RegExp(NO_COMMIT_YET));
      assert.ok(fs.existsSync(path.join(fresh.root, "a.txt")));
    } finally {
      fresh.dispose();
    }
  });
});

describe("work tree: discard without losing data (1.9.0 review)", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
  });
  afterEach(() => repo.dispose());

  it("intent-to-add (git add -N) in Changes is a new file: planned as delete, never emptied", async () => {
    repo.write("ita.txt", "precious\n");
    repo.git("add", "-N", "ita.txt");
    assert.deepStrictEqual(await planDiscard(repo.root, "ita.txt", "unstaged"), { kind: "deleteNew" });
    await discardFile(repo.root, "ita.txt", "unstaged");
    assert.ok(!exists(repo, "ita.txt"), "deleted as confirmed, not truncated to 0 bytes");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), { staged: [], unstaged: [], untracked: [], conflicted: [] });
  });

  it("added then modified (AM): planned as delete (the confirmation says the content is in no commit)", async () => {
    repo.write("new.txt", "v1\n");
    await stagePaths(repo.root, ["new.txt"]);
    repo.write("new.txt", "v2\n");
    assert.deepStrictEqual(await planDiscard(repo.root, "new.txt", "staged"), { kind: "deleteNew" });
    assert.deepStrictEqual(await planDiscard(repo.root, "a.txt", "staged"), null, "not listed there");
  });

  it("a renamed and modified file: discard brings the old one back from HEAD", async () => {
    repo.git("mv", "a.txt", "b.txt");
    repo.write("b.txt", "changed\n");
    assert.deepStrictEqual(await planDiscard(repo.root, "b.txt", "staged"), { kind: "renameBack", orig: "a.txt" });
    await discardFile(repo.root, "b.txt", "staged");
    assert.strictEqual(read(repo, "a.txt"), "1\n");
    assert.ok(!exists(repo, "b.txt"));
  });

  it("a case-only rename on a case-insensitive disk keeps the one file", async function () {
    fs.writeFileSync(path.join(repo.root, "probe"), "");
    const insensitive = fs.existsSync(path.join(repo.root, "PROBE"));
    fs.rmSync(path.join(repo.root, "probe"));
    if (!insensitive) this.skip();
    repo.git("mv", "a.txt", "A.txt");
    await discardFile(repo.root, "A.txt", "staged");
    assert.strictEqual(read(repo, "a.txt"), "1\n", "the file survives");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), { staged: [], unstaged: [], untracked: [], conflicted: [] });
  });
});
