// Finding Git repositories under the workspace folders, and the "recent repositories" list.
// No vscode import: plain fs, so the rules are unit-tested against real temp folders.
import * as fs from "fs";
import * as path from "path";

export type ScanOptions = {
  /** Folder levels below each root to look into: 0 = the root only, 2 = root/a/b. */
  depth: number;
  /** Folder names never entered (like VS Code's git.repositoryScanIgnoredFolders). */
  ignored: string[];
  /** Stop after visiting this many folders in total, so a huge tree cannot stall the panel. */
  maxDirs?: number;
};

export const DEFAULT_SCAN: Required<ScanOptions> = { depth: 2, ignored: ["node_modules"], maxDirs: 5000 };

/**
 * A folder is a repository when it holds `.git` — a directory, a file (worktree, submodule), or a
 * symbolic link to one of those (git follows it; a dangling link is no repository).
 */
async function hasDotGit(dir: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** Whether a directory entry is a real folder to walk into. Links are never entered. */
async function isWalkableDir(dir: string, e: fs.Dirent): Promise<boolean> {
  if (e.isSymbolicLink()) return false;
  if (e.isDirectory()) return true;
  if (e.isFile()) return false;
  // Some network file systems report no type: ask, without following links.
  try {
    return (await fs.promises.lstat(path.join(dir, e.name))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repositories at or below each root, breadth-first to `depth` levels. Hidden folders (".x"),
 * ignored names and symbolic links are not entered — links could loop or leave the workspace.
 * Repositories are entered too, so submodules and nested clones are found. Sorted, no duplicates.
 */
export async function scanRepositories(roots: string[], opts: ScanOptions): Promise<string[]> {
  return (await scanRepositoriesDetailed(roots, opts)).roots;
}

/** As scanRepositories, and whether the folder budget cut the scan short. */
export async function scanRepositoriesDetailed(
  roots: string[],
  opts: ScanOptions,
): Promise<{ roots: string[]; truncated: boolean }> {
  const depth = Math.max(0, Math.min(8, Math.floor(Number.isFinite(opts.depth) ? opts.depth : DEFAULT_SCAN.depth)));
  const ignored = new Set(opts.ignored ?? DEFAULT_SCAN.ignored);
  const maxDirs = opts.maxDirs ?? DEFAULT_SCAN.maxDirs;
  const found = new Set<string>();
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;
  let queue: string[] = roots.map((r) => path.resolve(r));
  for (let level = 0; level <= depth && queue.length && visited < maxDirs; level++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (visited >= maxDirs) {
        truncated = true;
        break;
      }
      if (seen.has(dir)) continue;
      seen.add(dir);
      visited++;
      if (await hasDotGit(dir)) found.add(dir);
      if (level === depth) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable: skip, never fail the whole scan
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || ignored.has(e.name)) continue;
        if (!(await isWalkableDir(dir, e))) continue;
        next.push(path.join(dir, e.name));
      }
    }
    queue = next;
  }
  if (queue.length && visited >= maxDirs) truncated = true;
  return { roots: [...found].sort((a, b) => a.localeCompare(b)), truncated };
}

/** Most recent first, at most this many. */
export const MAX_RECENT = 10;

/** `root` moved to the front of the recent list (added if new), capped. */
export function pushRecent(list: readonly string[], root: string, max = MAX_RECENT): string[] {
  const key = path.resolve(root);
  return [key, ...list.filter((p) => path.resolve(p) !== key)].slice(0, max);
}

/** Untrusted stored value → a clean recent list (strings only, resolved, no duplicates, capped). */
export function normalizeRecent(stored: unknown, max = MAX_RECENT): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(stored) ? stored : []) {
    if (typeof v !== "string" || !v.trim()) continue;
    const p = path.resolve(v);
    if (!out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** The recent entries that are still repositories on disk (a moved or deleted folder drops out). */
export async function existingRecent(list: readonly string[]): Promise<string[]> {
  const keep: string[] = [];
  for (const p of list) if (await hasDotGit(p)) keep.push(p);
  return keep;
}

/**
 * How a repository is labelled in the picker: its folder name, plus where it sits relative to the
 * workspace folder that contains it ("research" for research/json-editor) — or, outside the
 * workspace, its parent directory — so two clones with the same name can be told apart.
 */
export function repoLabel(root: string, workspaceRoots: readonly string[]): { name: string; detail: string } {
  const abs = path.resolve(root);
  const name = path.basename(abs) || abs;
  for (const w of workspaceRoots) {
    const base = path.resolve(w);
    const rel = path.relative(base, abs);
    if (rel === "") return { name, detail: "" };
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const parent = path.dirname(rel);
      return { name, detail: parent === "." ? path.basename(base) : path.join(path.basename(base), parent) };
    }
  }
  return { name, detail: path.dirname(abs) };
}
