import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { revExists, runGitCommand } from "./gitExec";

const execFileAsync = promisify(execFile);

export type RebaseAction = "pick" | "reword" | "drop" | "squash" | "fixup";
/** `message` is the new commit message for `reword` (ignored otherwise). */
export type RebaseTodoItem = { sha: string; subject: string; action: RebaseAction; message?: string };
/** `message` is the full original message (subject and body), for the reword editor. */
export type RebaseRowPreview = { sha: string; subject: string; message: string };

/**
 * The rebase base the webview asks for is `<picked>^`. When `<picked>` is the root commit that
 * parent does not exist, so the rebase must use `--root` instead. Returns null for that case.
 */
export async function resolveRebaseBase(cwd: string, base: string): Promise<string | null> {
  if (await revExists(cwd, base)) {
    return base;
  }
  if (base.endsWith("^") && (await revExists(cwd, base.slice(0, -1)))) {
    return null;
  }
  throw new Error(`Unknown revision: ${base}`);
}

/** Commits between `base` (exclusive) and HEAD, oldest first — same order git uses for rebase-todo. `null` = from the root. */
export async function readRebaseCommits(cwd: string, base: string | null): Promise<RebaseRowPreview[]> {
  // Unit / record separators: a message may hold tabs and newlines, never these.
  const out = await runGitCommand(cwd, [
    // --no-merges: `git rebase -i` leaves merge commits out of its todo (it linearizes) — list the same.
    "log", "--reverse", "--no-merges", "--format=%H%x1f%s%x1f%B%x1e", base === null ? "HEAD" : `${base}..HEAD`,
  ]);
  const rows: RebaseRowPreview[] = [];
  for (const rec of out.split("\x1e")) {
    const [sha = "", subject = "", message = ""] = rec.replace(/^\s+/, "").split("\x1f");
    if (!sha) continue;
    rows.push({ sha, subject, message: message.replace(/\s+$/, "") });
  }
  return rows;
}

/**
 * True when a rebase is already in progress for this repo. Resolves the rebase
 * state directories via `git rev-parse --git-path` so it stays correct for
 * worktrees and submodules, where `.git` is a file rather than a directory.
 */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    try {
      const rel = (await runGitCommand(cwd, ["rev-parse", "--git-path", name])).trim();
      if (rel && fs.existsSync(path.resolve(cwd, rel))) {
        return true;
      }
    } catch {
      /* ignore — fall through to next marker */
    }
  }
  return false;
}

/** Single-quotes for the POSIX shell git runs `exec` lines with (also Git for Windows' sh). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeMessage(m: string): string {
  return m.replace(/\r\n?/g, "\n").replace(/\s+$/, "").replace(/^\s*\n/, "");
}

/**
 * The todo git runs. A reword with a changed message becomes `pick` plus an `exec` that amends just
 * that commit's message: git's own `reword` would open an editor we cannot tell apart from other
 * steps, while an `exec` line carries its message with it — also when the rebase stops on a conflict
 * first and is continued later. The message goes to `git commit -F -` through printf, one argument
 * per line, so quotes, `#`, leading dashes and non-ASCII text reach git as typed. A reword whose
 * message is unchanged is a plain pick. Text after the hash is a comment to git; newlines are
 * removed from it so a subject can never start a todo line of its own.
 */
export function buildRebaseTodo(items: RebaseTodoItem[], originals: Record<string, string> = {}): string {
  const lines: string[] = [];
  for (const it of items) {
    const subject = it.subject.replace(/[\r\n]+/g, " ");
    const msg = typeof it.message === "string" ? normalizeMessage(it.message) : "";
    const changed = it.action === "reword" && msg && msg !== normalizeMessage(originals[it.sha] ?? "");
    if (it.action === "reword") {
      lines.push(`pick ${it.sha} ${subject}`);
      if (changed) {
        const args = msg.split("\n").map(shQuote).join(" ");
        // --no-verify: hooks already ran when the commit was made; a failing pre-commit / commit-msg
        // hook here would stop the rebase on a step that, with git's defaults, is not run again.
        lines.push(`exec printf '%s\\n' ${args} | git commit --amend --only --allow-empty --no-verify --cleanup=whitespace -F -`);
      }
    } else {
      lines.push(`${it.action} ${it.sha} ${subject}`);
    }
  }
  const todo = lines.join("\n") + "\n";
  // Git for Windows runs each exec line through sh -c, bounded by the ~32K command-line limit.
  if (lines.some((l) => l.length > MAX_EXEC_LINE)) throw new Error(REWORD_TOO_LONG);
  return todo;
}

const MAX_EXEC_LINE = 30000;
/** Thrown by buildRebaseTodo; the panel shows its own wording for it. */
export const REWORD_TOO_LONG = "reword message too long";

function quoteForSequenceEditor(p: string): string {
  // GIT_SEQUENCE_EDITOR is run through the shell. Single-quote on POSIX, double-quote on Windows.
  if (process.platform === "win32") {
    return `"${p.replace(/"/g, '""')}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `git rebase -i base` with our pre-built todo, by setting GIT_SEQUENCE_EDITOR
 * to a tiny Node script that overwrites the todo file git hands it.
 */
export async function runInteractiveRebase(
  cwd: string,
  base: string | null,
  items: RebaseTodoItem[],
): Promise<void> {
  // Reworded commits' current messages: an unchanged one stays a plain pick.
  const originals: Record<string, string> = {};
  for (const it of items) {
    if (it.action === "reword" && !(it.sha in originals)) {
      originals[it.sha] = await runGitCommand(cwd, ["log", "-1", "--format=%B", it.sha, "--"]);
    }
  }
  const todoContent = buildRebaseTodo(items, originals);

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = os.tmpdir();
  const todoPath = path.join(tmpDir, `gitline-rebase-${id}.todo`);
  const scriptPath = path.join(tmpDir, `gitline-rebase-${id}.js`);

  fs.writeFileSync(todoPath, todoContent, "utf8");
  fs.writeFileSync(
    scriptPath,
    `require('fs').copyFileSync(${JSON.stringify(todoPath)}, process.argv[2]);\n`,
    "utf8",
  );

  const editorCmd = `${quoteForSequenceEditor(process.execPath)} ${quoteForSequenceEditor(scriptPath)}`;
  const cleanup = withNoopCommitEditor();

  try {
    // --reschedule-failed-exec: a reword step that fails (e.g. a lock) runs again on Continue
    // instead of being dropped silently.
    await execFileAsync("git", ["rebase", "-i", "--reschedule-failed-exec", ...(base === null ? ["--root"] : [base])], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      // GIT_SEQUENCE_EDITOR rewrites the todo; GIT_EDITOR accepts the default
      // (combined) commit message for any squash/fixup/reword step instead of
      // blocking on a real editor that has no TTY here.
      env: { ...process.env, GIT_SEQUENCE_EDITOR: editorCmd, GIT_EDITOR: cleanup.editorCmd },
    });
  } finally {
    cleanup.dispose();
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(todoPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * A GIT_EDITOR that exits 0 without touching the file git hands it, so git uses
 * whatever default content it prepared (e.g. the combined squash message). The
 * caller must `dispose()` to remove the temp script.
 */
function withNoopCommitEditor(): { editorCmd: string; dispose: () => void } {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = path.join(os.tmpdir(), `gitline-noop-editor-${id}.js`);
  fs.writeFileSync(scriptPath, "process.exit(0);\n", "utf8");
  return {
    editorCmd: `${quoteForSequenceEditor(process.execPath)} ${quoteForSequenceEditor(scriptPath)}`,
    dispose: () => {
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
    },
  };
}
