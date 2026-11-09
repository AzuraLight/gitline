// 1.5.0 selected-branches view: resolveRefSelection edge cases, ref lists through --stdin, and
// execGit's stdin handling (EPIPE) — complements the "selected branches view" suites in gitExec.test.ts.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readOffHeadHashes, readRecentCommits, resolveRefSelection } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

describe("resolveRefSelection: edge cases", function () {
  this.timeout(60_000);
  let repo: TempRepo;
  let base: string, second: string, feat: string;

  before(() => {
    repo = new TempRepo();
    base = repo.commitEmpty("base");
    second = repo.commitEmpty("second");
    repo.git("checkout", "-q", "-b", "feat/one", base);
    feat = repo.commitEmpty("feat work");
    repo.git("checkout", "-q", "main");
    repo.git("update-ref", "refs/remotes/origin/main", second);
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    repo.git("tag", "v2", second);
  });

  after(() => repo.dispose());

  it("accepts full ref names and de-duplicates them against short names", async () => {
    const r = await resolveRefSelection(repo.root, ["refs/heads/main", "main", "refs/tags/v2", "v2"]);
    assert.deepStrictEqual(r, { refs: ["refs/heads/main", "refs/tags/v2"], missing: [] });
  });

  it("de-duplicates refs matched by overlapping patterns and names", async () => {
    const r = await resolveRefSelection(repo.root, ["feat/*", "feat/one", "*/one", "feat/*"]);
    assert.deepStrictEqual(r, { refs: ["refs/heads/feat/one"], missing: [] });
  });

  it("keeps a SHA, HEAD and main~1 as written", async () => {
    const r = await resolveRefSelection(repo.root, [feat, "HEAD", "main~1", feat.slice(0, 10)]);
    assert.deepStrictEqual(r, { refs: [feat, "HEAD", "main~1", feat.slice(0, 10)], missing: [] });
  });

  it("rejects entries starting with '-' as missing (no option injection through stdin)", async () => {
    const r = await resolveRefSelection(repo.root, ["--all", "-n", "--not", "main"]);
    assert.deepStrictEqual(r, { refs: ["refs/heads/main"], missing: ["--all", "-n", "--not"] });
  });

  it("excludes origin/HEAD from patterns but still accepts it by exact name", async () => {
    assert.deepStrictEqual((await resolveRefSelection(repo.root, ["origin/*"])).refs, ["refs/remotes/origin/main"]);
    assert.deepStrictEqual((await resolveRefSelection(repo.root, ["*"])).refs.sort(), [
      "refs/heads/main",
      "refs/tags/v2",
    ]);
    assert.deepStrictEqual((await resolveRefSelection(repo.root, ["origin/HEAD"])).refs, ["refs/remotes/origin/HEAD"]);
  });

  it("does not let '*' cross a '/' and treats regex characters literally", async () => {
    assert.deepStrictEqual((await resolveRefSelection(repo.root, ["*/one"])).refs, ["refs/heads/feat/one"]);
    assert.deepStrictEqual((await resolveRefSelection(repo.root, ["feat*"])).missing, ["feat*"]);
    for (const p of ["fea.", "feat/(one)", "feat/[o]ne", "feat/one$", "^feat/one", "feat/on|x", "feat\\one"]) {
      assert.deepStrictEqual((await resolveRefSelection(repo.root, [p + "*"])).refs, [], p);
    }
  });

  it("reports unknown names and an empty input", async () => {
    assert.deepStrictEqual(await resolveRefSelection(repo.root, []), { refs: [], missing: [] });
    assert.deepStrictEqual(await resolveRefSelection(repo.root, ["nope", "  "]), { refs: [], missing: ["nope"] });
  });

  it("throws when the refs cannot be listed instead of reporting everything missing", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-norepo-"));
    try {
      await assert.rejects(resolveRefSelection(notRepo, ["main"]));
      await assert.rejects(resolveRefSelection(path.join(notRepo, "does-not-exist"), ["main"]));
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("logs a list with a SHA and HEAD in it, and dims relative to HEAD", async () => {
    const { refs } = await resolveRefSelection(repo.root, [feat, "HEAD"]);
    const rows = await readRecentCommits(repo.root, 100, refs);
    assert.deepStrictEqual(rows.map((r) => r.hash).sort(), [base, second, feat].sort());
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, refs, 100)) ?? [])], [feat]);
  });
});

