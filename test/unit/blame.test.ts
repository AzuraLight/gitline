import * as assert from "assert";
import { UNCOMMITTED_SHA, parseBlamePorcelain, relativeTime } from "../../src/blame/parse";
import { readBlamePorcelain } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

describe("parseBlamePorcelain", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  // Porcelain prints a commit's details only on its first appearance — line 3 reuses A.
  const sample = [
    `${A} 1 1 2`,
    "author Mina Park",
    "author-mail <mina@example.com>",
    "author-time 1700000000",
    "author-tz +0900",
    "summary Add checkout service",
    "filename src/App.java",
    "\tclass App {",
    `${A} 2 2`,
    "\t  void run() {}",
    `${B} 5 3 1`,
    "author Jun Kim",
    "author-mail <jun@example.com>",
    "author-time 1700086400",
    "summary Fix: handle 한글 names",
    "previous " + A + " src/App.java",
    "filename src/App.java",
    "\t}",
    "",
  ].join("\n");

  it("maps every final line to its commit, reusing details printed earlier", () => {
    const lines = parseBlamePorcelain(sample);
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(lines[0], {
      sha: A, author: "Mina Park", authorMail: "mina@example.com", authorTime: 1700000000, summary: "Add checkout service",
    });
    assert.strictEqual(lines[1], lines[0]);
    assert.strictEqual(lines[2].author, "Jun Kim");
    assert.strictEqual(lines[2].summary, "Fix: handle 한글 names");
  });

  it("returns nothing for empty output", () => {
    assert.deepStrictEqual(parseBlamePorcelain(""), []);
  });
});

describe("relativeTime", () => {
  const now = 1_800_000_000;
  it("picks the largest whole unit", () => {
    assert.strictEqual(relativeTime(now - 30, now), "just now");
    assert.strictEqual(relativeTime(now - 60, now), "1 minute ago");
    assert.strictEqual(relativeTime(now - 3 * 3600, now), "3 hours ago");
    assert.strictEqual(relativeTime(now - 15 * 86400, now), "2 weeks ago");
    assert.strictEqual(relativeTime(now - 400 * 86400, now), "1 year ago");
  });
  it("never reports the future", () => {
    assert.strictEqual(relativeTime(now + 500, now), "just now");
  });
});

describe("readBlamePorcelain against a real repository", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let first: string;
  let second: string;

  before(() => {
    repo = new TempRepo();
    repo.write("문서/notes.txt", "one\ntwo\n");
    first = repo.commitAll("first");
    repo.append("문서/notes.txt", "three\n");
    second = repo.commitAll("add three");
  });
  after(() => repo.dispose());

  it("blames committed lines, non-ASCII path included", async () => {
    const lines = parseBlamePorcelain(await readBlamePorcelain(repo.root, "문서/notes.txt", "one\ntwo\nthree\n"));
    assert.deepStrictEqual(lines.map((l) => l.sha), [first, first, second]);
    assert.strictEqual(lines[2].summary, "add three");
  });

  it("follows unsaved editor text: an inserted line is uncommitted, the rest shift", async () => {
    const lines = parseBlamePorcelain(await readBlamePorcelain(repo.root, "문서/notes.txt", "one\nNEW\ntwo\nthree\n"));
    assert.deepStrictEqual(lines.map((l) => l.sha), [first, UNCOMMITTED_SHA, first, second]);
  });

  it("rejects for an untracked file", async () => {
    repo.write("scratch.txt", "x\n");
    await assert.rejects(readBlamePorcelain(repo.root, "scratch.txt", "x\n"));
  });
});
