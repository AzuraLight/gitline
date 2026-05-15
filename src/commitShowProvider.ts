import * as vscode from "vscode";
import { readBlobAt, readCommitShow } from "./gitExec";

export function commitShowUri(repoRoot: string, sha: string): vscode.Uri {
  const short = sha.slice(0, 7);
  return vscode.Uri.from({
    scheme: "gitline",
    path: `/${short}.patch`,
    query: new URLSearchParams({ kind: "show", root: repoRoot, sha }).toString(),
  });
}

/**
 * URI that resolves to the content of `<repoPath>` at `<sha>`.
 * `sha` may be empty to represent "no file" (used as the left side for added files
 * or the right side for deleted files in diff views).
 */
export function commitFileUri(repoRoot: string, sha: string, repoPath: string): vscode.Uri {
  const short = sha ? sha.slice(0, 7) : "empty";
  // Path includes basename so VS Code picks the correct language for syntax highlighting.
  const base = repoPath.split("/").pop() || "file";
  return vscode.Uri.from({
    scheme: "gitline",
    path: `/${short}/${base}`,
    query: new URLSearchParams({ kind: "file", root: repoRoot, sha, path: repoPath }).toString(),
  });
}

export function registerCommitShowProvider(): vscode.Disposable {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const q = new URLSearchParams(uri.query);
      const kind = q.get("kind") ?? "show";
      const root = q.get("root");
      if (!root) {
        return vscode.l10n.t("// Gitline: invalid URI");
      }
      if (kind === "file") {
        const sha = q.get("sha") ?? "";
        const path = q.get("path") ?? "";
        if (!sha || !path) {
          return "";
        }
        return readBlobAt(root, sha, path);
      }
      const sha = q.get("sha");
      if (!sha) {
        return vscode.l10n.t("// Gitline: invalid commit URI");
      }
      try {
        return await readCommitShow(root, sha);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return vscode.l10n.t("// Gitline: git show failed\n// {0}", msg);
      }
    },
  };
  return vscode.workspace.registerTextDocumentContentProvider("gitline", provider);
}
