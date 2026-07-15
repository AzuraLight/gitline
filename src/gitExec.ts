import * as path from "path";
import { execFile } from "child_process";
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

const execFileAsync = promisify(execFile);

/** Runs `git` with explicit argv (no shell). cwd must be the repository root. */
export async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, 10 * 1024 * 1024);
}

async function execGit(cwd: string, args: string[], maxBuffer: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer,
      encoding: "utf8",
    });
    return typeof stdout === "string" ? stdout : String(stdout);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
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

function splitRecord(block: string): string[] {
  return block.split("\x1e");
}

/**
 * Returns true if `rev` resolves to a commit in this repo. Used to gracefully
 * fall back to the default log when a selected branch/rev no longer exists
 * (deleted/renamed remote branch, or a typo) instead of failing the whole view.
 */
export async function revExists(cwd: string, rev: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
      cwd,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    const root = (typeof stdout === "string" ? stdout : String(stdout)).trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
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
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const b = (typeof stdout === "string" ? stdout : String(stdout)).trim();
    return b.length > 0 ? b : "";
  } catch {
    return "";
  }
}

/**
 * Upstream tracking state of the current branch. Returns `upstream: null` when
 * the branch has no upstream (or HEAD is detached); ahead/behind default to 0.
 */
export async function readSyncState(cwd: string): Promise<GitSyncState> {
  let upstream: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd, maxBuffer: 1024 * 1024, encoding: "utf8" },
    );
    const u = (typeof stdout === "string" ? stdout : String(stdout)).trim();
    upstream = u.length > 0 ? u : null;
  } catch {
    return { upstream: null, ahead: 0, behind: 0 };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { cwd, maxBuffer: 1024 * 1024, encoding: "utf8" },
    );
    const parts = (typeof stdout === "string" ? stdout : String(stdout)).trim().split(/\s+/);
    const ahead = Number(parts[0]) || 0;
    const behind = Number(parts[1]) || 0;
    return { upstream, ahead, behind };
  } catch {
    return { upstream, ahead: 0, behind: 0 };
  }
}

/** Local + remote branch names for a SourceTree-style sidebar. */
export async function readBranchTreePayload(cwd: string): Promise<GitBranchTreePayload> {
  const current = await readCurrentBranchName(cwd);
  const locals: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/heads/"],
      { cwd, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    );
    for (const line of (typeof stdout === "string" ? stdout : String(stdout)).split(/\r?\n/)) {
      const s = line.trim();
      if (s && s !== "HEAD") {
        locals.push(s);
      }
    }
  } catch {
    /* ignore */
  }
  const remoteMap = new Map<string, Set<string>>();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/remotes/"],
      { cwd, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    );
    for (const line of (typeof stdout === "string" ? stdout : String(stdout)).split(/\r?\n/)) {
      const s = line.trim();
      if (!s) {
        continue;
      }
      const i = s.indexOf("/");
      if (i <= 0) {
        continue;
      }
      const remote = s.slice(0, i);
      const branch = s.slice(i + 1);
      if (branch === "HEAD") {
        continue;
      }
      if (!remoteMap.has(remote)) {
        remoteMap.set(remote, new Set());
      }
      remoteMap.get(remote)!.add(s);
    }
  } catch {
    /* ignore */
  }
  const remotes = [...remoteMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, set]) => ({ remote, branches: [...set].sort() }));
  return { current, locals, remotes };
}

const COMMIT_RECORD_SEP = "\x1f";

function parseDecorate(decorate: string): GitCommitRef[] {
  const out: GitCommitRef[] = [];
  const raw = decorate.trim();
  if (!raw) {
    return out;
  }
  for (const piece of raw.split(",")) {
    const item = piece.trim();
    if (!item) {
      continue;
    }
    // "HEAD -> main" → emit HEAD + the branch
    const arrow = item.match(/^HEAD\s*->\s*(.+)$/);
    if (arrow) {
      out.push({ label: arrow[1].trim(), kind: "head" });
      continue;
    }
    if (item === "HEAD") {
      out.push({ label: "HEAD", kind: "head" });
      continue;
    }
    if (item.startsWith("tag: ")) {
      out.push({ label: item.slice(5).trim(), kind: "tag" });
      continue;
    }
    if (item.includes("/")) {
      out.push({ label: item, kind: "remote" });
      continue;
    }
    out.push({ label: item, kind: "local" });
  }
  return out;
}

export type MergesMode = "all" | "hide" | "only";

