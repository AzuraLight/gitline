import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { runGitCommand } from "./gitExec";

const execFileAsync = promisify(execFile);

export type RebaseAction = "pick" | "drop" | "squash" | "fixup";
export type RebaseTodoItem = { sha: string; subject: string; action: RebaseAction };
export type RebaseRowPreview = { sha: string; subject: string };

/** Commits between `base` (exclusive) and HEAD, oldest first — same order git uses for rebase-todo. */
export async function readRebaseCommits(cwd: string, base: string): Promise<RebaseRowPreview[]> {
  const out = await runGitCommand(cwd, ["log", "--reverse", "--format=%H%x09%s", `${base}..HEAD`]);
  const rows: RebaseRowPreview[] = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const tab = s.indexOf("\t");
    if (tab < 0) {
      rows.push({ sha: s, subject: "" });
    } else {
      rows.push({ sha: s.slice(0, tab), subject: s.slice(tab + 1) });
    }
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
  base: string,
  items: RebaseTodoItem[],
): Promise<void> {
  const lines: string[] = [];
  for (const it of items) {
    if (it.action === "drop") {
      lines.push(`drop ${it.sha} ${it.subject}`);
    } else {
      lines.push(`${it.action} ${it.sha} ${it.subject}`);
    }
  }
  const todoContent = lines.join("\n") + "\n";

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
    await execFileAsync("git", ["rebase", "-i", base], {
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

/** Continues a paused rebase after the user resolved conflicts in the SCM view. */
export async function continueRebase(cwd: string): Promise<void> {
  const cleanup = withNoopCommitEditor();
  try {
    await execFileAsync("git", ["rebase", "--continue"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: cleanup.editorCmd },
    });
  } finally {
    cleanup.dispose();
  }
}

/** Skips the current commit of a paused rebase. */
export async function skipRebase(cwd: string): Promise<void> {
  await runGitCommand(cwd, ["rebase", "--skip"]);
}

export async function abortRebase(cwd: string): Promise<void> {
  await runGitCommand(cwd, ["rebase", "--abort"]);
}
