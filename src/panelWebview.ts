import * as vscode from "vscode";
import { buildCommitGraphShellHtml } from "./commitGraphView";
import { commitFileUri, commitShowUri } from "./commitShowProvider";
import {
  readBranchTreePayload,
  readCommitFiles,
  readCurrentBranchName,
  readFirstParent,
  readRecentCommits,
  readStashes,
  readWorkingState,
  runGitCommand,
} from "./gitExec";
import {
  createBranchFrom,
  createTagAt,
  isBranchActionId,
  isCommitActionId,
  isStashActionId,
  renameBranch,
  runBranchAction,
  runCommitAction,
  runStashAction,
  type BranchActionId,
  type CommitActionId,
  type StashActionId,
} from "./gitPanelActions";
import { getCommitGraphWebviewUi, getWebviewHtmlLang } from "./nls";
import { pickCommitGraphRepoRoot } from "./repoPick";

let panelViewRef: vscode.WebviewView | undefined;

async function openCommitPreview(sha: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(commitShowUri(root, sha));
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
}

async function confirm(message: string, destructive = false): Promise<boolean> {
  const yes = vscode.l10n.t("Confirm");
  const no = vscode.l10n.t("Cancel");
  const fn = destructive ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  const pick = await fn(message, { modal: true }, yes, no);
  return pick === yes;
}

async function reportAndReload(
  webview: vscode.Webview,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
    webview.postMessage({ type: "reloadNow" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: {0}", msg));
  }
}

async function dispatchCommitAction(
  webview: vscode.Webview,
  action: CommitActionId,
  hash: string,
): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const short = hash.slice(0, 7);
  const prompts: Record<CommitActionId, { msg: string; destructive: boolean }> = {
    "checkout-detached": { msg: vscode.l10n.t("Checkout detached at {0}?", short), destructive: false },
    "merge-commit": { msg: vscode.l10n.t("Merge {0} into the current branch?", short), destructive: false },
    "rebase-onto": { msg: vscode.l10n.t("Rebase the current branch onto {0}?", short), destructive: false },
    "cherry-pick": { msg: vscode.l10n.t("Cherry-pick {0}?", short), destructive: false },
    "revert": { msg: vscode.l10n.t("Create a revert commit for {0}?", short), destructive: false },
    "reset-soft": { msg: vscode.l10n.t("Move branch tip to {0} (soft)?", short), destructive: false },
    "reset-mixed": { msg: vscode.l10n.t("Move branch tip to {0} (mixed)?", short), destructive: false },
    "reset-hard": {
      msg: vscode.l10n.t("HARD reset to {0}? Discards local commits and changes after that point.", short),
      destructive: true,
    },
  };
  const p = prompts[action];
  if (!(await confirm(p.msg, p.destructive))) return;
  await reportAndReload(webview, () => runCommitAction(root, action, hash));
}

async function dispatchBranchAction(
  webview: vscode.Webview,
  action: BranchActionId,
  branch: string,
): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const prompts: Record<BranchActionId, { msg: string; destructive: boolean }> = {
    "branch-checkout": { msg: vscode.l10n.t("Checkout {0}?", branch), destructive: false },
    "branch-checkout-remote": {
      msg: vscode.l10n.t("Create local branch tracking {0}?", branch),
      destructive: false,
    },
    "branch-delete": { msg: vscode.l10n.t("Delete branch {0}?", branch), destructive: true },
    "branch-delete-force": {
      msg: vscode.l10n.t("Force delete branch {0}? Unmerged commits will be lost.", branch),
      destructive: true,
    },
    "branch-delete-remote": {
      msg: vscode.l10n.t("Delete REMOTE branch {0}? This pushes a delete.", branch),
      destructive: true,
    },
    "branch-fetch": { msg: vscode.l10n.t("Fetch {0}?", branch), destructive: false },
    "branch-push": { msg: vscode.l10n.t("Push {0} to origin?", branch), destructive: false },
    "branch-merge-into-current": {
      msg: vscode.l10n.t("Merge {0} into the current branch?", branch),
      destructive: false,
    },
    "branch-rebase-current-onto": {
      msg: vscode.l10n.t("Rebase current branch onto {0}?", branch),
      destructive: false,
    },
  };
  const p = prompts[action];
  if (!(await confirm(p.msg, p.destructive))) return;
  await reportAndReload(webview, () => runBranchAction(root, action, branch));
}