export async function readRecentCommits(
  cwd: string,
  limit: number,
  rev?: string,
  pathFilter?: string,
  query?: string,
  mergesMode?: MergesMode,
): Promise<GitCommitRow[]> {
  const format = ["%H", "%P", "%s", "%an", "%ct", "%D"].join("%x1e") + "%x1f";
  const target = rev?.trim();
  const logArgs = ["log"];
  if (target && target.length > 0) {
    logArgs.push(target);
  }
  logArgs.push(`--max-count=${limit}`, `--pretty=format:${format}`, "--topo-order");
  if (mergesMode === "hide") {
    logArgs.push("--no-merges");
  } else if (mergesMode === "only") {
    logArgs.push("--merges");
  }

  const q = query?.trim();
  if (q && q.length > 0) {
    // @author syntax → author filter
    if (q.startsWith("@") && q.length > 1) {
      logArgs.push(`--author=${q.slice(1)}`, "--regexp-ignore-case");
    } else if (/^[0-9a-f]{4,40}$/i.test(q)) {
      // SHA prefix: --grep on hash via --regexp-ignore-case + --all so it scans full history; cheap enough.
      logArgs.push(`--grep=${q}`, "--regexp-ignore-case");
    } else {
      logArgs.push(`--grep=${q}`, "--regexp-ignore-case");
    }
  }

  const pf = pathFilter?.trim();
  if (pf && pf.length > 0) {
    logArgs.push("--follow", "--", pf);
  }
  const { stdout } = await execFileAsync("git", logArgs, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  const out = typeof stdout === "string" ? stdout : String(stdout);
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

/** Counts of working tree changes by category. */
export async function readWorkingState(cwd: string): Promise<GitWorkingState> {
  const out = await execGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"], 8 * 1024 * 1024);
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
  let out = "";
  try {
    out = await execGit(cwd, ["stash", "list", `--format=${fmt}`], 4 * 1024 * 1024);
  } catch {
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

/** Files touched by a commit, with rename detection and line stats. */
export async function readCommitFiles(cwd: string, sha: string): Promise<GitCommitFile[]> {
  // name-status gives status letters + rename info; numstat gives insertions/deletions.
  // We run both and join on the target path.
  const [nameStatus, numStat] = await Promise.all([
    execGit(cwd, ["show", "--no-color", "--format=", "--name-status", "-M", sha], 8 * 1024 * 1024),
    execGit(cwd, ["show", "--no-color", "--format=", "--numstat", "-M", sha], 8 * 1024 * 1024),
  ]);
  const stats = new Map<string, { ins: number; del: number }>();
  for (const line of numStat.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const cols = s.split("\t");
    if (cols.length < 3) continue;
    const ins = cols[0] === "-" ? 0 : Number(cols[0]) || 0;
    const del = cols[1] === "-" ? 0 : Number(cols[1]) || 0;
    // For renames, numstat path is `old => new` or `{old => new}`; use the final path heuristically.
    const path = cols[cols.length - 1];
    stats.set(path, { ins, del });
  }
  const files: GitCommitFile[] = [];
  for (const line of nameStatus.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const cols = s.split("\t");
    const status = cols[0]?.[0] ?? "";
    if (!status) continue;
    if ((status === "R" || status === "C") && cols.length >= 3) {
      const oldPath = cols[1];
      const path = cols[2];
      const stat = stats.get(path) ?? { ins: 0, del: 0 };
      files.push({ status, path, oldPath, insertions: stat.ins, deletions: stat.del });
    } else if (cols.length >= 2) {
      const path = cols[1];
      const stat = stats.get(path) ?? { ins: 0, del: 0 };
      files.push({ status, path, insertions: stat.ins, deletions: stat.del });
    }
  }
  return files;
}

/** Content of `<path>` at commit `<sha>`. Returns empty string if missing. */
export async function readBlobAt(cwd: string, sha: string, repoPath: string): Promise<string> {
  try {
    return await execGit(cwd, ["show", `${sha}:${repoPath}`], 16 * 1024 * 1024);
  } catch {
    return "";
  }
}

/** First parent sha of `<sha>`, or empty string for root commits. */
export async function readFirstParent(cwd: string, sha: string): Promise<string> {
  try {
    const out = await execGit(cwd, ["rev-parse", `${sha}^`], 1024 * 1024);
    return out.trim();
  } catch {
    return "";
  }
}

export async function readCommitShow(repoRoot: string, sha: string): Promise<string> {
  return execGit(
    repoRoot,
    ["show", "--no-color", "--stat", "--patch", "--pretty=fuller", sha],
    16 * 1024 * 1024,
  );
}

/** Files changed between two arbitrary commits (`git diff -M a b`). */
export async function readCompareFiles(cwd: string, a: string, b: string): Promise<GitCommitFile[]> {
  const [nameStatus, numStat] = await Promise.all([
    execGit(cwd, ["diff", "--no-color", "--name-status", "-M", a, b], 8 * 1024 * 1024),
    execGit(cwd, ["diff", "--no-color", "--numstat", "-M", a, b], 8 * 1024 * 1024),
  ]);
  const stats = new Map<string, { ins: number; del: number }>();
  for (const line of numStat.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const cols = s.split("\t");
    if (cols.length < 3) continue;
    const ins = cols[0] === "-" ? 0 : Number(cols[0]) || 0;
    const del = cols[1] === "-" ? 0 : Number(cols[1]) || 0;
    stats.set(cols[cols.length - 1], { ins, del });
  }
  const files: GitCommitFile[] = [];
  for (const line of nameStatus.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const cols = s.split("\t");
    const status = cols[0]?.[0] ?? "";
    if (!status) continue;
    if ((status === "R" || status === "C") && cols.length >= 3) {
      const oldPath = cols[1];
      const p = cols[2];
      const stat = stats.get(p) ?? { ins: 0, del: 0 };
      files.push({ status, path: p, oldPath, insertions: stat.ins, deletions: stat.del });
    } else if (cols.length >= 2) {
      const p = cols[1];
      const stat = stats.get(p) ?? { ins: 0, del: 0 };
      files.push({ status, path: p, insertions: stat.ins, deletions: stat.del });
    }
  }
  return files;
}

/** Combined diff for the Compare patch tab (`git diff --stat -p a b`). */
export async function readCompareShow(repoRoot: string, a: string, b: string): Promise<string> {
  return execGit(
    repoRoot,
    ["diff", "--no-color", "--stat", "--patch", "-M", a, b],
    16 * 1024 * 1024,
  );
}
