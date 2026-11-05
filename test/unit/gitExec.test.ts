import * as assert from "assert";
import * as os from "os";
import {
  looksLikeHash,
  parseChangedFiles,
  readBlobAt,
  readCommitFiles,
  readCompareFiles,
  readFirstParent,
  readRecentCommits,
  readStashFiles,
  repoRelativePath,
} from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

describe("parseChangedFiles (-z output)", () => {
  it("reads plain, renamed and non-ASCII paths with their line stats", () => {
    const nameStatus = "R075\0src/Old.java\0src/New.java\0M\0한글파일.txt\0A\0dir with space/a b.txt\0";
    const numstat = "1\t0\t\0src/Old.java\0src/New.java\0" + "2\t1\t한글파일.txt\0" + "3\t0\tdir with space/a b.txt\0";
    assert.deepStrictEqual(parseChangedFiles(nameStatus, numstat), [
      { status: "R", path: "src/New.java", oldPath: "src/Old.java", insertions: 1, deletions: 0 },
      { status: "M", path: "한글파일.txt", insertions: 2, deletions: 1 },
      { status: "A", path: "dir with space/a b.txt", insertions: 3, deletions: 0 },
    ]);
  });

  it("treats binary numstat (-) as zero", () => {
    assert.deepStrictEqual(parseChangedFiles("M\0logo.png\0", "-\t-\tlogo.png\0"), [
      { status: "M", path: "logo.png", insertions: 0, deletions: 0 },
    ]);
  });

  it("returns nothing for empty output", () => {
    assert.deepStrictEqual(parseChangedFiles("", ""), []);
  });
});

describe("looksLikeHash", () => {
  it("accepts 4–40 hex characters only", () => {
    assert.ok(looksLikeHash("ce97fe4"));
    assert.ok(looksLikeHash("ABCD"));
    assert.ok(!looksLikeHash("abc"));
    assert.ok(!looksLikeHash("fix bug"));
    assert.ok(!looksLikeHash("g1234"));
  });
});

describe("git readers against a real repository", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let renameCommit: string;
  let rootCommit: string;

  before(() => {
    repo = new TempRepo();
    repo.write("src/deep/dir/Old.java", "a\nb\nc\n");
    repo.write("한글파일.txt", "안녕\n");
    rootCommit = repo.commitAll("first");
    repo.git("mv", "src/deep/dir/Old.java", "src/deep/dir/New.java");
    repo.append("src/deep/dir/New.java", "d\n");
    repo.append("한글파일.txt", "둘\n");
    renameCommit = repo.commitAll("rename and edit");
    repo.commitEmptyMany(230, "c");
  });

  after(() => repo.dispose());

  it("lists a renamed file with its real line stats", async () => {
    const files = await readCommitFiles(repo.root, renameCommit);
    const renamed = files.find((f) => f.status === "R");
    assert.deepStrictEqual(renamed, {
      status: "R",
      path: "src/deep/dir/New.java",
      oldPath: "src/deep/dir/Old.java",
      insertions: 1,
      deletions: 0,
    });
  });

  it("keeps non-ASCII paths readable and diffable", async () => {
    const files = await readCommitFiles(repo.root, renameCommit);
    const korean = files.find((f) => f.status === "M");
    assert.strictEqual(korean?.path, "한글파일.txt");
    assert.strictEqual(await readBlobAt(repo.root, renameCommit, korean!.path), "안녕\n둘\n");
  });

  it("compares two commits with the same parser", async () => {
    const files = await readCompareFiles(repo.root, rootCommit, renameCommit);
    assert.deepStrictEqual(files.map((f) => f.path).sort(), ["src/deep/dir/New.java", "한글파일.txt"]);
  });

  it("returns exactly the requested page size, so the webview can ask for more", async () => {
    assert.strictEqual((await readRecentCommits(repo.root, 200)).length, 200);
    assert.strictEqual((await readRecentCommits(repo.root, 400)).length, 232);
  });

  it("finds a commit by (partial) hash", async () => {
    const target = repo.git("rev-parse", "HEAD~5").trim();
    const hits = await readRecentCommits(repo.root, 200, undefined, undefined, target.slice(0, 7));
    assert.strictEqual(hits[0]?.hash, target);
    assert.strictEqual(hits[0]?.subject, "c225");
  });

  it("still searches messages for text queries", async () => {
    const hits = await readRecentCommits(repo.root, 500, undefined, undefined, "rename and");
    assert.deepStrictEqual(hits.map((h) => h.subject), ["rename and edit"]);
  });

  it("reports no parent for the root commit", async () => {
    assert.strictEqual(await readFirstParent(repo.root, rootCommit), "");
    assert.strictEqual(await readFirstParent(repo.root, renameCommit), rootCommit);
  });
});

describe("stash files", function () {
  this.timeout(30_000);
  let repo: TempRepo;

  before(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    repo.commitAll("base");
    repo.append("a.txt", "2\n");
    repo.git("stash", "push", "-q", "-m", "wip");
  });

  after(() => repo.dispose());

  it("lists the files in a stash entry", async () => {
    assert.deepStrictEqual(await readStashFiles(repo.root, "stash@{0}"), [
      { status: "M", path: "a.txt", insertions: 1, deletions: 0 },
    ]);
  });
});

describe("repoRelativePath", () => {
  it("resolves symlinks on both sides (macOS /var → /private/var)", () => {
    const repo = new TempRepo();
    try {
      repo.write("a/b.txt", "x\n");
      const gitRoot = repo.git("rev-parse", "--show-toplevel").trim();
      assert.strictEqual(repoRelativePath(gitRoot, `${repo.root}/a/b.txt`), "a/b.txt");
      assert.strictEqual(repoRelativePath(repo.root, `${gitRoot}/a/b.txt`), "a/b.txt");
      assert.ok(repoRelativePath(repo.root, os.tmpdir()).startsWith(".."));
    } finally {
      repo.dispose();
    }
  });
});
