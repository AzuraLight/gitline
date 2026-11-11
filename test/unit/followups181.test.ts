import * as assert from "assert";
import { offHeadClock, readCurrentBranchName, readOffHeadHashes, readRecentCommits, resetOffHeadCache } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

/** 1.8.1 follow-ups from the 1.4.0 notes, against real repositories. */

describe("1.8.1: current branch name on an unborn branch", function () {
  this.timeout(30_000);

  it("a new repository and an orphan branch report their name; detached HEAD stays 'HEAD'", async () => {
    const repo = new TempRepo();
    try {
      // TempRepo starts on main with no commits yet.
      assert.strictEqual(await readCurrentBranchName(repo.root), "main");
      repo.commitEmpty("one");
      repo.git("checkout", "-q", "--orphan", "fresh-start");
      assert.strictEqual(await readCurrentBranchName(repo.root), "fresh-start");
      repo.git("checkout", "-q", "main");
      repo.git("checkout", "-q", "--detach", "HEAD");
      assert.strictEqual(await readCurrentBranchName(repo.root), "HEAD");
    } finally {
      repo.dispose();
    }
  });
});

describe("1.8.1: a commit found by hash is dimmed when it is not on HEAD", function () {
  this.timeout(30_000);

  it("in HEAD's own view, an off-branch hash hit is listed first and dimmed; an on-branch one is not", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      const side = repo.commitEmpty("side only");
      repo.git("checkout", "-q", "main");
      const mainOnly = repo.commitEmpty("main only");

      const off = await readRecentCommits(repo.root, 50, "", undefined, side.slice(0, 10));
      assert.strictEqual(off[0].hash, side);
      assert.strictEqual(off[0].offHead, true);

      const on = await readRecentCommits(repo.root, 50, "", undefined, mainOnly.slice(0, 10));
      assert.strictEqual(on[0].hash, mainOnly);
      assert.ok(!on[0].offHead, "on HEAD: not dimmed");
    } finally {
      repo.dispose();
    }
  });
});

/** Fixes the measured costs, so the test decides instead of how fast this machine spawns git. */
function fakeClock(keyMs: number, computeMs: number): () => void {
  const real = offHeadClock.ms;
  offHeadClock.ms = (phase) => (phase === "key" ? keyMs : computeMs);
  return () => { offHeadClock.ms = real; };
}

describe("1.8.1: off-HEAD list is reused until HEAD or a ref moves", function () {
  this.timeout(30_000);
  let restore: () => void;
  beforeEach(() => { resetOffHeadCache(); restore = fakeClock(1, 5); });
  afterEach(() => restore());

  it("same answer from the cache; a new commit, a new branch or a checkout gives a fresh one", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      const s1 = repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");

      const a = await readOffHeadHashes(repo.root, ":all", 100);
      const b = await readOffHeadHashes(repo.root, ":all", 100);
      assert.ok(a && a.has(s1));
      assert.strictEqual(a, b, "second call served from the cache");

      // The side branch moves: the answer must follow.
      repo.git("checkout", "-q", "side");
      const s2 = repo.commitEmpty("s2");
      repo.git("checkout", "-q", "main");
      const c = await readOffHeadHashes(repo.root, ":all", 100);
      assert.ok(c && c.has(s2), "new tip seen");

      // HEAD moves onto side: nothing is off HEAD any more.
      repo.git("merge", "-q", "--ff-only", "side");
      const d = await readOffHeadHashes(repo.root, ":all", 100);
      assert.ok(d && d.size === 0, `after fast-forward: ${d ? [...d].join(",") : "undefined"}`);

      // A different cap or view is its own entry; HEAD's own view still has nothing to dim.
      assert.notStrictEqual(await readOffHeadHashes(repo.root, ":all", 99), d);
      assert.strictEqual(await readOffHeadHashes(repo.root, "", 100), undefined);
    } finally {
      repo.dispose();
    }
  });
});

describe("1.8.1: the cache steps aside where checking it costs more than it saves", function () {
  this.timeout(30_000);
  afterEach(() => resetOffHeadCache());

  it("key dearer than the answer (many refs): answers are computed fresh, and stay correct", async () => {
    const repo = new TempRepo();
    const restore = fakeClock(50, 5);
    try {
      resetOffHeadCache();
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      const s1 = repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");
      const a = await readOffHeadHashes(repo.root, ":all", 100);
      const b = await readOffHeadHashes(repo.root, ":all", 100);
      assert.ok(a?.has(s1) && b?.has(s1));
      assert.notStrictEqual(a, b, "not served from the cache");
    } finally {
      restore();
      repo.dispose();
    }
  });

  it("after the periodic re-check finds the key cheap again, the cache is used again", async () => {
    const repo = new TempRepo();
    let restore = fakeClock(50, 5);
    try {
      resetOffHeadCache();
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");
      await readOffHeadHashes(repo.root, ":all", 100); // measured: skip from now on
      restore();
      restore = fakeClock(1, 5);
      // Calls 2–49 skip the cache; the 50th measures again and finds the key cheap.
      for (let i = 2; i < 50; i++) await readOffHeadHashes(repo.root, ":all", 100);
      await readOffHeadHashes(repo.root, ":all", 100); // call 50: re-check, cached again
      const x = await readOffHeadHashes(repo.root, ":all", 100);
      const y = await readOffHeadHashes(repo.root, ":all", 100);
      assert.strictEqual(x, y, "cached again after the re-check");
    } finally {
      restore();
      repo.dispose();
    }
  });
});
