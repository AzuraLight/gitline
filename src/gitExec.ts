import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type {
  GitBranchTreePayload,
  GitCommitFile,
  GitCommitRef,
  GitCommitRow,
  GitStashEntry,
  GitSyncState,
  GitWorkingState,
} from "./types";
import { ALL_REFS } from "./viewSelection";

const execFileAsync = promisify(execFile);

/** Network operations (pull/push/fetch) give up after this long instead of hanging the panel. */
const NETWORK_TIMEOUT_MS = 120_000;

/** input: written to git's stdin (e.g. revisions for `--stdin`, which has no command-line length limit). */
type ExecOptions = { maxBuffer?: number; timeoutMs?: number; input?: string; env?: Record<string, string>; signal?: AbortSignal };

/**
 * Every git invocation goes through here, with explicit argv (no shell).
 * - `core.quotePath=false` keeps non-ASCII paths (한글, 中文, …) as real UTF-8 instead of `"\355…"` escapes.
 * - `GIT_TERMINAL_PROMPT=0` makes git fail fast when it would otherwise wait on a credential prompt
 *   that has no terminal to appear in. Credential helpers (GCM, keychain, ssh-agent) still work.
 */
async function execGit(cwd: string, args: string[], options: ExecOptions = {}): Promise<string> {
  try {
    const run = execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 0,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      signal: options.signal,
    });
    // Always close stdin: a command that does not read it must not wait on an open pipe. If git
    // exits before reading a large input the write fails with EPIPE; the exit status already
    // reports the failure, so the stream error must not become an uncaught exception.
    run.child.stdin?.on("error", () => undefined);
    run.child.stdin?.end(options.input ?? "");
    const { stdout } = await run;
    return typeof stdout === "string" ? stdout : String(stdout);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; killed?: boolean; signal?: string };
    if (e?.killed && options.timeoutMs) {
      throw new Error(`git ${args[0]} timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    }
    const parts: string[] = [];
    if (e?.message) {
      parts.push(e.message);
    }
    if (e?.stderr !== undefined) {
      const s = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr);
      if (s.trim()) {
        parts.push(s.trim());
      }
    }
    throw new Error(parts.join("\n") || "Git command failed");
  }
}

/**
 * `git blame --porcelain` for `repoPath` as it currently reads in the editor: `contents` goes to
 * `--contents -` on stdin, so line numbers still match after unsaved edits.
 */
export function readBlamePorcelain(cwd: string, repoPath: string, contents: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", "blame", "--porcelain", "--contents", "-", "--", repoPath], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `git blame exited with ${code}`));
    });
    child.stdin.on("error", () => {
      /* git exits early for untracked files; the close handler reports it */
    });
    child.stdin.end(contents, "utf8");
  });
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * `fsPath` relative to `repoRoot`, with `/` separators. Both are resolved through symlinks first:
 * git reports the real root (macOS /var → /private/var, a symlinked checkout), while VS Code keeps
 * the path the user opened. Returns "" for the root itself and a path starting ".." when outside.
 */
export function repoRelativePath(repoRoot: string, fsPath: string): string {
  return path.relative(realPath(repoRoot), realPath(fsPath)).split(path.sep).join("/");
}

/** Runs `git` for local operations. cwd must be the repository root. */
export async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args);
}

/** Runs `git` with `input` on stdin (e.g. a tag message given as `-F -`); `timeoutMs` 0 = none. */
export async function runGitWithInput(cwd: string, args: string[], input: string, timeoutMs = 0): Promise<string> {
  return execGit(cwd, args, { input, timeoutMs });
}

/** Runs git, stopped when `signal` aborts (the promise then rejects). */
export async function runGitAbortable(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return execGit(cwd, args, { signal });
}

/** Runs `git` in the C locale, for output that is parsed by its English wording. */
export async function runGitC(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, { env: { LC_ALL: "C", LANG: "C", LANGUAGE: "C" } });
}

/** Runs `git` without ever opening an editor: GIT_EDITOR=":" makes git keep the message it prepared. */
export async function runGitNoEditor(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, { env: { GIT_EDITOR: ":" } });
}

/** Runs `git` for operations that talk to a remote — bounded by {@link NETWORK_TIMEOUT_MS}. */
export async function runGitNetworkCommand(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, { timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * Exit status of a git probe whose answer is its exit code (`merge-base --is-ancestor`: 0 yes,
 * 1 no, anything else = could not tell). -1 when git did not run or timed out.
 */
async function gitExitCode(cwd: string, args: string[], timeoutMs: number): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return 0;
  } catch (e: unknown) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "number" ? code : -1;
  }
}

/** True in a shallow clone: ancestry past its boundary is unknown, so "not on HEAD" can be wrong. */
async function isShallow(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--is-shallow-repository"]))?.trim() === "true";
}

/** Runs `git` and resolves to null instead of throwing — for probes where failure is an answer. */
async function tryGit(cwd: string, args: string[], input?: string, maxBuffer = 4 * 1024 * 1024): Promise<string | null> {
  try {
    return await execGit(cwd, args, { maxBuffer, input });
  } catch {
    return null;
  }
}

function splitRecord(block: string): string[] {
  return block.split("\x1e");
}

/**
 * Returns true if `rev` resolves to a commit in this repo. Used to gracefully
 * fall back to the default log when a selected branch/rev no longer exists
 * (deleted/renamed remote branch, or a typo) instead of failing the whole view.
 */
export async function revExists(cwd: string, rev: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])) !== null;
}

/** Full hash of the commit `rev` points to, or null when it does not resolve. */
async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const out = await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const hash = out?.trim() ?? "";
  return hash.length > 0 ? hash : null;
}

export async function getRepoRoot(cwd: string): Promise<string | null> {
  const root = (await tryGit(cwd, ["rev-parse", "--show-toplevel"]))?.trim() ?? "";
  return root.length > 0 ? root : null;
}

/** Walks parent directories from a file path until a Git root is found. */
export async function resolveRepoRootForFile(fileFsPath: string): Promise<string | null> {
  let dir = path.dirname(fileFsPath);
  for (let depth = 0; depth < 80; depth++) {
    const root = await getRepoRoot(dir);
    if (root) {
      return root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/** Current branch (or empty if detached / error). */
export async function readCurrentBranchName(cwd: string): Promise<string> {
  const name = (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  if (name) return name;
  // A branch with no commits yet (new repository, `checkout --orphan`): HEAD names it, but
  // rev-parse cannot resolve it. symbolic-ref reads the name without needing a commit.
  return (await tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() ?? "";
}

/**
 * Upstream tracking state of the current branch. Returns `upstream: null` when
 * the branch has no upstream (or HEAD is detached); ahead/behind default to 0.
 */
export async function readSyncState(cwd: string): Promise<GitSyncState> {
  const u = (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim();
  if (!u) {
    return { upstream: null, ahead: 0, behind: 0 };
  }
  const counts = await tryGit(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  if (counts === null) {
    return { upstream: u, ahead: 0, behind: 0 };
  }
  const parts = counts.trim().split(/\s+/);
  return { upstream: u, ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0 };
}

function refNames(out: string | null): string[] {
  return (out ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Local + remote branch names for a SourceTree-style sidebar. */
export async function readBranchTreePayload(cwd: string): Promise<GitBranchTreePayload> {
  const [current, localOut, remoteOut] = await Promise.all([
    readCurrentBranchName(cwd),
    tryGit(cwd, ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/heads/"]),
    tryGit(cwd, ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/remotes/"]),
  ]);
  const locals = refNames(localOut).filter((s) => s !== "HEAD");
  const remoteMap = new Map<string, Set<string>>();
  for (const s of refNames(remoteOut)) {
    const i = s.indexOf("/");
    if (i <= 0) {
      continue;
    }
    const remote = s.slice(0, i);
    if (s.slice(i + 1) === "HEAD") {
      continue;
    }
    if (!remoteMap.has(remote)) {
      remoteMap.set(remote, new Set());
    }
    remoteMap.get(remote)!.add(s);
  }
  const remotes = [...remoteMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, set]) => ({ remote, branches: [...set].sort() }));
  // The sidebar starts a Ctrl/Cmd+click selection from `current`: only a branch that exists can be
  // part of it. A branch with no commits yet is named in the header (payload.branch), not here.
  const sidebarCurrent = current === "HEAD" || locals.includes(current) ? current : "";
  return { current: sidebarCurrent, locals, remotes };
}

const COMMIT_RECORD_SEP = "\x1f";
const COMMIT_FORMAT = ["%H", "%P", "%s", "%an", "%ct", "%D"].join("%x1e") + "%x1f";

/**
 * `%D` with `--decorate=full`, e.g. "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1".
 * Full names are what tell a local `feature/x` from a remote `origin/x`: with short names both
 * contain a "/" and local branches were shown as remote ones.
 */
export function parseDecorate(decorate: string): GitCommitRef[] {
  const out: GitCommitRef[] = [];
  // git joins decorations with ", ". A ref name may contain a comma but never a space, so
  // splitting on ", " keeps a branch like "a,b" whole.
  for (const piece of decorate.split(", ")) {
    let item = piece.trim();
    if (!item) continue;
    let kind: GitCommitRef["kind"] | undefined;
    const arrow = item.match(/^HEAD\s*->\s*(.+)$/);
    if (arrow) {
      item = arrow[1].trim();
      kind = "head";
    } else if (item === "HEAD") {
      out.push({ label: "HEAD", kind: "head" });
      continue;
    } else if (item.startsWith("tag: ")) {
      item = item.slice(5).trim();
      kind = "tag";
    }
    if (item.startsWith("refs/heads/")) {
      out.push({ label: item.slice("refs/heads/".length), kind: kind ?? "local" });
    } else if (item.startsWith("refs/remotes/")) {
      out.push({ label: item.slice("refs/remotes/".length), kind: kind ?? "remote" });
    } else if (item.startsWith("refs/tags/")) {
      out.push({ label: item.slice("refs/tags/".length), kind: "tag" });
    } else {
      // refs/stash, refs/notes/…, or a short name from a git that ignored --decorate=full.
      out.push({ label: item.replace(/^refs\//, ""), kind: kind ?? "other" });
    }
  }
  return out;
}

function parseCommitRows(out: string): GitCommitRow[] {
  const rows: GitCommitRow[] = [];
  for (const raw of out.split(COMMIT_RECORD_SEP)) {
    const chunk = raw.trim();
    if (!chunk) {
      continue;
    }
    const [hash, parents, subject, author, dateSec, decorate] = splitRecord(chunk);
    if (!hash) {
      continue;
    }
    rows.push({
      hash,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      subject: subject ?? "",
      author: author ?? "",
      dateSec: Number(dateSec) || 0,
      refs: parseDecorate(decorate ?? ""),
    });
  }
  return rows;
}

export type MergesMode = "all" | "hide" | "only";

/** A search that looks like a commit hash (4–40 hex characters). */
export function looksLikeHash(query: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(query);
}

/**
 * ALL_REFS is the view id for "every branch": local and remote branches, tags and HEAD (so a
 * detached HEAD shows too). Not `--all`, which would also pull in stash internals as graph nodes.
 * `:` cannot appear in a ref name, so this never collides with a real branch.
 */
export { ALL_REFS };

function revArgs(rev: string, headBorn = true): string[] {
  if (rev !== ALL_REFS) return [rev];
  // An unborn HEAD (new repo, or `checkout --orphan`) is a fatal "unknown revision" for git log;
  // without it the other refs still list, and no refs at all is simply an empty log.
  return headBorn ? ["--branches", "--remotes", "--tags", "HEAD"] : ["--branches", "--remotes", "--tags"];
}

/**
 * What a graph view logs: one rev as typed (a branch name, `:all`), or a list of full ref names
 * (`refs/heads/x`) from {@link resolveRefSelection}. A list goes to git on stdin (`--stdin`), so
 * hundreds of branches never hit the Windows command-line limit.
 */
export type ViewRev = string | string[];

function viewRevInput(rev: string[]): string {
  return rev.join("\n") + "\n";
}

const REF_ROOTS = ["refs/heads/", "refs/remotes/", "refs/tags/"];

/** `*` matches within one path segment, as git's own ref patterns do (`origin/team/*` ≠ `origin/team/a/b`). */
function refPattern(pattern: string): RegExp {
  const body = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${body}$`);
}

/**
 * Turns names and `*` patterns (local `main`, remote `origin/x`, tags, `origin/team/*`) into the full
 * ref names that exist now. A name or pattern is tried under refs/heads, refs/remotes and refs/tags,
 * so no remote list is needed. A name that is no ref but still a revision git knows (`refs/heads/x`,
 * a SHA, `HEAD`, `main~3`) is kept as written, so an entry means the same alone as in a list.
 * `missing` holds the entries that matched nothing. Throws when the refs cannot be listed at all,
 * so a failing git is never mistaken for "these branches are gone".
 */
export async function resolveRefSelection(cwd: string, wanted: string[]): Promise<{ refs: string[]; missing: string[] }> {
  const out = await execGit(cwd, ["for-each-ref", "--format=%(refname)", ...REF_ROOTS.map((r) => r.slice(0, -1))]);
  const all = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (r: string) => {
    if (!seen.has(r)) {
      seen.add(r);
      refs.push(r);
    }
  };
  const missing: string[] = [];
  for (const raw of wanted) {
    const w = raw.trim();
    if (!w) continue;
    // Revisions go to git on stdin, where a leading "-" would read as an option (`--not`, `--all`).
    if (w.startsWith("-")) {
      missing.push(w);
      continue;
    }
    const re = w.includes("*") ? refPattern(w) : null;
    const hits = all.filter((full) => {
      const root = REF_ROOTS.find((r) => full.startsWith(r));
      if (!root) return false;
      const short = full.slice(root.length);
      if (!re) return short === w || full === w;
      // origin/HEAD only points at another remote branch; a pattern would list it twice.
      if (root === "refs/remotes/" && short.endsWith("/HEAD")) return false;
      return re.test(short);
    });
    if (hits.length === 0 && !re && (await revExists(cwd, w))) hits.push(w);
    if (hits.length === 0) missing.push(w);
    for (const h of hits) add(h);
  }
  return { refs, missing };
}

/**
 * A shallow clone or grafts: deepening it (fetch --unshallow / --deepen) or editing the grafts file
 * changes the history without moving any ref, so answers keyed by the refs cannot be kept.
 */
async function historyCanChangeUnderRefs(cwd: string): Promise<boolean> {
  if (await isShallow(cwd)) return true;
  const grafts = await tryGit(cwd, ["rev-parse", "--git-path", "info/grafts"]);
  return grafts !== null && fs.existsSync(path.resolve(cwd, grafts.trim()));
}

/**
 * A key for "the history and its labels as they are now": HEAD and every ref tip (stash included),
 * plus whatever else the answer depends on. Null when it cannot be read.
 */
async function refStateKey(cwd: string, extra: unknown[]): Promise<string | null> {
  const tips = await tryGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const head = await tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (tips === null || head === null) return null;
  // Which branch HEAD is on: switching between two branches at the same commit, or detaching
  // there, moves no tip but changes the HEAD label (1.10.0 review). Empty when detached.
  const onBranch = (await tryGit(cwd, ["symbolic-ref", "-q", "HEAD"])) ?? "";
  // log.* settings (excludeDecoration, showSignature, …) change git log's output without a ref move.
  const logConfig = (await tryGit(cwd, ["config", "--get-regexp", "^log\\."])) ?? "";
  return createHash("sha1").update(JSON.stringify([cwd, ...extra, head.trim(), onBranch.trim(), logConfig, tips])).digest("hex");
}

/**
 * Hashes reachable from `rev` but not from HEAD, at most `cap` of them. Undefined for HEAD's own
 * log (nothing to dim) or when it cannot be computed (unborn HEAD) — callers then dim nothing.
 */
/**
 * The last few off-HEAD answers. The rev-list walks up to `cap` commits and runs on every refresh
 * and page; it only changes when HEAD or a ref tip moves, so the key holds HEAD and every tip.
 */
const offHeadCache = new Map<string, ReadonlySet<string> | undefined>();
const OFF_HEAD_CACHE_SIZE = 6;

/**
 * Per repository: what checking the cache key cost against what computing the answer cost, last
 * time both were measured. With tens of thousands of refs, listing them can cost more than the
 * capped rev-list it is meant to save — then the cache is skipped, so no repository is slower than
 * without it. Measured again every RECHECK_EVERY calls, as a repository's refs come and go.
 */
type OffHeadCost = { keyMs: number; computeMs: number; skip: boolean; calls: number };
const offHeadCost = new Map<string, OffHeadCost>();
const RECHECK_EVERY = 50;

/** Times one phase of the cost check ("key" or "compute"); tests replace `ms` to pick the costs. */
export const offHeadClock = {
  ms: (_phase: "key" | "compute", started: number): number => performance.now() - started,
};

/** Test hook: forget cached answers and measured costs. */
export function resetOffHeadCache(): void {
  offHeadCache.clear();
  offHeadCost.clear();
}

export async function readOffHeadHashes(cwd: string, rev: ViewRev | undefined, cap: number): Promise<ReadonlySet<string> | undefined> {
  if (Array.isArray(rev) ? rev.length === 0 : !rev?.trim()) return undefined;
  const cost = offHeadCost.get(cwd) ?? { keyMs: 0, computeMs: 0, skip: false, calls: 0 };
  offHeadCost.set(cwd, cost);
  cost.calls++;
  if (cost.skip && cost.calls % RECHECK_EVERY !== 0) return computeOffHeadHashes(cwd, rev, cap);
  // Not cached in a shallow clone: deepening it (fetch --unshallow / --deepen) changes the answer
  // without moving any ref. Nor with grafts, which do the same from a file.
  if (await historyCanChangeUnderRefs(cwd)) return computeOffHeadHashes(cwd, rev, cap);
  const t0 = performance.now();
  // The order of a picked list does not change the answer.
  const revKey = Array.isArray(rev) ? [...new Set(rev)].sort() : rev;
  const key = await refStateKey(cwd, [revKey, cap]);
  cost.keyMs = offHeadClock.ms("key", t0);
  if (key !== null && offHeadCache.has(key)) {
    const hit = offHeadCache.get(key);
    offHeadCache.delete(key); // most recently used goes last
    offHeadCache.set(key, hit);
    return hit;
  }
  const t1 = performance.now();
  const result = await computeOffHeadHashes(cwd, rev, cap);
  cost.computeMs = offHeadClock.ms("compute", t1);
  // The key cost more than the answer: stop paying for it in this repository (until the recheck).
  cost.skip = key === null || cost.keyMs > cost.computeMs;
  if (key !== null && !cost.skip) {
    offHeadCache.set(key, result);
    while (offHeadCache.size > OFF_HEAD_CACHE_SIZE) offHeadCache.delete(offHeadCache.keys().next().value as string);
  }
  return result;
}

/** 41 bytes a hash: room for well over the panel's 100,000 cap (4 MB would barely hold it). */
const OFF_HEAD_BUFFER = 16 * 1024 * 1024;

async function computeOffHeadHashes(cwd: string, rev: ViewRev | undefined, cap: number): Promise<Set<string> | undefined> {
  // --topo-order matches the graph's order, so at the cap it is the oldest rows that go undimmed.
  // The trailing "--" keeps a file named HEAD (or like a branch) from being read as a path.
  const base = ["rev-list", "--topo-order", `--max-count=${cap}`];
  let out: string | null;
  if (Array.isArray(rev)) {
    if (rev.length === 0) return undefined;
    out = await tryGit(cwd, [...base, "--stdin", "--not", "HEAD", "--"], viewRevInput(rev), OFF_HEAD_BUFFER);
  } else {
    const target = rev?.trim();
    if (!target) return undefined;
    out = await tryGit(cwd, [...base, ...revArgs(target), "--not", "HEAD", "--"], undefined, OFF_HEAD_BUFFER);
  }
  if (out === null) return undefined;
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/**
 * The commit a hex query names, as one row (none if it names nothing), dimmed when HEAD cannot
 * reach it: found by hash, not by the view's revisions. Only a clear "no" (exit 1) dims; an error,
 * a timeout, a shallow clone (where git cannot see the whole ancestry) or a branch with no commit
 * yet leaves it undimmed.
 */
async function hashHitRows(cwd: string, q: string): Promise<GitCommitRow[]> {
  const hash = await resolveCommit(cwd, q);
  if (!hash) return [];
  const hit = parseCommitRows(
    await execGit(cwd, ["log", "--max-count=1", "--decorate=full", `--pretty=format:${COMMIT_FORMAT}`, hash]),
  );
  if (!hit.length) return hit;
  // With no commit on HEAD nothing is dimmed (as in the All branches view then).
  if ((await revExists(cwd, "HEAD")) && !(await isShallow(cwd))) {
    if ((await gitExitCode(cwd, ["merge-base", "--is-ancestor", hash, "HEAD"], 10_000)) === 1) hit[0].offHead = true;
  }
  return hit;
}

/**
 * Graph rows, a page at a time. git sorts the whole history (--topo-order) before it prints the
 * first row, so each page used to cost as much as the whole walk — and the panel asks again for
 * every page as you scroll (200, 400, … 5,000): up to 30 s in a large repository without a
 * commit-graph file (1.10.0). Now the first page is read as asked; from the second page on, rows
 * are read ahead in growing steps (READ_AHEAD) and later pages are cut from them while HEAD and
 * every ref tip stay as they were. Most people never scroll past the first step, so they never
 * pay for a longer read.
 */
const READ_AHEAD = [5000, 10000, 20000, 50000];
/** Cached rows kept in all (a 50,000-row read is about 12 MB as JSON); the oldest go first. Tests lower it. */
export const pageCacheLimit = { rows: 100000 };
type CachedRows = { rows: GitCommitRow[]; asked: number };
const pageCache = new Map<string, CachedRows>();

/** Test hooks: forget the cached pages; how many pages were cut from the cache / read from git. */
export const pageCacheStats = { hits: 0, reads: 0 };
export function resetPageCache(): void {
  pageCache.clear();
  pageCacheStats.hits = 0;
  pageCacheStats.reads = 0;
}

export async function readRecentCommits(
  cwd: string,
  limit: number,
  rev?: ViewRev,
  pathFilter?: string,
  query?: string,
  mergesMode?: MergesMode,
): Promise<GitCommitRow[]> {
  const firstPage = limit <= 200;
  // An @author search goes through .mailmap, a working-tree file no ref move reflects.
  const byAuthor = (query?.trim() ?? "").startsWith("@");
  if (firstPage || byAuthor || (await historyCanChangeUnderRefs(cwd))) {
    return computeRecentCommits(cwd, limit, rev, pathFilter, query, mergesMode);
  }
  // A picked list's order and repeats do not change the rows (git walks them as one set).
  const revKey = Array.isArray(rev) ? [...new Set(rev)].sort() : rev ?? "";
  const key = await refStateKey(cwd, ["page", revKey, pathFilter?.trim() ?? "", query?.trim() ?? "", mergesMode ?? ""]);
  const hit = key === null ? undefined : pageCache.get(key);
  // Enough rows, or fewer than asked for back then: the history has no more.
  if (hit && (hit.rows.length >= limit || hit.rows.length < hit.asked)) {
    pageCache.delete(key as string); // most recently used goes last
    pageCache.set(key as string, hit);
    pageCacheStats.hits++;
    return hit.rows.slice(0, limit);
  }
  pageCacheStats.reads++;
  const asked = READ_AHEAD.find((n) => n >= limit) ?? limit;
  // The rows are shared with later cut pages, not copied: the panel marks `offHead` on them, which
  // depends only on HEAD and the refs — both in the key. Copy them if that ever changes.
  let rows: GitCommitRow[];
  try {
    rows = await computeRecentCommits(cwd, asked, rev, pathFilter, query, mergesMode);
  } catch (e) {
    // Reading ahead is an optimisation: if the larger read fails, answer what was asked.
    if (asked === limit) throw e;
    return computeRecentCommits(cwd, limit, rev, pathFilter, query, mergesMode);
  }
  if (key !== null) {
    pageCache.delete(key);
    pageCache.set(key, { rows, asked });
    let total = 0;
    for (const v of pageCache.values()) total += v.rows.length;
    // Drop the least recently used until the rest fit; the newest stays even if it alone is larger.
    for (const [k, v] of pageCache) {
      if (total <= pageCacheLimit.rows || k === key) break;
      pageCache.delete(k);
      total -= v.rows.length;
    }
  }
  return rows.slice(0, limit);
}

const LOG_BUFFER = 128 * 1024 * 1024;

async function computeRecentCommits(
  cwd: string,
  limit: number,
  rev?: ViewRev,
  pathFilter?: string,
  query?: string,
  mergesMode?: MergesMode,
): Promise<GitCommitRow[]> {
  const logArgs = ["log"];
  let input: string | undefined;
  const target = Array.isArray(rev) ? undefined : rev?.trim();
  if (Array.isArray(rev)) {
    if (rev.length === 0) return [];
    logArgs.push("--stdin");
    input = viewRevInput(rev);
  } else if (!target || target === ALL_REFS) {
    // HEAD with no commits yet: HEAD's own log is empty rather than a git error card.
    const headBorn = await revExists(cwd, "HEAD");
    if (!target && !headBorn) {
      // Nothing to log, but a hash search can still find a commit on another branch.
      const hq = query?.trim();
      return hq && looksLikeHash(hq) ? hashHitRows(cwd, hq) : [];
    }
    if (target) logArgs.push(...revArgs(target, headBorn));
  } else {
    logArgs.push(...revArgs(target));
  }
  logArgs.push(`--max-count=${limit}`, "--decorate=full", `--pretty=format:${COMMIT_FORMAT}`, "--topo-order");
  if (mergesMode === "hide") {
    logArgs.push("--no-merges");
  } else if (mergesMode === "only") {
    logArgs.push("--merges");
  }

  const q = query?.trim();
  if (q && q.length > 0) {
    if (q.startsWith("@") && q.length > 1) {
      // @author syntax → author filter
      logArgs.push(`--author=${q.slice(1)}`, "--regexp-ignore-case");
    } else {
      logArgs.push(`--grep=${q}`, "--regexp-ignore-case");
    }
  }

  const pf = pathFilter?.trim();
  if (pf && pf.length > 0) {
    logArgs.push("--follow", "--", pf);
  } else {
    // End the revisions explicitly: otherwise a file named HEAD or like a branch makes git
    // stop with "ambiguous argument".
    logArgs.push("--");
  }
  // 50,000 rows of a real repository are ~9 MB (VS Code's); long subjects go well past the 10 MB
  // default, and a full buffer failed the whole graph (1.10.0 review).
  const rows = parseCommitRows(await execGit(cwd, logArgs, { input, maxBuffer: LOG_BUFFER }));

  // A hex query may be a commit hash — `--grep` only searches messages, so look the hash up
  // directly and put that commit first (deduplicated if its message also matched).
  if (q && looksLikeHash(q)) {
    const hash = await resolveCommit(cwd, q);
    if (hash && !rows.some((r) => r.hash === hash)) {
      const hit = await hashHitRows(cwd, q);
      rows.unshift(...hit);
    }
  }
  return rows;
}

/** Counts of working tree changes by category. */
export async function readWorkingState(cwd: string): Promise<GitWorkingState> {
  const out = await execGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }
    if ((x === "U" || y === "U") || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted += 1;
      continue;
    }
    if (x !== " " && x !== "?") staged += 1;
    if (y !== " " && y !== "?") modified += 1;
  }
  return { staged, modified, untracked, conflicted };
}

/** All stashes via `git stash list`. */
export async function readStashes(cwd: string): Promise<GitStashEntry[]> {
  const fmt = ["%gd", "%h", "%ct", "%s"].join("%x1e") + "%x1f";
  const out = await tryGit(cwd, ["stash", "list", `--format=${fmt}`]);
  if (out === null) {
    return [];
  }
  const list: GitStashEntry[] = [];
  for (const raw of out.split("\x1f")) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const [ref, parentShort, dateSec, subject] = chunk.split("\x1e");
    if (!ref) continue;
    list.push({
      ref,
      parentShort: parentShort ?? "",
      subject: subject ?? "",
      dateSec: Number(dateSec) || 0,
    });
  }
  return list;
}

/**
 * Joins `--name-status -z` and `--numstat -z` output into file changes.
 *
 * NUL-separated output is the only form git guarantees to be unambiguous: paths are raw bytes
 * (no quoting of non-ASCII, tabs or newlines) and renames list old and new path separately
 * instead of the `{old => new}` shorthand that line-based numstat uses.
 */
export function parseChangedFiles(nameStatusZ: string, numstatZ: string): GitCommitFile[] {
  const stats = new Map<string, { ins: number; del: number }>();
  const numTokens = numstatZ.split("\0");
  for (let i = 0; i < numTokens.length; i++) {
    const token = numTokens[i].replace(/^\n+/, "");
    const cols = token.split("\t");
    if (cols.length < 3) continue;
    const ins = cols[0] === "-" ? 0 : Number(cols[0]) || 0;
    const del = cols[1] === "-" ? 0 : Number(cols[1]) || 0;
    let target = cols.slice(2).join("\t");
    if (target === "") {
      // Rename/copy: "<ins>\t<del>\t\0<old>\0<new>\0"
      target = numTokens[i + 2] ?? "";
      i += 2;
    }
    stats.set(target, { ins, del });
  }

  const files: GitCommitFile[] = [];
  const nameTokens = nameStatusZ.split("\0");
  for (let i = 0; i < nameTokens.length; i++) {
    const statusToken = nameTokens[i].replace(/^\n+/, "");
    const status = statusToken.charAt(0);
    if (!status || !/^[A-Z]$/.test(status)) continue;
    if (status === "R" || status === "C") {
      const oldPath = nameTokens[i + 1] ?? "";
      const filePath = nameTokens[i + 2] ?? "";
      i += 2;
      const stat = stats.get(filePath) ?? { ins: 0, del: 0 };
      files.push({ status, path: filePath, oldPath, insertions: stat.ins, deletions: stat.del });
    } else {
      const filePath = nameTokens[i + 1] ?? "";
      i += 1;
      const stat = stats.get(filePath) ?? { ins: 0, del: 0 };
      files.push({ status, path: filePath, insertions: stat.ins, deletions: stat.del });
    }
  }
  return files;
}

/** `subcommand` is the git command and its fixed options; `targets` are the revisions after the diff options. */
async function readChangedFiles(cwd: string, subcommand: string[], targets: string[]): Promise<GitCommitFile[]> {
  const run = (mode: string) =>
    execGit(cwd, [...subcommand, "--no-color", "-z", mode, "-M", ...targets], { maxBuffer: 8 * 1024 * 1024 });
  const [nameStatus, numStat] = await Promise.all([run("--name-status"), run("--numstat")]);
  return parseChangedFiles(nameStatus, numStat);
}

/** Files touched by a commit, with rename detection and line stats. */
export async function readCommitFiles(cwd: string, sha: string): Promise<GitCommitFile[]> {
  return readChangedFiles(cwd, ["show", "--format="], [sha]);
}

/** Files changed between two arbitrary commits (`git diff -M a b`). */
export async function readCompareFiles(cwd: string, a: string, b: string): Promise<GitCommitFile[]> {
  return readChangedFiles(cwd, ["diff"], [a, b]);
}

/** Files in a stash entry (`git stash show`). */
export async function readStashFiles(cwd: string, ref: string): Promise<GitCommitFile[]> {
  return readChangedFiles(cwd, ["stash", "show", "--format="], [ref]);
}

/** Content of `<path>` at commit `<sha>`. Returns empty string if missing. */
export async function readBlobAt(cwd: string, sha: string, repoPath: string): Promise<string> {
  try {
    // "INDEX" = the staged version (`git show :path`), for the working-changes diff.
    const spec = sha === "INDEX" ? `:${repoPath}` : `${sha}:${repoPath}`;
    return await execGit(cwd, ["show", spec], { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/** First parent sha of `<sha>`, or empty string for root commits. */
export async function readFirstParent(cwd: string, sha: string): Promise<string> {
  return (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^`]))?.trim() ?? "";
}

export async function readCommitShow(repoRoot: string, sha: string): Promise<string> {
  return execGit(repoRoot, ["show", "--no-color", "--stat", "--patch", "--pretty=fuller", sha], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Combined diff for the Compare patch tab (`git diff --stat -p a b`). */
export async function readCompareShow(repoRoot: string, a: string, b: string): Promise<string> {
  return execGit(repoRoot, ["diff", "--no-color", "--stat", "--patch", "-M", a, b], {
    maxBuffer: 16 * 1024 * 1024,
  });
}
