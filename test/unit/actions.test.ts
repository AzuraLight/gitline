import * as assert from "assert";
import { assertCommitHash, assertRefName, assertStashRef, isValidRefName } from "../../src/gitPanelActions";
import { readRebaseCommits, resolveRebaseBase } from "../../src/rebaseRun";
import { TempRepo } from "../helpers/tempRepo";

describe("input guards", () => {
  it("accepts ordinary branch names", () => {
    for (const name of ["main", "feature/login", "release-1.2.1", "origin/main"]) {
      assert.ok(isValidRefName(name), name);
    }
  });

  it("rejects names git would read as options or reject", () => {
    for (const name of ["-f", "--delete", "a b", "a~1", "a^", "a:b", "", "   "]) {
      assert.ok(!isValidRefName(name), JSON.stringify(name));
      assert.throws(() => assertRefName(name));
    }
  });

  it("validates hashes and stash refs", () => {
    assert.strictEqual(assertCommitHash(" abcdef1 "), "abcdef1");
    assert.throws(() => assertCommitHash("--hard"));
    assert.strictEqual(assertStashRef("stash@{2}"), "stash@{2}");
    assert.throws(() => assertStashRef("stash@{x}"));
  });
});

describe("interactive rebase base", function () {
  this.timeout(30_000);
  let repo: TempRepo;
  let root: string;
  let second: string;

  before(() => {
    repo = new TempRepo();
    repo.write("a.txt", "1\n");
    root = repo.commitAll("root");
    repo.append("a.txt", "2\n");
    second = repo.commitAll("second");
  });

  after(() => repo.dispose());

  it("keeps an existing parent as the base", async () => {
    assert.strictEqual(await resolveRebaseBase(repo.root, `${second}^`), `${second}^`);
  });

  it("uses --root (null) when rebasing from the root commit", async () => {
    assert.strictEqual(await resolveRebaseBase(repo.root, `${root}^`), null);
    const rows = await readRebaseCommits(repo.root, null);
    assert.deepStrictEqual(rows.map((r) => r.subject), ["root", "second"]);
  });

  it("rejects an unknown revision", async () => {
    await assert.rejects(resolveRebaseBase(repo.root, "nope^"));
  });
});