async function dispatchStashAction(
  webview: vscode.Webview,
  action: StashActionId,
  ref: string,
): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const prompts: Record<StashActionId, { msg: string; destructive: boolean }> = {
    "stash-apply": { msg: vscode.l10n.t("Apply {0} to the working tree?", ref), destructive: false },
    "stash-pop": {
      msg: vscode.l10n.t("Pop {0} (apply and drop)?", ref),
      destructive: true,
    },
    "stash-drop": { msg: vscode.l10n.t("Drop {0}? Cannot be undone.", ref), destructive: true },
  };
  const p = prompts[action];
  if (!(await confirm(p.msg, p.destructive))) return;
  await reportAndReload(webview, () => runStashAction(root, action, ref));
}

async function promptCreateBranch(webview: vscode.Webview, refspec: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name (at {0})", refspec.slice(0, 7)),
    validateInput: (v) => (/^[^\s~^:?*\\]+$/.test(v) ? undefined : vscode.l10n.t("Invalid branch name")),
  });
  if (!name) return;
  await reportAndReload(webview, () => createBranchFrom(root, name, refspec));
}

async function promptCreateTag(webview: vscode.Webview, refspec: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Tag name (at {0})", refspec.slice(0, 7)),
    validateInput: (v) => (/^[^\s~^:?*\\]+$/.test(v) ? undefined : vscode.l10n.t("Invalid tag name")),
  });
  if (!name) return;
  await reportAndReload(webview, () => createTagAt(root, name, refspec));
}

async function promptRenameBranch(webview: vscode.Webview, branch: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const next = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Rename {0} to…", branch),
    value: branch,
    validateInput: (v) => (/^[^\s~^:?*\\]+$/.test(v) ? undefined : vscode.l10n.t("Invalid branch name")),
  });
  if (!next || next === branch) return;
  await reportAndReload(webview, () => renameBranch(root, branch, next));
}

async function copyToClipboard(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(vscode.l10n.t("Copied to clipboard"), 1500);
}

async function sendGraphPayload(
  webview: vscode.Webview,
  limit: number,
  rev?: string,
  pathFilter?: string,
  query?: string,
): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) {
    webview.postMessage({
      type: "graphError",
      code: "no-repo",
      message: vscode.l10n.t("Gitline: Could not find a Git repository."),
    });
    return;
  }
  try {
    const capped = Math.min(500, Math.max(1, limit));
    const trimmed = typeof rev === "string" ? rev.trim() : "";
    const logRev = trimmed.length > 0 ? trimmed : undefined;
    const pf = typeof pathFilter === "string" && pathFilter.trim().length > 0 ? pathFilter.trim() : undefined;
    const q = typeof query === "string" && query.trim().length > 0 ? query.trim() : undefined;
    const branch = await readCurrentBranchName(root);
    const [commits, branchTree, working, stashes] = await Promise.all([
      readRecentCommits(root, capped, logRev, pf, q),
      readBranchTreePayload(root),
      readWorkingState(root).catch(() => ({ staged: 0, modified: 0, untracked: 0, conflicted: 0 })),
      readStashes(root).catch(() => []),
    ]);
    webview.postMessage({
      type: "graphPayload",
      payload: {
        repoRoot: root,
        branch,
        viewRev: logRev ?? "",
        pathFilter: pf ?? "",
        query: q ?? "",
        branchTree,
        commits,
        working,
        stashes,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: "graphError", code: "git", message: msg });
  }
}

async function sendStashFiles(webview: vscode.Webview, ref: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  try {
    // git stash show works like git show for the named stash.
    const [nameStatus, numStat] = await Promise.all([
      runGitCommand(root, ["stash", "show", "--no-color", "--format=", "--name-status", "-M", ref]),
      runGitCommand(root, ["stash", "show", "--no-color", "--format=", "--numstat", "-M", ref]),
    ]);
    const stats = new Map<string, { ins: number; del: number }>();
    for (const line of numStat.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const cols = s.split("\t");
      if (cols.length < 3) continue;
      const ins = cols[0] === "-" ? 0 : Number(cols[0]) || 0;
      const del = cols[1] === "-" ? 0 : Number(cols[1]) || 0;
      stats.set(cols[cols.length - 1], { ins, del });
    }
    const files: Array<{
      status: string;
      path: string;
      oldPath?: string;
      insertions: number;
      deletions: number;
    }> = [];
    for (const line of nameStatus.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const cols = s.split("\t");
      const status = cols[0]?.[0] ?? "";
      if (!status) continue;
      if ((status === "R" || status === "C") && cols.length >= 3) {
        const oldPath = cols[1];
        const p = cols[2];
        const st = stats.get(p) ?? { ins: 0, del: 0 };
        files.push({ status, path: p, oldPath, insertions: st.ins, deletions: st.del });
      } else if (cols.length >= 2) {
        const p = cols[1];
        const st = stats.get(p) ?? { ins: 0, del: 0 };
        files.push({ status, path: p, insertions: st.ins, deletions: st.del });
      }
    }
    webview.postMessage({ type: "stashFiles", ref, files });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: "stashFilesError", ref, message: msg });
  }
}

