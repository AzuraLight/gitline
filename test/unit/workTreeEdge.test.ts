import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cleanUntracked,
  canStashStagedOnly,
  commit,
  discardAllTracked,
  discardFile,
  headIsPushed,
  lastCommitMessage,
  readWorkingFiles,
  stagePaths,
  stashPush,
  unstagePaths,
  untrackedToClean,
} from "../../src/workTree";
import { TempRepo } from "../helpers/tempRepo";

/** 1.9.0 working-tree edge cases, against real git output in throwaway repositories. */

const WIN = process.platform === "win32";
const names = (list: { path: string }[]) => list.map((f) => f.path).sort();
const full = (repo: TempRepo, p: string) => path.join(repo.root, p);
const exists = (repo: TempRepo, p: string) => fs.existsSync(full(repo, p));
const lexists = (repo: TempRepo, p: string) => {
  try {
    fs.lstatSync(full(repo, p));
    return true;
  } catch {
    return false;
  }
};
const read = (repo: TempRepo, p: string) => fs.readFileSync(full(repo, p), "utf8");
const count = (repo: TempRepo) => repo.git("rev-list", "--count", "HEAD").trim();
const stashCount = (repo: TempRepo) => repo.git("stash", "list").split("\n").filter(Boolean).length;
const CLEAN = { staged: [], unstaged: [], untracked: [], conflicted: [] };

function withRepo(fn: (ctx: Mocha.Suite) => void) {
  return function (this: Mocha.Suite) {
    this.timeout(60_000);
    fn(this);
  };
}

let repo: TempRepo;
const setup = () => {
  beforeEach(() => {
    repo = new TempRepo();
  });
  afterEach(() => repo.dispose());
};

describe("work tree edge: status against real git", withRepo(() => {
  setup();

  it("git mv with spaces is one staged rename with its old path", async () => {
    repo.write("old name with spaces.txt", "x\n");
    repo.commitAll("base");
    repo.git("mv", "old name with spaces.txt", "new  name  with spaces.txt");
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "new  name  with spaces.txt", status: "R", orig: "old name with spaces.txt" }]);
    assert.deepStrictEqual(f.unstaged, []);
    assert.deepStrictEqual(f.untracked, []);
  });

  it("a file staged and modified again is in both groups", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.write("a.txt", "2\n");
    repo.git("add", "a.txt");
    repo.write("a.txt", "3\n");
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "a.txt", status: "M" }]);
    assert.deepStrictEqual(f.unstaged, [{ path: "a.txt", status: "M" }]);
  });

  it("file -> symlink is a type change (T)", async function () {
    if (WIN) this.skip();
    repo.write("target.txt", "t\n");
    repo.write("f", "plain\n");
    repo.commitAll("base");
    fs.rmSync(full(repo, "f"));
    fs.symlinkSync("target.txt", full(repo, "f"));
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.unstaged, [{ path: "f", status: "T" }]);
    await stagePaths(repo.root, ["f"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "f", status: "T" }]);
  });

  it("a submodule with changes shows as one modified path", async () => {
    const sub = new TempRepo();
    try {
      sub.write("s.txt", "s\n");
      sub.commitAll("sub base");
      repo.write("a.txt", "a\n");
      repo.commitAll("base");
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.root, "sub");
      repo.git("commit", "-q", "-m", "add sub");
      fs.writeFileSync(full(repo, "sub/s.txt"), "changed\n");
      fs.writeFileSync(full(repo, "sub/new.txt"), "n\n");
      const f = await readWorkingFiles(repo.root);
      assert.deepStrictEqual(f.unstaged, [{ path: "sub", status: "M" }]);
      assert.deepStrictEqual(f.untracked, [], "files inside the submodule are not the parent's untracked files");
    } finally {
      sub.dispose();
    }
  });

  it("a case-only rename is a staged rename", async () => {
    repo.write("readme.md", "r\n");
    repo.commitAll("base");
    repo.git("mv", "readme.md", "README.md");
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "README.md", status: "R", orig: "readme.md" }]);
    assert.deepStrictEqual(f.unstaged, []);
  });

  it("intent-to-add (git add -N) is an unstaged add; staging it makes a staged add", async () => {
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    repo.write("ita.txt", "i\n");
    repo.git("add", "-N", "ita.txt");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, []);
    assert.deepStrictEqual(f.unstaged, [{ path: "ita.txt", status: "A" }]);
    assert.deepStrictEqual(f.untracked, []);
    await stagePaths(repo.root, ["ita.txt"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "ita.txt", status: "A" }]);
    assert.deepStrictEqual(f.unstaged, []);
  });

  it("deleted and staged vs deleted and not staged", async () => {
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.commitAll("base");
    repo.git("rm", "-q", "a.txt");
    fs.rmSync(full(repo, "b.txt"));
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "a.txt", status: "D" }]);
    assert.deepStrictEqual(f.unstaged, [{ path: "b.txt", status: "D" }]);
  });

  it("an executable-bit change is a modification and can be staged and committed", async function () {
    if (WIN) this.skip();
    repo.write("run.sh", "echo\n");
    repo.commitAll("base");
    fs.chmodSync(full(repo, "run.sh"), 0o755);
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.unstaged, [{ path: "run.sh", status: "M" }]);
    await stagePaths(repo.root, ["run.sh"]);
    await commit(repo.root, "chmod");
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f, CLEAN);
    assert.match(repo.git("ls-files", "-s", "run.sh"), /^100755 /);
  });

  it("very long paths survive status, stage and unstage", async () => {
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    const seg = "d".repeat(100);
    const long = `${seg}/${seg}/${seg}/${"f".repeat(200)} with space.txt`;
    repo.write(long, "x\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), [long]);
    await stagePaths(repo.root, [long]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: long, status: "A" }]);
    await unstagePaths(repo.root, [long]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), [long]);
  });

  it("non-ASCII and emoji names round-trip unescaped", async () => {
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    const list = ["한글/파일 이름.txt", "日本語.md", "émoji 😀🎉.txt", "dir 🚀/naïve café.txt", "‮rtl.txt"];
    for (const n of list) repo.write(n, "x\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), [...list].sort());
    await stagePaths(repo.root, list);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), [...list].sort());
    await commit(repo.root, "unicode");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), CLEAN);
  });

  it("a file name with a newline is parsed, staged, unstaged and discarded", async function () {
    if (WIN) this.skip();
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    const nl = "line\nbreak.txt";
    repo.write(nl, "x\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), [nl]);
    await stagePaths(repo.root, [nl]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: nl, status: "A" }]);
    await unstagePaths(repo.root, [nl]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), [nl]);
    await discardFile(repo.root, nl, "untracked");
    assert.ok(!exists(repo, nl));
  });
}));

