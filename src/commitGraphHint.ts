// 1.10.0: offer to write git's commit-graph file when a large repository has none.
//
// git sorts the whole history before it prints the first graph row (--topo-order); without the
// commit-graph file that walk reads every commit object: 1.2 s per load in a 200k-commit repository
// against 0.13 s with it. A fresh clone has no such file, and `git gc` writes one only now and then.
// As in Visual Studio, Gitline asks first and never writes it on its own.
import * as fs from "fs";
import * as path from "path";
import { runGitAbortable, runGitCommand } from "./gitExec";

/** A first graph load slower than this, with no commit-graph file, is worth the suggestion. */
export const SLOW_LOAD_MS = 500;

/**
 * True when the repository has a commit-graph file — one file or a split chain — or when the user
 * turned commit-graphs off (core.commitGraph=false): either way there is nothing to suggest.
 */
export async function hasCommitGraph(cwd: string): Promise<boolean> {
  const enabled = (await runGitCommand(cwd, ["config", "--type=bool", "--get", "core.commitGraph"]).catch(() => "")).trim();
  if (enabled === "false") return true;
  const objects = (await runGitCommand(cwd, ["rev-parse", "--git-path", "objects"]).catch(() => "")).trim();
  // Unreadable: do not nag about something we could not check.
  if (!objects) return true;
  const dirs = [path.resolve(cwd, objects)];
  // A repository that borrows objects (clone --shared, --reference) also reads the commit-graph
  // of the one it borrows from (1.10.0 review).
  try {
    const alternates = fs.readFileSync(path.join(dirs[0], "info", "alternates"), "utf8");
    for (const line of alternates.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) dirs.push(path.resolve(dirs[0], t));
    }
  } catch {
    // no alternates
  }
  return dirs.some((d) =>
    fs.existsSync(path.join(d, "info", "commit-graph")) ||
    fs.existsSync(path.join(d, "info", "commit-graphs", "commit-graph-chain")));
}

/**
 * Writes the commit-graph for every reachable commit. It only adds an index next to the objects;
 * the history, refs and working tree stay as they are. Without --changed-paths: with it the write
 * took 8–9 times longer (17.7 s against 2 s for 200k commits).
 */
export async function writeCommitGraph(cwd: string, signal: AbortSignal): Promise<void> {
  await runGitAbortable(cwd, ["commit-graph", "write", "--reachable", "--no-progress"], signal);
}

/** Decides when to ask; the state lives with the caller (VS Code's globalState). */
export type HintStore = {
  /** Repositories where the user chose "Don't ask again". */
  dismissed(): string[];
  dismiss(root: string): Thenable<void> | void;
};

/** Asked at most once per repository per session, and never while an answer is pending. */
const askedThisSession = new Set<string>();

/** Test hook. */
export function resetHintSession(): void {
  askedThisSession.clear();
}

/** Whether to ask about `root` after a first load that took `loadMs`. Marks it as asked when yes. */
export async function shouldSuggest(root: string, loadMs: number, enabled: boolean, store: HintStore): Promise<boolean> {
  if (!enabled || loadMs < SLOW_LOAD_MS) return false;
  if (askedThisSession.has(root) || store.dismissed().includes(root)) return false;
  askedThisSession.add(root);
  if (await hasCommitGraph(root)) return false;
  return true;
}
