import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ALL_REFS, readBranchTreePayload, readCurrentBranchName, readOffHeadHashes, readRecentCommits } from "../../src/gitExec";
import { TempRepo } from "../helpers/tempRepo";

/** Edge cases for the 1.8.1 changes, each checked against a fresh git computation. */

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function tryGitIn(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/** Uncached oracle: what HEAD cannot reach, from the same revisions the view logs. */
function oracleOffHead(cwd: string, rev: string | string[], cap = 1000): Set<string> | undefined {
  if (tryGitIn(cwd, "rev-parse", "--verify", "--quiet", "HEAD") === null) return undefined;
  let out: string;
  if (Array.isArray(rev)) {
    out = execFileSync("git", ["rev-list", `--max-count=${cap}`, "--stdin", "--not", "HEAD", "--"], {
      cwd,
      encoding: "utf8",
      input: rev.join("\n") + "\n",
    });
  } else {
    const revs = rev === ALL_REFS ? ["--branches", "--remotes", "--tags", "HEAD"] : [rev];
    out = gitIn(cwd, "rev-list", `--max-count=${cap}`, ...revs, "--not", "HEAD", "--");
  }
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Uncached oracle: is `hash` off HEAD? (undefined when HEAD is unborn: nothing dims) */
function oracleHashOff(cwd: string, hash: string): boolean | undefined {
  if (tryGitIn(cwd, "rev-parse", "--verify", "--quiet", "HEAD") === null) return undefined;
  return tryGitIn(cwd, "merge-base", "--is-ancestor", hash, "HEAD") === null;
}

async function assertOffHead(cwd: string, rev: string | string[], label: string, cap = 1000): Promise<void> {
  const got = await readOffHeadHashes(cwd, rev, cap);
  const want = oracleOffHead(cwd, rev, cap);
  assert.deepStrictEqual(got ? [...got].sort() : got, want ? [...want].sort() : want, label);
}

function sorted(s: ReadonlySet<string> | undefined): string[] | undefined {
  return s ? [...s].sort() : undefined;
}

describe("1.8.1 edge: current branch name", function () {
  this.timeout(30_000);

  it("unborn branch with a slash", async () => {
    const repo = new TempRepo();
    try {
      repo.git("symbolic-ref", "HEAD", "refs/heads/feature/new");
      assert.strictEqual(await readCurrentBranchName(repo.root), "feature/new");
      repo.commitEmpty("one");
      repo.git("checkout", "-q", "--orphan", "feature/orphan");
      assert.strictEqual(await readCurrentBranchName(repo.root), "feature/orphan");
    } finally {
      repo.dispose();
    }
  });

  it("non-ASCII branch name, unborn and born", async () => {
    const repo = new TempRepo();
    try {
      repo.git("symbolic-ref", "HEAD", "refs/heads/기능/한글-é");
      assert.strictEqual(await readCurrentBranchName(repo.root), "기능/한글-é");
      repo.commitEmpty("one");
      assert.strictEqual(await readCurrentBranchName(repo.root), "기능/한글-é");
    } finally {
      repo.dispose();
    }
  });

  it("unborn branch in a linked worktree", async () => {
    const repo = new TempRepo();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-wt-"));
    fs.rmdirSync(wt);
    try {
      repo.commitEmpty("one");
      repo.git("worktree", "add", "-q", "--orphan", "-b", "wt/unborn", wt);
      assert.strictEqual(await readCurrentBranchName(wt), "wt/unborn");
      assert.strictEqual(await readCurrentBranchName(repo.root), "main", "main worktree unaffected");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      repo.dispose();
    }
  });

  it("HEAD as a symref to a missing ref (repo has other commits)", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("one");
      repo.git("symbolic-ref", "HEAD", "refs/heads/missing");
      assert.strictEqual(await readCurrentBranchName(repo.root), "missing");
      // And the views do not throw.
      assert.deepStrictEqual(await readRecentCommits(repo.root, 10, ""), []);
      assert.strictEqual(await readOffHeadHashes(repo.root, ALL_REFS, 100), undefined);
    } finally {
      repo.dispose();
    }
  });
});

