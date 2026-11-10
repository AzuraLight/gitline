import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { listRootsFromBuiltInGit, tryRootFromBuiltInGit } from "./gitExtensionRoots";
import { getRepoRoot, resolveRepoRootForFile } from "./gitExec";
import { DEFAULT_SCAN, scanRepositoriesDetailed, type ScanOptions } from "./repoScan";

function pickCwd(uri?: vscode.Uri): string | undefined {
  if (uri && uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    return path.dirname(uri.fsPath);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    return path.dirname(editor.document.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolves Git repo root: built-in Git extension, then cwd / folders / editors. */
export async function pickCommitGraphRepoRoot(): Promise<string | null> {
  const fromBuiltIn = await tryRootFromBuiltInGit();
  if (fromBuiltIn) {
    return fromBuiltIn;
  }

  const seen = new Set<string>();
  const tryDir = async (dir: string | undefined): Promise<string | null> => {
    if (!dir) {
      return null;
    }
    const key = path.resolve(dir);
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    return getRepoRoot(dir);
  };

  const fromCwd = await tryDir(pickCwd());
  if (fromCwd) {
    return fromCwd;
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const r = await tryDir(folder.uri.fsPath);
    if (r) {
      return r;
    }
  }

  if (vscode.window.activeTextEditor?.document.uri.scheme === "file") {
    const fromFile = await resolveRepoRootForFile(vscode.window.activeTextEditor.document.uri.fsPath);
    if (fromFile) {
      return fromFile;
    }
  }

  let n = 0;
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== "file") {
      continue;
    }
    if (n++ > 20) {
      break;
    }
    const r = await resolveRepoRootForFile(doc.uri.fsPath);
    if (r) {
      return r;
    }
  }

  return null;
}

/**
 * All Git repo roots available in the current window, for the multi-repo picker.
 * Merges the built-in Git extension's repositories with each workspace folder
 * resolved to its Git root, then dedups (normalized) and sorts.
 */
/** Scan results per (folders, depth, ignored) — refreshed on demand (picker opened, settings or folders changed). */
let scanCache: { key: string; roots: string[] } | null = null;
/** A scan in progress, shared by everyone who asks meanwhile (a graph refresh and the picker together). */
let scanInFlight: { key: string; promise: Promise<string[]> } | null = null;
/** The last full list, reused for a moment: one graph request asks for it more than once. */
let listMemo: { at: number; promise: Promise<string[]> } | null = null;
const LIST_MEMO_MS = 1500;

/** Drops the stored scan, so the next list scans the disk again. */
export function invalidateRepoScan(): void {
  scanCache = null;
  listMemo = null;
}

function scanOptionsFromSettings(): ScanOptions {
  const c = vscode.workspace.getConfiguration("gitline.repositories");
  const ignored = c.get<unknown>("ignoredFolders");
  return {
    depth: c.get<number>("searchDepth", DEFAULT_SCAN.depth),
    ignored: Array.isArray(ignored) ? ignored.filter((x): x is string => typeof x === "string") : DEFAULT_SCAN.ignored,
  };
}

async function scannedRoots(force: boolean): Promise<string[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  const opts = scanOptionsFromSettings();
  const key = JSON.stringify([folders, opts]);
  if (!force && scanCache?.key === key) {
    // A repository deleted since the scan must not linger until the next one.
    return scanCache.roots.filter((r) => fs.existsSync(path.join(r, ".git")));
  }
  if (scanInFlight?.key === key) return scanInFlight.promise;
  const promise = scanRepositoriesDetailed(folders, opts).then((res) => {
    if (res.truncated) {
      console.warn(`[gitline] repository scan stopped at its folder limit; lower gitline.repositories.searchDepth or add ignoredFolders`);
    }
    scanCache = { key, roots: res.roots };
    return res.roots;
  });
  scanInFlight = { key, promise };
  try {
    return await promise;
  } finally {
    if (scanInFlight?.promise === promise) scanInFlight = null;
  }
}

/** The same folder can arrive as /var/… and /private/var/…, C:/x and c:\\x, or in another letter case. */
export function repoIdentity(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whether two paths are the same repository folder (see repoIdentity). */
export function sameRepo(a: string, b: string): boolean {
  return repoIdentity(a) === repoIdentity(b);
}

/**
 * Every repository in the workspace: what the built-in Git extension knows, what a scan of the
 * workspace folders finds (`gitline.repositories.searchDepth` levels down — the Git extension only
 * looks one level down, and only when it is loaded), and the repository each folder is inside.
 * `force` re-scans the disk instead of using the last scan.
 */
export function listRepoRoots(opts: { force?: boolean } = {}): Promise<string[]> {
  let promise: Promise<string[]>;
  if (!opts.force && listMemo && Date.now() - listMemo.at < LIST_MEMO_MS) {
    promise = listMemo.promise;
  } else {
    promise = computeRepoRoots(!!opts.force);
    listMemo = { at: Date.now(), promise };
    promise.catch(() => {
      if (listMemo?.promise === promise) listMemo = null;
    });
  }
  // Whatever the source (a reused list, a stored scan, the Git extension that has not noticed yet),
  // a repository whose .git is gone is not offered.
  return promise.then((list) => list.filter((r) => fs.existsSync(path.join(r, ".git"))));
}

async function computeRepoRoots(force: boolean): Promise<string[]> {
  const byIdentity = new Map<string, string>();
  const add = (p: string | null | undefined): void => {
    if (!p) return;
    const id = repoIdentity(p);
    if (!byIdentity.has(id)) byIdentity.set(id, path.resolve(p));
  };

  for (const r of await listRootsFromBuiltInGit()) add(r);
  for (const r of await scannedRoots(force)) add(r);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    add(await getRepoRoot(folder.uri.fsPath));
  }

  return [...byIdentity.values()].sort((a, b) => a.localeCompare(b));
}