describe("ref lists through --stdin: filters", function () {
  this.timeout(60_000);
  let repo: TempRepo;
  let c1: string, c2: string, side: string, merge: string;

  before(() => {
    repo = new TempRepo();
    repo.write("old.txt", "hello\nworld\n");
    c1 = repo.commitAll("add old");
    repo.git("mv", "old.txt", "new.txt");
    c2 = repo.commitAll("rename to new");
    repo.git("checkout", "-q", "-b", "side", c1);
    repo.write("other.txt", "x\n");
    side = repo.commitAll("side change");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    merge = repo.head();
    repo.write("main", "a file named like a branch\n");
    repo.write("HEAD", "a file named HEAD\n");
  });

  after(() => repo.dispose());

  it("follows a renamed file with a list (path filter uses --follow)", async () => {
    const { refs } = await resolveRefSelection(repo.root, ["main", "side"]);
    const rows = await readRecentCommits(repo.root, 100, refs, "new.txt");
    const hashes = rows.map((r) => r.hash);
    assert.ok(hashes.includes(c2), "rename commit");
    assert.ok(hashes.includes(c1), "pre-rename commit found through --follow");
    assert.ok(!hashes.includes(side));
  });

  it("filters merges with a list", async () => {
    const { refs } = await resolveRefSelection(repo.root, ["main", "side"]);
    assert.deepStrictEqual((await readRecentCommits(repo.root, 100, refs, undefined, undefined, "only")).map((r) => r.hash), [merge]);
    const hidden = (await readRecentCommits(repo.root, 100, refs, undefined, undefined, "hide")).map((r) => r.hash);
    assert.ok(!hidden.includes(merge) && hidden.includes(side));
  });

  it("searches messages and authors with a list", async () => {
    const { refs } = await resolveRefSelection(repo.root, ["side"]);
    assert.deepStrictEqual((await readRecentCommits(repo.root, 100, refs, undefined, "SIDE CHANGE")).map((r) => r.hash), [side]);
    assert.strictEqual((await readRecentCommits(repo.root, 100, refs, undefined, "@gitline test")).length, 2);
  });

  it("is not confused by files named main / HEAD in the work tree", async () => {
    const { refs } = await resolveRefSelection(repo.root, ["main", "HEAD"]);
    assert.strictEqual((await readRecentCommits(repo.root, 100, refs)).length, 4);
    assert.deepStrictEqual([...((await readOffHeadHashes(repo.root, refs, 100)) ?? [])], []);
  });

  it("dims nothing on an unborn HEAD but still lists the selected branches", async () => {
    repo.git("checkout", "-q", "--orphan", "fresh");
    try {
      const { refs } = await resolveRefSelection(repo.root, ["side"]);
      assert.strictEqual((await readRecentCommits(repo.root, 100, refs)).length, 2);
      assert.strictEqual(await readOffHeadHashes(repo.root, refs, 100), undefined);
    } finally {
      repo.git("checkout", "-q", "-f", "main");
    }
  });
});

describe("execGit stdin handling", function () {
  this.timeout(60_000);

  /** Fails the test if anything escapes as an uncaught exception while `run` is in flight. */
  async function noUncaught(run: () => Promise<void>): Promise<void> {
    const caught: unknown[] = [];
    const onErr = (e: unknown) => caught.push(e);
    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", onErr);
    try {
      await run();
      await new Promise((r) => setTimeout(r, 300)); // let a late EPIPE surface
    } finally {
      process.removeListener("uncaughtException", onErr);
      for (const l of listeners) process.on("uncaughtException", l);
    }
    assert.deepStrictEqual(caught, [], "no uncaught exception");
  }

  // ~8 MB of revisions: far more than a pipe buffer, so git exiting first makes the write fail.
  const huge = Array.from({ length: 200_000 }, (_, i) => `refs/heads/some/long/branch/name/number-${i}`);

  it("settles (rejects) without crashing when git exits before reading a large input", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-epipe-"));
    try {
      await noUncaught(async () => {
        for (let i = 0; i < 5; i++) await assert.rejects(readRecentCommits(notRepo, 10, huge));
      });
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("settles (undefined) for the dimming probe in the same situation", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-epipe-"));
    try {
      await noUncaught(async () => {
        for (let i = 0; i < 5; i++) assert.strictEqual(await readOffHeadHashes(notRepo, huge, 10), undefined);
      });
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("settles when a real repo gets a huge list of unknown refs (git dies mid-read)", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("one");
      await noUncaught(async () => {
        await assert.rejects(readRecentCommits(repo.root, 10, huge));
      });
    } finally {
      repo.dispose();
    }
  });

  it("does not hang commands that never read stdin", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("one");
      // HEAD view: no input given, stdin must still be closed so git never waits on it.
      assert.strictEqual((await readRecentCommits(repo.root, 10)).length, 1);
      assert.deepStrictEqual(await resolveRefSelection(repo.root, ["main"]), { refs: ["refs/heads/main"], missing: [] });
    } finally {
      repo.dispose();
    }
  });
});
