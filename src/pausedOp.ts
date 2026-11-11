import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "./errors";
import { runGitCommand, runGitNoEditor } from "./gitExec";

/** A git operation that stopped half-way (usually on a conflict) and waits for continue / skip / abort. */
export type PausedKind = "rebase" | "merge" | "cherry-pick" | "revert";
export type PausedStep = "continue" | "skip" | "abort";

export type PausedOp = {
  kind: PausedKind;
  /** What is being applied: the merge message, the picked / reverted commit's subject, the rebased branch. */
  subject: string;
  /** Rebase / sequence progress, e.g. 2 of 5; 0 when unknown. */
  step: number;
  total: number;
  /** Paths with unresolved conflicts (unmerged in the index). */
  conflicted: string[];
};

/** `git merge` has no --skip. */
export function canSkip(kind: PausedKind): boolean {
  return kind !== "merge";
}

/** Absolute path of a file or folder inside the git directory (right for worktrees and submodules). */
async function gitPath(cwd: string, name: string): Promise<string | null> {
  try {
    const rel = (await runGitCommand(cwd, ["rev-parse", "--git-path", name])).trim();
    return rel ? path.resolve(cwd, rel) : null;
  } catch {
    return null;
  }
}

async function exists(cwd: string, name: string): Promise<string | null> {
  const p = await gitPath(cwd, name);
  return p && fs.existsSync(p) ? p : null;
}

function readText(p: string | null): string {
  if (!p) return "";
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) ?? "").trim();
}

function num(s: string): number {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function subjectOf(cwd: string, rev: string): Promise<string> {
  try {
    return (await runGitCommand(cwd, ["log", "-1", "--format=%s", rev, "--"])).trim();
  } catch {
    return "";
  }
}

/** Unmerged paths, NUL-separated so any file name survives. */
export async function readConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await runGitCommand(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    return Array.from(new Set(out.split("\0").filter(Boolean)));
  } catch {
    return [];
  }
}

/** Which operation git sees as in progress, from the same marker files git itself checks. */
export async function readPausedKind(cwd: string): Promise<PausedKind | null> {
  if (await exists(cwd, "rebase-merge")) return "rebase";
  if (await exists(cwd, "rebase-apply")) {
    // `git am` keeps its session in rebase-apply too (marked by "applying"); `git rebase --…` refuses
    // to touch it, so it gets no banner rather than buttons that fail.
    return (await exists(cwd, path.join("rebase-apply", "applying"))) ? null : "rebase";
  }
  if (await exists(cwd, "MERGE_HEAD")) return "merge";
  if (await exists(cwd, "CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await exists(cwd, "REVERT_HEAD")) return "revert";
  // A multi-commit cherry-pick / revert between commits (the conflict was committed by hand): only
  // the sequencer is left, and its todo says which one it is.
  const todo = readText(await exists(cwd, path.join("sequencer", "todo")));
  const word = firstLine(todo).split(/\s+/)[0];
  if (word === "pick" || word === "p") return "cherry-pick";
  if (word === "revert") return "revert";
  return null;
}

/** The paused operation with what the banner shows, or null when nothing is in progress. */
export async function readPausedOp(cwd: string): Promise<PausedOp | null> {
  const kind = await readPausedKind(cwd);
  if (!kind) return null;
  let subject = "";
  let step = 0;
  let total = 0;
  if (kind === "rebase") {
    const merge = await exists(cwd, "rebase-merge");
    const dir = merge ?? (await exists(cwd, "rebase-apply"));
    if (dir) {
      const head = readText(path.join(dir, "head-name")).trim().replace(/^refs\/heads\//, "");
      subject = head === "detached HEAD" ? "" : head;
      step = num(readText(path.join(dir, merge ? "msgnum" : "next")));
      total = num(readText(path.join(dir, merge ? "end" : "last")));
    }
  } else if (kind === "merge") {
    subject = firstLine(readText(await gitPath(cwd, "MERGE_MSG")));
  } else {
    const head = kind === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
    if (await exists(cwd, head)) subject = await subjectOf(cwd, head);
  }
  return { kind, subject, step, total, conflicted: await readConflictedFiles(cwd) };
}

/** Runs one step. Continue never opens an editor: git keeps the message it prepared. */
export async function runPausedGitStep(cwd: string, kind: PausedKind, step: PausedStep): Promise<void> {
  if (step === "skip" && !canSkip(kind)) throw new Error(`git ${kind} has no --skip`);
  const args = [kind, `--${step}`];
  if (step === "continue") await runGitNoEditor(cwd, args);
  else await runGitCommand(cwd, args);
}

/** What a step reports to the panel. */
export type PausedStepMessage =
  | { type: "opDone" }
  | { type: "opError"; message: string }
  | { type: "reloadNow" };

export type PausedStepTexts = {
  /** Continue refused because files still conflict; `{0}` = count. */
  unresolved: (count: number) => string;
  /** The step ran and the same operation is still paused (e.g. the next commit conflicts). */
  stillPaused: string;
};

/**
 * One continue / skip / abort on the operation the banner showed (`kind`). Judged by the state git
 * is left in, not by the exit code: `--continue` exits non-zero when it stops on the next conflict,
 * which is the normal "still paused" case.
 * - nothing (or another operation) in progress → done, reload: the banner was stale;
 * - continue while files still conflict → refused with `unresolved` (git would refuse too, less clearly);
 * - `confirm` (abort, skip) → a "no" changes nothing;
 * - afterwards: gone → done (or git's error if it failed and still left nothing); still paused →
 *   `stillPaused` plus git's detail.
 */
export async function runPausedStep(
  root: string,
  kind: PausedKind,
  step: PausedStep,
  post: (m: PausedStepMessage) => void,
  texts: PausedStepTexts,
  opts: { confirm?: () => Promise<boolean>; run?: typeof runPausedGitStep } = {},
): Promise<void> {
  const before = await readPausedOp(root);
  if (!before || before.kind !== kind) {
    post({ type: "opDone" });
    post({ type: "reloadNow" });
    return;
  }
  if (step === "continue" && before.conflicted.length > 0) {
    post({ type: "opError", message: texts.unresolved(before.conflicted.length) });
    return;
  }
  if (opts.confirm && !(await opts.confirm())) return;
  let failure: string | undefined;
  try {
    await (opts.run ?? runPausedGitStep)(root, kind, step);
  } catch (e: unknown) {
    failure = errorMessage(e);
  }
  const after = await readPausedKind(root);
  if (after !== kind) {
    post(failure === undefined ? { type: "opDone" } : { type: "opError", message: failure });
  } else {
    post({ type: "opError", message: failure ? `${texts.stillPaused}\n${failure}` : texts.stillPaused });
  }
  post({ type: "reloadNow" });
}