describe("1.8.1 edge: hash-search dimming", function () {
  this.timeout(60_000);

  /** base → main-only on main; base → side-only on side; HEAD = main. */
  function setup(): { repo: TempRepo; base: string; mainOnly: string; side: string } {
    const repo = new TempRepo();
    const base = repo.commitEmpty("base");
    repo.git("checkout", "-q", "-b", "side");
    const side = repo.commitEmpty("side only");
    repo.git("checkout", "-q", "main");
    const mainOnly = repo.commitEmpty("main only");
    return { repo, base, mainOnly, side };
  }

  async function check(repo: TempRepo, rev: string, query: string, expectHash: string | null, label: string) {
    const rows = await readRecentCommits(repo.root, 50, rev, undefined, query);
    if (expectHash === null) {
      // No hash hit: every row must come from --grep (messages here never contain hex).
      assert.ok(rows.every((r) => !r.offHead), `${label}: no dimmed hash hit`);
      return rows;
    }
    const row = rows.find((r) => r.hash === expectHash);
    assert.ok(row, `${label}: hit present`);
    const want = oracleHashOff(repo.root, expectHash);
    assert.strictEqual(!!row!.offHead, !!want, `${label}: offHead matches merge-base`);
    return rows;
  }

  it("All view: an off-HEAD hash hit is listed once and dimmed; an on-HEAD one is not", async () => {
    const { repo, side, mainOnly } = setup();
    try {
      // In :all the commit is already in the log; the hash path only adds missing rows.
      // readRecentCommits does not dim view rows itself, so --grep with a hex query may not list it.
      const rows = await readRecentCommits(repo.root, 50, ALL_REFS, undefined, side.slice(0, 8));
      const hit = rows.filter((r) => r.hash === side);
      assert.strictEqual(hit.length, 1, "listed exactly once");
      assert.strictEqual(!!hit[0].offHead, oracleHashOff(repo.root, side));
      await check(repo, ALL_REFS, mainOnly.slice(0, 8), mainOnly, "all/on-head");
    } finally {
      repo.dispose();
    }
  });

  it("single-branch view of another branch", async () => {
    const { repo, side, mainOnly, base } = setup();
    try {
      await check(repo, "side", mainOnly.slice(0, 8), mainOnly, "side view / main hash");
      await check(repo, "side", side.slice(0, 8), side, "side view / side hash");
      await check(repo, "side", base.slice(0, 8), base, "side view / base hash");
      await check(repo, "main", side.slice(0, 8), side, "main view / side hash");
    } finally {
      repo.dispose();
    }
  });

  it("ambiguous short hash yields no hash hit and no error", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("root");
      repo.commitEmptyMany(1500, "c");
      const all = repo.git("rev-list", "--all").split("\n").filter(Boolean);
      const seen = new Map<string, string>();
      let prefix: string | null = null;
      for (const h of all) {
        const p = h.slice(0, 4);
        if (seen.has(p)) { prefix = p; break; }
        seen.set(p, h);
      }
      assert.ok(prefix, "test setup: found a colliding 4-char prefix");
      assert.strictEqual(tryGitIn(repo.root, "rev-parse", "--verify", "--quiet", `${prefix}^{commit}`), null, "git agrees it is ambiguous");
      const rows = await readRecentCommits(repo.root, 5, "", undefined, prefix!);
      assert.ok(rows.every((r) => !r.offHead));
    } finally {
      repo.dispose();
    }
  });

  it("hash of an annotated tag object resolves to its commit and dims by that commit", async () => {
    const { repo, side } = setup();
    try {
      repo.git("tag", "-a", "-m", "tagged side", "t-side", side);
      const tagObj = repo.git("rev-parse", "t-side").trim();
      assert.notStrictEqual(tagObj, side);
      const rows = await check(repo, "", tagObj.slice(0, 10), side, "tag object hash");
      assert.strictEqual(rows[0].hash, side);
    } finally {
      repo.dispose();
    }
  });

  it("commit reachable only from a stash", async () => {
    const repo = new TempRepo();
    try {
      repo.write("f.txt", "1");
      repo.commitAll("base");
      repo.write("f.txt", "2");
      repo.git("stash", "-q");
      const stash = repo.git("rev-parse", "stash@{0}").trim();
      const rows = await check(repo, "", stash.slice(0, 10), stash, "stash commit");
      assert.strictEqual(rows[0].hash, stash);
      assert.strictEqual(rows[0].offHead, true);
      // :all excludes stash internals, so the hash path adds it too.
      await check(repo, ALL_REFS, stash.slice(0, 10), stash, "stash commit in :all");
    } finally {
      repo.dispose();
    }
  });

  it("commit reachable only from the reflog", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("base");
      const lost = repo.commitEmpty("lost");
      repo.git("reset", "-q", "--hard", "HEAD~1");
      const rows = await check(repo, "", lost, lost, "reflog-only (full hash)");
      assert.strictEqual(rows[0].offHead, true);
      await check(repo, ALL_REFS, lost.slice(0, 7), lost, "reflog-only in :all");
    } finally {
      repo.dispose();
    }
  });

  it("unborn HEAD with a hash query never dims", async () => {
    const { repo, side } = setup();
    try {
      repo.git("checkout", "-q", "--orphan", "empty");
      const rows = await readRecentCommits(repo.root, 50, ALL_REFS, undefined, side.slice(0, 8));
      const row = rows.find((r) => r.hash === side);
      assert.ok(row);
      assert.ok(!row!.offHead, "unborn HEAD: nothing dims");
      const own = await readRecentCommits(repo.root, 50, "", undefined, side.slice(0, 8));
      // HEAD's own log on an unborn HEAD returns early (pre-1.8.1 behavior): empty, no hash lookup.
      assert.deepStrictEqual(own, []);
    } finally {
      repo.dispose();
    }
  });

  it("full 40-char and uppercase hashes", async () => {
    const { repo, side, mainOnly } = setup();
    try {
      await check(repo, "", side, side, "full side");
      await check(repo, "", side.toUpperCase(), side, "UPPER full side");
      await check(repo, "", side.slice(0, 9).toUpperCase(), side, "UPPER short side");
      await check(repo, "side", mainOnly.toUpperCase(), mainOnly, "UPPER full main in side view");
    } finally {
      repo.dispose();
    }
  });
});

