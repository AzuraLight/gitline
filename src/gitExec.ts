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
type ExecOptions = { maxBuffer?: number; timeoutMs?: number; input?: string; env?: Record<string, string> };

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

/** Runs `git` with `input` on stdin (e.g. a tag message given as `-F -`). */
export async function runGitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return execGit(cwd, args, { input });
}

/** Runs `git` without ever opening an editor: GIT_EDITOR=":" makes git keep the message it prepared. */
export async function runGitNoEditor(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, { env: { GIT_EDITOR: ":" } });
}

/** Runs `git` for operations that talk to a remote — bounded by {@link NETWORK_TIMEOUT_MS}. */
export async function runGitNetworkCommand(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, { timeoutMs: NETWORK_TIMEOUT_MS });
}

/** Runs `git` and resolves to null instead of throwing — for probes where failure is an answer. */
async function tryGit(cwd: string, args: string[], input?: string): Promise<string | null> {
  try {
    return await execGit(cwd, args, { maxBuffer: 4 * 1024 * 1024, input });
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
  return (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? "";
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
  return { current, locals, remotes };
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
 * Hashes reachable from `rev` but not from HEAD, at most `cap` of them. Undefined for HEAD's own
 * log (nothing to dim) or when it cannot be computed (unborn HEAD) — callers then dim nothing.
 */
export async function readOffHeadHashes(cwd: string, rev: ViewRev | undefined, cap: number): Promise<Set<string> | undefined> {
  // --topo-order matches the graph's order, so at the cap it is the oldest rows that go undimmed.
  // The trailing "--" keeps a file named HEAD (or like a branch) from being read as a path.
  const base = ["rev-list", "--topo-order", `--max-count=${cap}`];
  let out: string | null;
  if (Array.isArray(rev)) {
    if (rev.length === 0) return undefined;
    out = await tryGit(cwd, [...base, "--stdin", "--not", "HEAD", "--"], viewRevInput(rev));
  } else {
    const target = rev?.trim();
    if (!target) return undefined;
    out = await tryGit(cwd, [...base, ...revArgs(target), "--not", "HEAD", "--"]);
  }
  if (out === null) return undefined;
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

export async function readRecentCommits(
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
    if (!target && !headBorn) return [];
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
  const rows = parseCommitRows(await execGit(cwd, logArgs, { input }));

  // A hex query may be a commit hash — `--grep` only searches messages, so look the hash up
  // directly and put that commit first (deduplicated if its message also matched).
  if (q && looksLikeHash(q)) {
    const hash = await resolveCommit(cwd, q);
    if (hash && !rows.some((r) => r.hash === hash)) {
      const hit = parseCommitRows(
        await execGit(cwd, ["log", "--max-count=1", "--decorate=full", `--pretty=format:${COMMIT_FORMAT}`, hash]),
      );
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
    return await execGit(cwd, ["show", `${sha}:${repoPath}`], { maxBuffer: 16 * 1024 * 1024 });
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