async function openStashFileDiff(ref: string, filePath: string, oldPath: string | undefined): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) return;
  const before = oldPath || filePath;
  const leftUri = commitFileUri(root, `${ref}^1`, before);
  const rightUri = commitFileUri(root, ref, filePath);
  const title = vscode.l10n.t("{0} ({1})", filePath, ref);
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
    preview: true,
    preserveFocus: true,
  });
}

async function sendCommitFiles(webview: vscode.Webview, hash: string): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) {
    return;
  }
  try {
    const files = await readCommitFiles(root, hash);
    webview.postMessage({ type: "commitFiles", hash, files });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: "commitFilesError", hash, message: msg });
  }
}

async function openCommitFileDiff(
  hash: string,
  filePath: string,
  status: string,
  oldPath: string | undefined,
): Promise<void> {
  const root = await pickCommitGraphRepoRoot();
  if (!root) {
    return;
  }
  const parent = await readFirstParent(root, hash);
  const short = hash.slice(0, 7);
  const title =
    status === "R" && oldPath
      ? vscode.l10n.t("{0} → {1} ({2})", oldPath, filePath, short)
      : vscode.l10n.t("{0} ({1})", filePath, short);
  // For Added (A): left side empty, right is current commit.
  // For Deleted (D): left is parent, right empty.
  // For Renamed (R): left = parent at oldPath, right = current at new path.
  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  if (status === "A") {
    leftUri = commitFileUri(root, "", filePath);
    rightUri = commitFileUri(root, hash, filePath);
  } else if (status === "D") {
    leftUri = commitFileUri(root, parent, filePath);
    rightUri = commitFileUri(root, "", filePath);
  } else if (status === "R" && oldPath) {
    leftUri = commitFileUri(root, parent, oldPath);
    rightUri = commitFileUri(root, hash, filePath);
  } else {
    leftUri = commitFileUri(root, parent, filePath);
    rightUri = commitFileUri(root, hash, filePath);
  }
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
    preview: true,
    preserveFocus: true,
  });
}

/** Tells the webview to load history filtered to `relativePath`. */
export async function revealCommitPanelWithPath(relativePath: string): Promise<void> {
  await revealCommitPanelAndReload();
  if (panelViewRef) {
    panelViewRef.webview.postMessage({ type: "setPathFilter", path: relativePath });
  }
}

