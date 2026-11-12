import * as fs from "fs";
import * as path from "path";
import { runGitC, runGitCommand, runGitWithInput } from "./gitExec";

/**
 * Working-tree writes (1.9.0): what the "Working changes" row shows and does — stage / unstage,
 * commit, amend, stash, discard. Every command takes paths through stdin (`--pathspec-from-file=-
 * --pathspec-file-nul`), so any file name and any number of files work, and a name can never be
 * read as an option. No VS Code here; the panel adds prompts and messages.
 */

export type WorkGroup = "staged" | "unstaged" | "untracked" | "conflicted";
/** One changed path. `status`: A M D R C T U ?; `orig` is a rename's / copy's old path. */
export type WorkFile = { path: string; status: string; orig?: string };
export type WorkFiles = Record<WorkGroup, WorkFile[]>;

/** Reads `git status --porcelain=v2 -z`: one entry per path, a path may be in staged and unstaged. */
export async function readWorkingFiles(cwd: string): Promise<WorkFiles> {
  const out = await runGitCommand(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return parseStatusV2(out);
}

/** Exported for the tests. */
export function parseStatusV2(out: string): WorkFiles {
  const files: WorkFiles = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === "?") {
      files.untracked.push({ path: rec.slice(2), status: "?" });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      files.conflicted.push({ path: field(rec, 10), status: "U" });
    } else if (kind === "1" || kind === "2") {
      // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const xy = rec.slice(2, 4);
      const p = field(rec, kind === "1" ? 8 : 9);
      const orig = kind === "2" ? parts[++i] : undefined;
      if (xy[0] !== ".") files.staged.push({ path: p, status: xy[0], ...(orig ? { orig } : {}) });
      if (xy[1] !== ".") files.unstaged.push({ path: p, status: xy[1] });
    }
  }
  return files;
}

/** The text after the n-th space (paths may contain spaces; they are the last field). */
function field(rec: string, n: number): string {
  let at = 0;
  for (let k = 0; k < n; k++) at = rec.indexOf(" ", at) + 1;
  return rec.slice(at);
}

function pathspecs(paths: string[]): string {
  return paths.map((p) => p + "\0").join("");
}

const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"];
/** Paths are names, never patterns: a file called `*.txt` must not match every .txt file. */
const LITERAL = "--literal-pathspecs";

