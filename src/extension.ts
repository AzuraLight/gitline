import * as path from "path";
import * as vscode from "vscode";
import { registerCommitShowProvider } from "./commitShowProvider";
import { resolveRepoRootForFile } from "./gitExec";
import { registerGitlinePanelWebview, revealCommitPanelAndReload, revealCommitPanelWithPath } from "./panelWebview";

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedFile = path.resolve(filePath);
  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/");
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(registerCommitShowProvider());
  context.subscriptions.push(registerGitlinePanelWebview(context));

  const openGraph = vscode.commands.registerCommand("gitline.openCommitGraph", async () => {
    try {
      await revealCommitPanelAndReload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: Could not open the commit panel: {0}", msg));
    }
  });

  const openFileHistory = vscode.commands.registerCommand(
    "gitline.openFileHistory",
    async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || targetUri.scheme !== "file") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Gitline: No file selected."));
        return;
      }
      const root = await resolveRepoRootForFile(targetUri.fsPath);
      if (!root) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Gitline: Could not find a Git repository."));
        return;
      }
      const rel = toRepoRelativePath(root, targetUri.fsPath);
      if (rel.startsWith("..") || rel === "") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Gitline: This file is outside the repository."));
        return;
      }
      try {
        await revealCommitPanelWithPath(rel);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: Could not open file history: {0}", msg));
      }
    },
  );

  context.subscriptions.push(openGraph, openFileHistory);
}

export function deactivate(): void {}