/** Focuses the bottom commit panel and asks the webview to reload graph data. */
export async function revealCommitPanelAndReload(): Promise<void> {
  if (panelViewRef) {
    panelViewRef.show(true);
    panelViewRef.webview.postMessage({ type: "reloadNow" });
    return;
  }
  const tryIds = ["gitline.panel.focus", "workbench.view.extension.gitlinePanel"];
  for (const id of tryIds) {
    try {
      await vscode.commands.executeCommand(id);
      break;
    } catch {
      // Try next id (varies by VS Code / Cursor build).
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  if (panelViewRef) {
    (panelViewRef as vscode.WebviewView).show(true);
    (panelViewRef as vscode.WebviewView).webview.postMessage({ type: "reloadNow" });
  }
}

export function registerGitlinePanelWebview(context: vscode.ExtensionContext): vscode.Disposable {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
      panelViewRef = webviewView;
      const { webview } = webviewView;
      webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      };
      const ui = getCommitGraphWebviewUi();
      const htmlLang = getWebviewHtmlLang();
      webview.html = buildCommitGraphShellHtml(webview, context.extensionUri, ui, htmlLang);

      webview.onDidReceiveMessage(
        (msg: {
          type?: string;
          limit?: number;
          hash?: string;
          rev?: string;
          action?: string;
          pathFilter?: string;
          query?: string;
          path?: string;
          oldPath?: string;
          status?: string;
          branch?: string;
          text?: string;
        }) => {
          if (msg?.type === "requestGraph") {
            const lim = typeof msg.limit === "number" ? msg.limit : 200;
            const r = typeof msg.rev === "string" ? msg.rev : undefined;
            const pf = typeof msg.pathFilter === "string" ? msg.pathFilter : undefined;
            const q = typeof msg.query === "string" ? msg.query : undefined;
            void sendGraphPayload(webview, lim, r, pf, q);
            return;
          }
          if (msg?.type === "requestCommitFiles" && typeof msg.hash === "string") {
            void sendCommitFiles(webview, msg.hash);
            return;
          }
          if (msg?.type === "requestStashFiles" && typeof msg.hash === "string") {
            void sendStashFiles(webview, msg.hash);
            return;
          }
          if (
            msg?.type === "openStashFileDiff" &&
            typeof msg.hash === "string" &&
            typeof msg.path === "string"
          ) {
            void openStashFileDiff(msg.hash, msg.path, msg.oldPath);
            return;
          }
          if (msg?.type === "focusScm") {
            void vscode.commands.executeCommand("workbench.view.scm");
            return;
          }
          if (
            msg?.type === "openFileDiff" &&
            typeof msg.hash === "string" &&
            typeof msg.path === "string" &&
            typeof msg.status === "string"
          ) {
            void openCommitFileDiff(msg.hash, msg.path, msg.status, msg.oldPath);
            return;
          }
          if (msg?.type === "openCommitPatch" && typeof msg.hash === "string") {
            void openCommitPreview(msg.hash);
            return;
          }
          if (msg?.type === "previewCommit" && typeof msg.hash === "string") {
            // Reserved for legacy callers; the preview pane now shows files instead.
            return;
          }
          if (
            msg?.type === "commitAction" &&
            typeof msg.hash === "string" &&
            typeof msg.action === "string" &&
            isCommitActionId(msg.action)
          ) {
            void dispatchCommitAction(webview, msg.action, msg.hash);
            return;
          }
          if (
            msg?.type === "branchAction" &&
            typeof msg.branch === "string" &&
            typeof msg.action === "string" &&
            isBranchActionId(msg.action)
          ) {
            void dispatchBranchAction(webview, msg.action, msg.branch);
            return;
          }
          if (
            msg?.type === "stashAction" &&
            typeof msg.hash === "string" &&
            typeof msg.action === "string" &&
            isStashActionId(msg.action)
          ) {
            void dispatchStashAction(webview, msg.action, msg.hash);
            return;
          }
          if (msg?.type === "createBranchAt" && typeof msg.hash === "string") {
            void promptCreateBranch(webview, msg.hash);
            return;
          }
          if (msg?.type === "createTagAt" && typeof msg.hash === "string") {
            void promptCreateTag(webview, msg.hash);
            return;
          }
          if (msg?.type === "renameBranch" && typeof msg.branch === "string") {
            void promptRenameBranch(webview, msg.branch);
            return;
          }
          if (msg?.type === "copyText" && typeof msg.text === "string") {
            void copyToClipboard(msg.text);
            return;
          }
        },
      );

      // Auto-reload when refs change on disk (commit/checkout/merge/reset/fetch).
      const refsWatcher = vscode.workspace.createFileSystemWatcher(
        "**/.git/{HEAD,refs/**,packed-refs,FETCH_HEAD,index}",
      );
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleReload = (): void => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (panelViewRef === webviewView) {
            webview.postMessage({ type: "reloadNow" });
          }
        }, 250);
      };
      refsWatcher.onDidChange(scheduleReload);
      refsWatcher.onDidCreate(scheduleReload);
      refsWatcher.onDidDelete(scheduleReload);

      webviewView.onDidDispose(() => {
        refsWatcher.dispose();
        if (reloadTimer) clearTimeout(reloadTimer);
        if (panelViewRef === webviewView) {
          panelViewRef = undefined;
        }
      });
    },
  };
  return vscode.window.registerWebviewViewProvider("gitline.panel", provider, {
    webviewOptions: { retainContextWhenHidden: true },
  });
}