describe("1.8.1 edge: off-HEAD cache stays correct", function () {
  this.timeout(120_000);

  function setup(): TempRepo {
    const repo = new TempRepo();
    repo.commitEmpty("base");
    repo.git("checkout", "-q", "-b", "side");
    repo.commitEmpty("s1");
    repo.commitEmpty("s2");
    repo.git("checkout", "-q", "main");
    repo.commitEmpty("m1");
    return repo;
  }

  it("follows reset --hard, branch delete, tag create/delete, amend, update-ref on a remote", async () => {
    const repo = setup();
    try {
      const r = repo.root;
      await assertOffHead(r, ALL_REFS, "initial");
      await assertOffHead(r, "side", "initial side");

      repo.git("reset", "-q", "--hard", "side");
      await assertOffHead(r, ALL_REFS, "after reset --hard side");
      repo.git("reset", "-q", "--hard", "HEAD~2");
      await assertOffHead(r, ALL_REFS, "after reset --hard back");

      repo.git("branch", "-q", "tmp", "side~1");
      await assertOffHead(r, ALL_REFS, "branch created");
      repo.git("branch", "-q", "-D", "side");
      await assertOffHead(r, ALL_REFS, "after deleting side");

      repo.git("checkout", "-q", "tmp");
      const lone = repo.commitEmpty("lone");
      repo.git("checkout", "-q", "main");
      repo.git("tag", "lt", lone);
      repo.git("branch", "-q", "-D", "tmp");
      await assertOffHead(r, ALL_REFS, "lightweight tag only");
      repo.git("tag", "-d", "lt");
      await assertOffHead(r, ALL_REFS, "tag deleted");
      repo.git("tag", "-a", "-m", "x", "at", lone);
      await assertOffHead(r, ALL_REFS, "annotated tag created");
      repo.git("tag", "-d", "at");
      await assertOffHead(r, ALL_REFS, "annotated tag deleted");

      repo.git("branch", "-q", "keep");
      repo.commitEmpty("to amend");
      await assertOffHead(r, ALL_REFS, "before amend");
      await assertOffHead(r, "keep", "keep before amend");
      repo.git("commit", "-q", "--amend", "--allow-empty", "-m", "amended");
      await assertOffHead(r, ALL_REFS, "after amend");
      repo.git("branch", "-q", "-f", "keep", "HEAD@{1}");
      await assertOffHead(r, "keep", "keep = pre-amend commit");

      repo.git("update-ref", "refs/remotes/origin/main", lone);
      await assertOffHead(r, ALL_REFS, "remote-tracking ref created");
      await assertOffHead(r, "origin/main", "origin/main view");
      repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
      await assertOffHead(r, ALL_REFS, "remote-tracking ref moved to HEAD");
      await assertOffHead(r, "origin/main", "origin/main view after move");
      repo.git("update-ref", "-d", "refs/remotes/origin/main");
      await assertOffHead(r, ALL_REFS, "remote-tracking ref deleted");
    } finally {
      repo.dispose();
    }
  });

  it("array rev in a different order gives the same, correct set", async () => {
    const repo = setup();
    try {
      repo.git("branch", "-q", "other", "side~1");
      repo.git("update-ref", "refs/remotes/origin/x", "side");
      const a = ["refs/heads/side", "refs/heads/other", "refs/remotes/origin/x"];
      const b = [...a].reverse();
      await assertOffHead(repo.root, a, "order a");
      await assertOffHead(repo.root, b, "order b");
      assert.deepStrictEqual(sorted(await readOffHeadHashes(repo.root, a, 1000)), sorted(await readOffHeadHashes(repo.root, b, 1000)));
    } finally {
      repo.dispose();
    }
  });

  it("two repos with identical histories do not share answers", async () => {
    const make = (): TempRepo => {
      const repo = new TempRepo();
      for (const [k, v] of [["GIT_COMMITTER_DATE", "1700000000 +0000"], ["GIT_AUTHOR_DATE", "1700000000 +0000"]]) process.env[k] = v;
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");
      return repo;
    };
    const saved = { c: process.env.GIT_COMMITTER_DATE, a: process.env.GIT_AUTHOR_DATE };
    let a: TempRepo | undefined;
    let b: TempRepo | undefined;
    try {
      a = make();
      b = make();
      assert.strictEqual(a.head(), b.head(), "setup: identical hashes");
      await assertOffHead(a.root, ALL_REFS, "repo a");
      await assertOffHead(b.root, ALL_REFS, "repo b");
      // Diverge b only via a ref a does not have.
      b.git("checkout", "-q", "side");
      b.commitEmpty("b only");
      b.git("checkout", "-q", "main");
      await assertOffHead(a.root, ALL_REFS, "repo a after b moved");
      await assertOffHead(b.root, ALL_REFS, "repo b after b moved");
    } finally {
      if (saved.c === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = saved.c;
      if (saved.a === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = saved.a;
      a?.dispose();
      b?.dispose();
    }
  });

  it("more than 6 distinct keys: eviction still gives correct answers", async () => {
    const repo = setup();
    try {
      const keys: Array<[string, number]> = [];
      for (let cap = 1; cap <= 10; cap++) keys.push([ALL_REFS, cap]);
      keys.push(["side", 1000], ["side~1", 1000], ["main", 1000]);
      for (let round = 0; round < 2; round++) {
        for (const [rev, cap] of keys) {
          const got = await readOffHeadHashes(repo.root, rev, cap);
          const full = oracleOffHead(repo.root, rev)!;
          // At the cap the subset depends on topo-order, so check size and membership.
          assert.ok(got, `${rev}/${cap} defined`);
          assert.strictEqual(got!.size, Math.min(cap, full.size), `${rev}/${cap} size (round ${round})`);
          for (const h of got!) assert.ok(full.has(h), `${rev}/${cap} member ${h}`);
        }
        repo.git("checkout", "-q", "side");
        repo.commitEmpty(`round ${round}`);
        repo.git("checkout", "-q", "main");
      }
    } finally {
      repo.dispose();
    }
  });

  it("concurrent calls with the same and different keys", async () => {
    const repo = setup();
    try {
      const revs: Array<string | string[]> = [ALL_REFS, ALL_REFS, "side", "side", ["refs/heads/side"], ALL_REFS, "side~1"];
      const got = await Promise.all(revs.map((r) => readOffHeadHashes(repo.root, r, 1000)));
      revs.forEach((r, i) => {
        assert.deepStrictEqual(sorted(got[i]), sorted(oracleOffHead(repo.root, r)), `concurrent #${i}`);
      });
      // Move a ref, then race again.
      repo.git("checkout", "-q", "side");
      repo.commitEmpty("moved");
      repo.git("checkout", "-q", "main");
      const got2 = await Promise.all(revs.map((r) => readOffHeadHashes(repo.root, r, 1000)));
      revs.forEach((r, i) => {
        assert.deepStrictEqual(sorted(got2[i]), sorted(oracleOffHead(repo.root, r)), `concurrent after move #${i}`);
      });
    } finally {
      repo.dispose();
    }
  });
});

describe("1.8.1 edge: review fixes", function () {
  this.timeout(60_000);

  it("readBranchTreePayload().current is '' on an unborn branch; name still read by readCurrentBranchName", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("one");
      repo.git("checkout", "-q", "--orphan", "feature/new");
      assert.strictEqual((await readBranchTreePayload(repo.root)).current, "");
      assert.strictEqual(await readCurrentBranchName(repo.root), "feature/new");
      repo.git("checkout", "-q", "main");
      assert.strictEqual((await readBranchTreePayload(repo.root)).current, "main");
      repo.git("checkout", "-q", "--detach", "HEAD");
      assert.strictEqual((await readBranchTreePayload(repo.root)).current, "HEAD");
    } finally {
      repo.dispose();
    }
  });

  it("array rev with duplicates gives the correct set", async () => {
    const repo = new TempRepo();
    try {
      repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");
      await assertOffHead(repo.root, ["refs/heads/side", "refs/heads/side", "refs/heads/main"], "dupes");
    } finally {
      repo.dispose();
    }
  });

  it("grafts: answer follows a grafts file change without any ref moving", async () => {
    const repo = new TempRepo();
    try {
      const base = repo.commitEmpty("base");
      repo.git("checkout", "-q", "-b", "side");
      const s1 = repo.commitEmpty("s1");
      repo.git("checkout", "-q", "main");
      await assertOffHead(repo.root, ALL_REFS, "before grafts");
      // Graft s1 onto nothing changes nothing; graft main's tip onto s1 makes s1 reachable from HEAD.
      const head = repo.head();
      const grafts = gitIn(repo.root, "rev-parse", "--git-path", "info/grafts").trim();
      fs.mkdirSync(path.dirname(path.resolve(repo.root, grafts)), { recursive: true });
      fs.writeFileSync(path.resolve(repo.root, grafts), `${head} ${s1}\n`);
      await assertOffHead(repo.root, ALL_REFS, "with grafts");
      fs.writeFileSync(path.resolve(repo.root, grafts), `${head} ${base}\n`);
      await assertOffHead(repo.root, ALL_REFS, "grafts edited");
    } finally {
      repo.dispose();
    }
  });

  it("shallow clone: hash hit never dims, off-HEAD stays correct", async () => {
    const src = new TempRepo();
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-shallow-"));
    try {
      src.commitEmpty("a");
      src.commitEmpty("b");
      src.git("checkout", "-q", "-b", "side");
      const side = src.commitEmpty("side");
      src.git("checkout", "-q", "main");
      src.commitEmpty("c");
      execFileSync("git", ["clone", "-q", "--no-local", "--depth=1", "--no-single-branch", src.root, dst]);
      assert.strictEqual(gitIn(dst, "rev-parse", "--is-shallow-repository").trim(), "true");
      const rows = await readRecentCommits(dst, 50, "", undefined, side.slice(0, 10));
      const row = rows.find((r) => r.hash === side);
      assert.ok(row, "hit present");
      assert.ok(!row!.offHead, "shallow: never dims");
      await assertOffHead(dst, ALL_REFS, "shallow all");
    } finally {
      fs.rmSync(dst, { recursive: true, force: true });
      src.dispose();
    }
  });
});
