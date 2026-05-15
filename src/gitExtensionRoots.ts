import * as path from "path";
import * as vscode from "vscode";

/** Minimal typing for the built-in `vscode.git` extension API (version 1). */
type GitRepositoryRef = { rootUri: vscode.Uri };
type GitApiV1 = { repositories: GitRepositoryRef[] };
type GitExtensionExports = { getAPI(version: 1): GitApiV1 };

/**
 * Uses the built-in Git extension so we find the same repo GitLens/SCM uses,
 * even when the workspace folder is not the git root.
 */
export async function tryRootFromBuiltInGit(): Promise<string | null> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) {
    return null;
  }
  try {
    if (!ext.isActive) {
      await ext.activate();
    }
    const api = ext.exports?.getAPI?.(1);
    const repos = api?.repositories ?? [];
    if (repos.length === 0) {
      return null;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === "file") {
      const norm = path.normalize(active.fsPath);
      for (const r of repos) {
        const root = path.normalize(r.rootUri.fsPath);
        if (norm === root || norm.startsWith(root + path.sep)) {
          return root;
        }
      }
    }
    return path.normalize(repos[0].rootUri.fsPath);
  } catch {
    return null;
  }
}