async function headExists(cwd: string): Promise<boolean> {
  try {
    await runGitCommand(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Stages paths (new, changed and deleted files alike; `-A` so a deletion is staged too). */
export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await runGitWithInput(cwd, [LITERAL, "add", "-A", ...FROM_STDIN, "--"], pathspecs(paths));
}

/**
 * Unstages paths. A staged rename's old path goes with its new one, or its deletion would stay
 * staged on its own. On a branch with no commit yet there is no HEAD: drop them from the index.
 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const wanted = new Set(paths);
  for (const f of (await readWorkingFiles(cwd)).staged) if (f.orig && wanted.has(f.path)) wanted.add(f.orig);
  paths = [...wanted];
  if (await headExists(cwd)) {
    await runGitWithInput(cwd, [LITERAL, "restore", "--staged", ...FROM_STDIN, "--"], pathspecs(paths));
  } else {
    await runGitWithInput(cwd, [LITERAL, "rm", "--cached", "-r", "-q", "--ignore-unmatch", ...FROM_STDIN, "--"], pathspecs(paths));
  }
}

export async function stageAll(cwd: string): Promise<void> {
  await runGitCommand(cwd, ["add", "-A"]);
}

/** The message of HEAD, for "Amend last commit"; "" without a commit. */
export async function lastCommitMessage(cwd: string): Promise<string> {
  try {
    return (await runGitCommand(cwd, ["log", "-1", "--format=%B", "HEAD", "--"])).replace(/\s+$/, "");
  } catch {
    return "";
  }
}

/** True when HEAD is already on a remote-tracking branch: amending it means a force push. */
export async function headIsPushed(cwd: string): Promise<boolean> {
  try {
    return (await runGitCommand(cwd, ["branch", "-r", "--contains", "HEAD"])).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commits what is staged with `message` (kept as typed: `--cleanup=whitespace`, so `#` lines stay).
 * `amend` rewrites HEAD instead (its files plus what is staged). Hooks run as with `git commit`;
 * a failing hook throws with its output. Never opens an editor.
 */
export async function commit(cwd: string, message: string, opts: { amend?: boolean } = {}): Promise<void> {
  const msg = message.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!msg.trim()) throw new Error(EMPTY_MESSAGE);
  const args = ["commit", "--cleanup=whitespace", "-F", "-"];
  if (opts.amend) {
    if (!(await headExists(cwd))) throw new Error(NO_COMMIT_YET);
    args.push("--amend");
  }
  // -F - carries the message, so no editor opens; core.editor=: makes sure of it.
  // A hook or a signing prompt that never returns must not lock the pane: give up after 5 minutes.
  await runGitWithInput(cwd, ["-c", "core.editor=:", ...args], msg + "\n", COMMIT_TIMEOUT_MS);
}

export const EMPTY_MESSAGE = "empty commit message";
const COMMIT_TIMEOUT_MS = 5 * 60_000;

/** The installed git's version as [major, minor], or [0, 0] when unknown. */
export async function gitVersion(cwd: string): Promise<[number, number]> {
  try {
    const m = /(\d+)\.(\d+)/.exec(await runGitCommand(cwd, ["--version"]));
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  } catch {
    return [0, 0];
  }
}

/** `git stash push --staged` needs git 2.35. */
export async function canStashStagedOnly(cwd: string): Promise<boolean> {
  const [a, b] = await gitVersion(cwd);
  return a > 2 || (a === 2 && b >= 35);
}

export type StashOptions = { message?: string; includeUntracked?: boolean; stagedOnly?: boolean };

/** Stashes the working changes. Untracked files are included by default (as Git Graph does). */
export async function stashPush(cwd: string, opts: StashOptions = {}): Promise<void> {
  const args = ["stash", "push"];
  if (opts.stagedOnly) args.push("--staged");
  else if (opts.includeUntracked !== false) args.push("--include-untracked");
  const msg = (opts.message ?? "").replace(/[\r\n]+/g, " ").trim();
  if (msg) args.push("-m", msg);
  // git ends successfully with "No local changes to save" when the choice leaves nothing to stash
  // (e.g. tracked-only with only untracked files): tell it apart by whether a stash was made.
  const before = await stashTop(cwd);
  await runGitCommand(cwd, args);
  if ((await stashTop(cwd)) === before) throw new Error(NOTHING_TO_STASH);
}

export const NOTHING_TO_STASH = "nothing to stash";

async function stashTop(cwd: string): Promise<string> {
  try {
    return (await runGitCommand(cwd, ["rev-parse", "-q", "--verify", "refs/stash"])).trim();
  } catch {
    return "";
  }
}

/** Paths `git clean -fd` would delete (untracked, not ignored), for the confirmation. */
export async function untrackedToClean(cwd: string): Promise<string[]> {
  // `git clean` has no -z; with core.quotePath=false names come as typed, one per line.
  const out = await runGitC(cwd, ["clean", "-n", "-d"]);
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^Would remove /, ""));
}

/** Throws away every change to tracked files (staged and not): back to HEAD. Untracked files stay. */
export async function discardAllTracked(cwd: string): Promise<void> {
  if (!(await headExists(cwd))) throw new Error(NO_COMMIT_YET);
  await runGitCommand(cwd, ["reset", "--hard", "-q", "HEAD"]);
}

export const NO_COMMIT_YET = "no commit yet";

/** Deletes untracked files and folders (ignored files are kept). */
export async function cleanUntracked(cwd: string): Promise<void> {
  await runGitCommand(cwd, ["clean", "-f", "-d", "-q"]);
}

/**
 * What discarding one listed file does — the panel words its confirmation from this:
 * - `restore`: the file goes back (unstaged: to what is staged; staged: to HEAD, index and copy);
 * - `deleteNew`: the file is in no commit (added, or `git add -N`): it leaves the index and its
 *   copy is deleted — its content exists nowhere else, so the confirmation says "delete";
 * - `renameBack`: a staged rename: the old path comes back from HEAD, the new one goes;
 * - `deleteUntracked`: an untracked file is deleted.
 */
export type DiscardPlan =
  | { kind: "restore" | "deleteNew" | "deleteUntracked" }
  | { kind: "renameBack"; orig: string };

export async function planDiscard(cwd: string, file: string, group: WorkGroup): Promise<DiscardPlan | null> {
  if (group === "conflicted") return null;
  const files = await readWorkingFiles(cwd);
  const entry = files[group].find((f) => f.path === file);
  if (!entry) return null;
  if (group === "untracked") return { kind: "deleteUntracked" };
  if (group === "unstaged") return entry.status === "A" ? { kind: "deleteNew" } : { kind: "restore" };
  if (entry.orig && entry.status === "R") return { kind: "renameBack", orig: entry.orig };
  return (await headExists(cwd)) && (await pathInHead(cwd, file)) ? { kind: "restore" } : { kind: "deleteNew" };
}

/** Throws away the changes of one listed file, as {@link planDiscard} describes. */
export async function discardFile(cwd: string, file: string, group: WorkGroup): Promise<void> {
  const plan = await planDiscard(cwd, file, group);
  if (!plan) throw new Error(group === "conflicted" ? "resolve conflicted files in Source Control" : "not listed");
  switch (plan.kind) {
    case "deleteUntracked":
      // `git clean` takes no pathspec file; after "--" the name is never read as an option.
      await runGitCommand(cwd, [LITERAL, "clean", "-f", "-q", "--", file]);
      return;
    case "restore":
      if (group === "unstaged") {
        await runGitWithInput(cwd, [LITERAL, "restore", "--worktree", ...FROM_STDIN, "--"], pathspecs([file]));
      } else {
        await runGitWithInput(cwd, [LITERAL, "restore", "--source=HEAD", "--staged", "--worktree", ...FROM_STDIN, "--"], pathspecs([file]));
      }
      return;
    case "deleteNew":
      await runGitWithInput(cwd, [LITERAL, "rm", "--cached", "-q", "-f", ...FROM_STDIN, "--"], pathspecs([file]));
      removeCopy(cwd, file);
      return;
    case "renameBack":
      await runGitWithInput(cwd, [LITERAL, "rm", "--cached", "-q", "-f", ...FROM_STDIN, "--"], pathspecs([file]));
      await runGitWithInput(cwd, [LITERAL, "restore", "--source=HEAD", "--staged", "--worktree", ...FROM_STDIN, "--"], pathspecs([plan.orig]));
      // A case-only rename (foo → Foo) is one file on macOS / Windows: restoring the old name
      // already put it back — deleting the "new" name would delete that very file.
      if (plan.orig.toLowerCase() !== file.toLowerCase()) removeCopy(cwd, file);
      return;
  }
}

/** Deletes a working copy that is a plain file or a symlink; a folder (a submodule) is left alone. */
function removeCopy(cwd: string, file: string): void {
  const abs = path.join(cwd, file);
  try {
    const st = fs.lstatSync(abs);
    if (st.isFile() || st.isSymbolicLink()) fs.rmSync(abs, { force: true });
  } catch {
    /* already gone */
  }
}

async function pathInHead(cwd: string, file: string): Promise<boolean> {
  try {
    await runGitCommand(cwd, ["cat-file", "-e", `HEAD:${file}`]);
    return true;
  } catch {
    return false;
  }
}
