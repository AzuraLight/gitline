import * as vscode from "vscode";
import { errorMessage } from "./errors";
import { InlineBlame, type CommitTarget } from "./blame/inlineBlame";
import { commitShowUri, registerCommitShowProvider } from "./commitShowProvider";
import { repoRelativePath, resolveRepoRootForFile } from "./gitExec";
import { listRepoRoots } from "./repoPick";
import {
  getActiveRepoRoot,
  registerGitlinePanelWebview,
  revealCommitInPanel,
  revealCommitPanelAndReload,
  revealCommitPanelWithPath,
  runSyncWithProgress,
  saveCurrentViewAsDefault,
  openRepositoryCommand,
  setSelectedRepo,
  hasShownGraph,
  rememberRecent,
  type SyncOp,
  readDisplayPrefs,
  writeColumns,
  maybeSuggestCommitGraph,
} from "./panelWebview";
import type { DisplayPrefs } from "./commitGraphView";
import { handleWorkMessage } from "./workTreePanel";

/** What `activate` returns. Not a public API — the integration tests read it. */
export type GitlineExports = {
  inlineBlameText(): string | undefined;
  /** The repository the panel acts on right now (same lookup the graph uses). */
  activeRepoRoot(): Promise<string | null>;
  /** Every repository the picker lists for the workspace (scans the disk again). */
  workspaceRepos(): Promise<string[]>;
  /** What the picker does when a repository is chosen. */
  selectRepo(root: string): Promise<void>;
  /** True once the panel has shown a graph. */
  hasShownGraph(): boolean;
  /** What "Open Repository…" does after the folder dialog: put a repository on the recent list. */
  addRecentRepo(root: string): Promise<void>;
  /** The display settings the webview receives (raw; the webview validates them). */
  displayPrefs(): DisplayPrefs;
  /** What the graph's column-header menu does: write `gitline.graph.columns`. */
  writeColumns(columns: unknown): Promise<void>;
  /** What the working-changes pane's message does in `root`; confirmations answer `yes`. Returns what was posted back. */
  workMessage(root: string, msg: Record<string, unknown>, yes: boolean): Promise<Array<Record<string, unknown>>>;
  /** What a first graph load of `loadMs` in `root` does about the commit-graph file. Returns what was posted back. */
  suggestCommitGraph(root: string, loadMs: number): Promise<Array<Record<string, unknown>>>;
};

export function activate(context: vscode.ExtensionContext): GitlineExports {
  context.subscriptions.push(registerCommitShowProvider());
  context.subscriptions.push(registerGitlinePanelWebview(context));
  context.subscriptions.push(
    vscode.commands.registerCommand("gitline.saveViewAsDefault", () => saveCurrentViewAsDefault()),
    vscode.commands.registerCommand("gitline.openRepository", () => openRepositoryCommand()),
  );

  const openGraph = vscode.commands.registerCommand("gitline.openCommitGraph", async () => {
    try {
      await revealCommitPanelAndReload();
    } catch (e: unknown) {
      const msg = errorMessage(e);
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
      const rel = repoRelativePath(root, targetUri.fsPath);
      if (rel.startsWith("..") || rel === "") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Gitline: This file is outside the repository."));
        return;
      }
      try {
        await revealCommitPanelWithPath(rel);
      } catch (e: unknown) {
        const msg = errorMessage(e);
        void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: Could not open file history: {0}", msg));
      }
    },
  );

  const runSyncCommand = (op: SyncOp) => async (): Promise<void> => {
    const root = await getActiveRepoRoot();
    if (!root) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Gitline: Could not find a Git repository."));
      return;
    }
    try {
      await runSyncWithProgress(root, op);
      await revealCommitPanelAndReload();
    } catch (e: unknown) {
      const msg = errorMessage(e);
      void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: {0}", msg));
    }
  };

  const pull = vscode.commands.registerCommand("gitline.pull", runSyncCommand("pull"));
  const push = vscode.commands.registerCommand("gitline.push", runSyncCommand("push"));
  const fetchAllCmd = vscode.commands.registerCommand("gitline.fetchAll", runSyncCommand("fetch"));

  context.subscriptions.push(openGraph, openFileHistory, pull, push, fetchAllCmd);
  const blame = registerInlineBlame(context);
  return {
    inlineBlameText: () => blame.lastAnnotation,
    activeRepoRoot: () => getActiveRepoRoot(),
    workspaceRepos: () => listRepoRoots({ force: true }),
    selectRepo: (root: string) => setSelectedRepo(root),
    hasShownGraph: () => hasShownGraph(),
    addRecentRepo: (root: string) => rememberRecent(root),
    displayPrefs: () => readDisplayPrefs(),
    writeColumns: (columns: unknown) => writeColumns(columns),
    workMessage: async (root: string, msg: Record<string, unknown>, yes: boolean) => {
      const posted: Array<Record<string, unknown>> = [];
      await handleWorkMessage(root, msg, (m) => void posted.push(m as Record<string, unknown>), async () => yes);
      return posted;
    },
    suggestCommitGraph: async (root: string, loadMs: number) => {
      const posted: Array<Record<string, unknown>> = [];
      await maybeSuggestCommitGraph({ postMessage: async (m: unknown) => { posted.push(m as Record<string, unknown>); return true; } }, root, loadMs);
      return posted;
    },
  };
}

function isCommitTarget(v: unknown): v is CommitTarget {
  const t = v as CommitTarget | undefined;
  return typeof t?.root === "string" && typeof t?.sha === "string" && /^[0-9a-f]{40}$/.test(t.sha);
}

/** Opt-in inline blame (#2) and the two commands its hover links to. */
function registerInlineBlame(context: vscode.ExtensionContext): InlineBlame {
  const toggle = vscode.commands.registerCommand("gitline.toggleInlineBlame", async () => {
    const config = vscode.workspace.getConfiguration("gitline.inlineBlame");
    const next = !config.get<boolean>("enabled", false);
    await config.update("enabled", next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(
      next ? vscode.l10n.t("Gitline: Inline blame on") : vscode.l10n.t("Gitline: Inline blame off"),
      2500,
    );
  });
  const reveal = vscode.commands.registerCommand("gitline.revealCommit", async (target: unknown) => {
    if (isCommitTarget(target)) await revealCommitInPanel(target.root, target.sha);
  });
  const patch = vscode.commands.registerCommand("gitline.openCommitPatch", async (target: unknown) => {
    if (!isCommitTarget(target)) return;
    const doc = await vscode.workspace.openTextDocument(commitShowUri(target.root, target.sha));
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  const blame = new InlineBlame();
  context.subscriptions.push(blame, toggle, reveal, patch);
  return blame;
}

export function deactivate(): void {}