describe("work tree edge: stage / unstage", withRepo(() => {
  setup();

  it("unstaging a rename's new path takes its old path along (no lone deletion stays staged)", async () => {
    repo.write("old.txt", "o\n");
    repo.commitAll("base");
    repo.git("mv", "old.txt", "new.txt");
    await unstagePaths(repo.root, ["new.txt"]);
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [], "nothing left staged");
    assert.deepStrictEqual(f.unstaged, [{ path: "old.txt", status: "D" }]);
    assert.deepStrictEqual(names(f.untracked), ["new.txt"]);
    await stagePaths(repo.root, ["new.txt", "old.txt"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "new.txt", status: "R", orig: "old.txt" }], "staging both is the rename again");
  });

  it("a whole directory with nested files stages and unstages", async () => {
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    repo.write("dir/one.txt", "1\n");
    repo.write("dir/sub/two.txt", "2\n");
    repo.write("dir/sub/deeper/three.txt", "3\n");
    repo.write("other.txt", "o\n");
    await stagePaths(repo.root, ["dir"]);
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), ["dir/one.txt", "dir/sub/deeper/three.txt", "dir/sub/two.txt"]);
    assert.deepStrictEqual(names(f.untracked), ["other.txt"]);
    await unstagePaths(repo.root, ["dir/sub"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.staged), ["dir/one.txt"]);
  });

  it("2000 files at once", async () => {
    repo.write("a.txt", "a\n");
    repo.commitAll("base");
    const list: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const p = `many/sub${i % 10}/file ${String(i).padStart(4, "0")}.txt`;
      list.push(p);
      repo.write(p, `${i}\n`);
    }
    const t0 = Date.now();
    await stagePaths(repo.root, list);
    let f = await readWorkingFiles(repo.root);
    assert.strictEqual(f.staged.length, 2000);
    await unstagePaths(repo.root, list);
    f = await readWorkingFiles(repo.root);
    assert.strictEqual(f.staged.length, 0);
    assert.strictEqual(f.untracked.length, 2000);
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0}ms`);
  });

  it("a tracked file that matches .gitignore stages", async () => {
    repo.write(".gitignore", "*.log\n");
    repo.write("app.log", "1\n");
    repo.git("add", ".gitignore");
    repo.git("add", "-f", "app.log");
    repo.git("commit", "-q", "-m", "base");
    repo.write("app.log", "2\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.unstaged, [{ path: "app.log", status: "M" }]);
    await stagePaths(repo.root, ["app.log"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "app.log", status: "M" }]);
    await unstagePaths(repo.root, ["app.log"]);
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.unstaged, [{ path: "app.log", status: "M" }]);
  });
}));

describe("work tree edge: commit", withRepo(() => {
  setup();
  beforeEach(async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.write("a.txt", "2\n");
    await stagePaths(repo.root, ["a.txt"]);
  });

  for (const [label, typed, stored] of [
    ["leading dash", "-m --amend not an option", "-m --amend not an option"],
    ["lone #", "#", "#"],
    ["CRLF and lone CR", "subject\r\n\r\nbody one\r\nbody two\r\n", "subject\n\nbody one\nbody two"],
    ["whitespace-only lines then text", " \n\t\n   \nreal subject\n  \n", "real subject"],
  ] as const) {
    it(`message: ${label}`, async () => {
      await commit(repo.root, typed);
      assert.strictEqual(await lastCommitMessage(repo.root), stored);
      assert.strictEqual(count(repo), "2");
    });
  }

  it("commit.template is not mixed into the typed message", async () => {
    const tpl = path.join(repo.root, ".git", "tpl.txt");
    fs.writeFileSync(tpl, "TEMPLATE SUBJECT\n\n# template help\n");
    repo.git("config", "commit.template", tpl);
    await commit(repo.root, "typed");
    assert.strictEqual(await lastCommitMessage(repo.root), "typed");
  });

  it("commit.verbose does not put a diff in the message", async () => {
    repo.git("config", "commit.verbose", "true");
    await commit(repo.root, "typed\n\n# kept");
    assert.strictEqual(await lastCommitMessage(repo.root), "typed\n\n# kept");
  });

  it("commit.gpgsign with a missing key fails with an error, not a hang", async function () {
    this.timeout(20_000);
    const gnupg = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-gnupg-"));
    fs.chmodSync(gnupg, 0o700);
    const saved = process.env.GNUPGHOME;
    process.env.GNUPGHOME = gnupg;
    try {
      repo.git("config", "commit.gpgsign", "true");
      repo.git("config", "user.signingkey", "0xDEADBEEFDEADBEEF");
      const t0 = Date.now();
      await assert.rejects(commit(repo.root, "signed?"), /gpg|sign/i);
      assert.ok(Date.now() - t0 < 15_000);
      assert.strictEqual(count(repo), "1");
      assert.deepStrictEqual(names((await readWorkingFiles(repo.root)).staged), ["a.txt"], "index kept");
    } finally {
      if (saved === undefined) delete process.env.GNUPGHOME;
      else process.env.GNUPGHOME = saved;
      fs.rmSync(gnupg, { recursive: true, force: true });
    }
  });

  it("a commit-msg hook that rewrites the message wins", async function () {
    if (WIN) this.skip();
    const hooks = path.join(repo.root, ".git", "edge-hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\nprintf 'rewritten by hook\\n\\nwas: %s\\n' \"$(head -1 \"$1\")\" > \"$1\"\n", { mode: 0o755 });
    repo.git("config", "core.hooksPath", hooks);
    await commit(repo.root, "original");
    assert.strictEqual(await lastCommitMessage(repo.root), "rewritten by hook\n\nwas: original");
  });
}));

describe("work tree edge: amend", withRepo(() => {
  setup();

  it("with nothing staged only rewrites the message", async () => {
    repo.write("a.txt", "1\n");
    const before = repo.commitAll("base");
    const tree = repo.git("rev-parse", "HEAD^{tree}").trim();
    await commit(repo.root, "reworded", { amend: true });
    assert.notStrictEqual(repo.head(), before);
    assert.strictEqual(count(repo), "1");
    assert.strictEqual(repo.git("rev-parse", "HEAD^{tree}").trim(), tree);
    assert.strictEqual(await lastCommitMessage(repo.root), "reworded");
  });

  it("on an unborn HEAD fails cleanly", async () => {
    repo.write("a.txt", "1\n");
    await stagePaths(repo.root, ["a.txt"]);
    // Refused before git runs, with the reason the panel turns into "no commit yet to go back to".
    await assert.rejects(commit(repo.root, "x", { amend: true }), /no commit yet/);
    assert.deepStrictEqual(names((await readWorkingFiles(repo.root)).staged), ["a.txt"]);
    assert.strictEqual(await lastCommitMessage(repo.root), "");
  });

  it("headIsPushed: detached HEAD on a pushed commit is true, a new detached commit false", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-bare-"));
    try {
      repo.git("init", "-q", "--bare", bare);
      repo.commitEmpty("base");
      repo.git("remote", "add", "origin", bare);
      repo.git("push", "-q", "origin", "main");
      repo.git("checkout", "-q", "--detach");
      assert.strictEqual(await headIsPushed(repo.root), true);
      repo.commitEmpty("detached local");
      assert.strictEqual(await headIsPushed(repo.root), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("headIsPushed: no remotes is false; unborn is false", async () => {
    assert.strictEqual(await headIsPushed(repo.root), false);
    repo.commitEmpty("base");
    assert.strictEqual(await headIsPushed(repo.root), false);
  });
}));

describe("work tree edge: stash", withRepo(() => {
  setup();
  beforeEach(() => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
  });

  it("only untracked files: stashed by default", async () => {
    repo.write("u/new.txt", "n\n");
    await stashPush(repo.root);
    assert.strictEqual(stashCount(repo), 1);
    assert.ok(!exists(repo, "u/new.txt"));
  });

  it("only untracked files without includeUntracked: reports that nothing was stashed", async () => {
    repo.write("u/new.txt", "n\n");
    // git prints "No local changes to save" and exits 0; the caller should learn nothing happened.
    await assert.rejects(stashPush(repo.root, { includeUntracked: false }));
    assert.strictEqual(stashCount(repo), 0);
    assert.ok(exists(repo, "u/new.txt"));
  });

  it("staged-only with nothing staged: nothing stashed, unstaged change kept", async function () {
    if (!(await canStashStagedOnly(repo.root))) this.skip();
    repo.write("a.txt", "2\n");
    let threw = false;
    try {
      await stashPush(repo.root, { stagedOnly: true });
    } catch {
      threw = true;
    }
    assert.strictEqual(stashCount(repo), 0, `stash created (threw=${threw})`);
    assert.strictEqual(read(repo, "a.txt"), "2\n");
  });

  it("a message with newlines becomes one line; a newline-only message is no message", async () => {
    repo.write("a.txt", "2\n");
    await stashPush(repo.root, { message: "first\r\n\r\nsecond\nthird" });
    assert.match(repo.git("stash", "list", "-1", "--format=%gs").trim(), /: first second third$/);
    repo.write("a.txt", "3\n");
    await stashPush(repo.root, { message: "\n\r\n" });
    assert.match(repo.git("stash", "list", "-1", "--format=%gs"), /^WIP on main/);
  });
}));

describe("work tree edge: discard", withRepo(() => {
  setup();

  it("discarding a staged rename brings the old path back and removes the new one", async () => {
    repo.write("old name.txt", "o\n");
    repo.write("keep.txt", "k\n");
    repo.commitAll("base");
    repo.git("mv", "old name.txt", "new name.txt");
    await discardFile(repo.root, "new name.txt", "staged");
    assert.ok(!exists(repo, "new name.txt"), "new path gone");
    assert.ok(exists(repo, "old name.txt"), "old path back");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), CLEAN);
  });

  it("staged + modified: discard unstaged keeps the staged version; discard staged resets both", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.write("a.txt", "2\n");
    await stagePaths(repo.root, ["a.txt"]);
    repo.write("a.txt", "3\n");
    await discardFile(repo.root, "a.txt", "unstaged");
    assert.strictEqual(read(repo, "a.txt"), "2\n");
    let f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f.staged, [{ path: "a.txt", status: "M" }]);
    assert.deepStrictEqual(f.unstaged, []);
    repo.write("a.txt", "3\n");
    await discardFile(repo.root, "a.txt", "staged");
    assert.strictEqual(read(repo, "a.txt"), "1\n");
    f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(f, CLEAN);
  });

  it("files in an untracked directory are deleted one by one; the directory path too", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.write("newdir/x/y.txt", "y\n");
    repo.write("newdir/z.txt", "z\n");
    repo.write("newdir2/q/r.txt", "r\n");
    const f = await readWorkingFiles(repo.root);
    assert.deepStrictEqual(names(f.untracked), ["newdir/x/y.txt", "newdir/z.txt", "newdir2/q/r.txt"]);
    await discardFile(repo.root, "newdir/x/y.txt", "untracked");
    await discardFile(repo.root, "newdir/z.txt", "untracked");
    assert.ok(!exists(repo, "newdir/x/y.txt") && !exists(repo, "newdir/z.txt"));
    // Only paths git lists are discarded: a folder path is refused, its file is discarded by name.
    await assert.rejects(discardFile(repo.root, "newdir2", "untracked"), /not listed/);
    assert.ok(exists(repo, "newdir2/q/r.txt"), "nothing deleted for an unlisted path");
    await discardFile(repo.root, "newdir2/q/r.txt", "untracked");
    assert.ok(!exists(repo, "newdir2/q/r.txt"));
    assert.deepStrictEqual(await readWorkingFiles(repo.root), CLEAN);
  });

  it("symlinks: tracked link retargeted is restored; untracked link is removed, its target kept", async function () {
    if (WIN) this.skip();
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.write("dir/in.txt", "i\n");
    fs.symlinkSync("a.txt", full(repo, "link"));
    repo.commitAll("base");
    fs.rmSync(full(repo, "link"));
    fs.symlinkSync("b.txt", full(repo, "link"));
    assert.deepStrictEqual((await readWorkingFiles(repo.root)).unstaged, [{ path: "link", status: "M" }]);
    await discardFile(repo.root, "link", "unstaged");
    assert.strictEqual(fs.readlinkSync(full(repo, "link")), "a.txt");

    fs.symlinkSync("a.txt", full(repo, "ulink"));
    fs.symlinkSync("dir", full(repo, "dlink"));
    assert.deepStrictEqual(names((await readWorkingFiles(repo.root)).untracked), ["dlink", "ulink"]);
    await discardFile(repo.root, "ulink", "untracked");
    await discardFile(repo.root, "dlink", "untracked");
    assert.ok(!lexists(repo, "ulink") && !lexists(repo, "dlink"));
    assert.strictEqual(read(repo, "a.txt"), "a\n");
    assert.strictEqual(read(repo, "dir/in.txt"), "i\n", "link to a directory: the directory's files stay");
  });

  it("clean leaves nested git repositories alone and does not list them", async () => {
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    const nested = path.join(repo.root, "nested");
    fs.mkdirSync(nested);
    repo.git("-C", nested, "init", "-q");
    fs.writeFileSync(path.join(nested, "inner.txt"), "inner\n");
    repo.write("plain.txt", "p\n");
    repo.write("plaindir/x.txt", "x\n");
    const listed = await untrackedToClean(repo.root);
    assert.deepStrictEqual(listed.sort(), ["plain.txt", "plaindir/"]);
    await cleanUntracked(repo.root);
    assert.ok(!exists(repo, "plain.txt") && !exists(repo, "plaindir"));
    assert.ok(exists(repo, "nested/.git") && exists(repo, "nested/inner.txt"), "nested repo survives");
  });

  it("discardAllTracked in the middle of a merge conflict ends it cleanly", async () => {
    repo.write("c.txt", "base\n");
    repo.commitAll("base");
    repo.git("checkout", "-q", "-b", "side");
    repo.write("c.txt", "side\n");
    repo.commitAll("side");
    repo.git("checkout", "-q", "main");
    repo.write("c.txt", "main\n");
    repo.commitAll("main");
    assert.throws(() => repo.git("merge", "-q", "side"));
    assert.deepStrictEqual((await readWorkingFiles(repo.root)).conflicted, [{ path: "c.txt", status: "U" }]);
    await discardAllTracked(repo.root);
    assert.strictEqual(read(repo, "c.txt"), "main\n");
    assert.ok(!exists(repo, ".git/MERGE_HEAD"), "merge state cleared");
    assert.deepStrictEqual(await readWorkingFiles(repo.root), CLEAN);
  });
}));
