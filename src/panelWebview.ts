import * as path from "path";
import * as vscode from "vscode";
import { errorMessage } from "./errors";
import { buildCommitGraphShellHtml, type DisplayPrefs } from "./commitGraphView";
import { commitFileUri, commitShowUri, compareShowUri } from "./commitShowProvider";
import {
  readBranchTreePayload,
  readCommitFiles,
  readCompareFiles,
  readCurrentBranchName,
  getRepoRoot,
  readFirstParent,
  readRecentCommits,
  readOffHeadHashes,
  resolveRefSelection,
  ALL_REFS,
  type ViewRev,
  readStashes,
  readStashFiles,
  readSyncState,
  readWorkingState,
  revExists,
  type MergesMode,
} from "./gitExec";
import { classifyRevs, defaultViewForRevs, normalizeRevs, revsForDefaultView } from "./viewSelection";
import {
  createBranchFrom,
  createTagAt,
  fetchAll,
  isBranchActionId,
  isCommitActionId,
  isStashActionId,
  isValidRefName,
  pullCurrent,
  pushCurrent,
  renameBranch,
  runBranchAction,
  runCommitAction,
  runStashAction,
  type BranchActionId,
  type CommitActionId,
  type StashActionId,
} from "./gitPanelActions";
import { getCommitGraphWebviewUi, getWebviewHtmlLang } from "./nls";
import {
  abortRebase,
  continueRebase,
  isRebaseInProgress,
  runRebaseStep,
  readRebaseCommits,
  resolveRebaseBase,
  runInteractiveRebase,
  skipRebase,
  type RebaseAction,
  type RebaseTodoItem,
} from "./rebaseRun";
import { invalidateRepoScan, listRepoRoots, pickCommitGraphRepoRoot, sameRepo } from "./repoPick";
import { existingRecent, normalizeRecent, pushRecent, repoLabel } from "./repoScan";

let panelViewRef: vscode.WebviewView | undefined;
let extContext: vscode.ExtensionContext | undefined;

const SELECTED_REPO_KEY = "gitline.selectedRepo";
const FILE_VIEW_KEY = "gitline.fileView";

function readFileViewPref(): "list" | "tree" {
  return extContext?.workspaceState.get<string>(FILE_VIEW_KEY) === "tree" ? "tree" : "list";
}
/** Upper bound for one graph request — the webview pages up to this in steps as you scroll. */
const MAX_GRAPH_COMMITS = 5000;
/** Most commits looked up as "not on HEAD"; beyond that, older off-HEAD commits are just not dimmed. */
const OFF_HEAD_CAP = 20000;

/**
 * The selection the latest graph reply showed — what "Save Current View as Default" stores. Null
 * until the panel has loaded once. A branch that no longer exists is not in it (the view fell back).
 */
let shownRevs: string[] | null = null;

/** The repository of the graph currently on screen (set with each graph reply). */
let shownRoot: string | null = null;

/** Webview messages that change a repository: they must run where the graph on screen points. */
const WRITE_MESSAGES = new Set([
  "runSync", "commitAction", "branchAction", "stashAction", "createBranchAt", "createTagAt", "renameBranch",
  "requestRebaseCommits", "applyRebase", "abortRebase", "continueRebase", "skipRebase",
]);

/**
 * True when the repository Gitline would act on is the one the graph shows. Otherwise (the picked
 * repository was deleted, the recent list cleared, the active editor moved to another repository)
 * nothing runs: the graph reloads with the current repository and the user is told to try again.
 */
async function shownRepoIsActive(webview: vscode.Webview): Promise<boolean> {
  const active = await getActiveRepoRoot();
  if (!shownRoot || !active || sameRepo(active, shownRoot)) return true;
  void webview.postMessage({ type: "reloadNow" });
  void vscode.window.showWarningMessage(
    vscode.l10n.t("The repository changed since the graph was drawn — now showing {0}. Please try again.", path.basename(active)),
  );
  return false;
}

/** Whether the panel has shown a graph yet (integration tests wait on this instead of retrying a save). */
export function hasShownGraph(): boolean {
  return shownRevs !== null;
}
/** Numbers graph requests so only the newest reply updates shownRevs (replies can finish out of order). */
let graphRequestSeq = 0;

const GRAPH_CONFIG = "gitline.graph";

function configuredDefaultRevs(): string[] {
  const config = vscode.workspace.getConfiguration(GRAPH_CONFIG);
  return revsForDefaultView(config.get("defaultView"), config.get("defaultBranches"));
}

/** Display settings (columns, dates, details location, tint) as the webview reads them. */
export function readDisplayPrefs(): DisplayPrefs {
  const c = vscode.workspace.getConfiguration(GRAPH_CONFIG);
  return {
    columns: c.get("columns"),
    dateFormat: c.get("dateFormat"),
    detailsLocation: c.get("detailsLocation"),
    highlightCurrentBranch: c.get("highlightCurrentBranch"),
  };
}

const DISPLAY_KEYS = ["columns", "dateFormat", "detailsLocation", "highlightCurrentBranch"];

/** Display settings changed: the open panel restyles at once, without reading git again. */
function applyDisplayConfigChange(ev: vscode.ConfigurationChangeEvent): void {
  if (!panelViewRef || !DISPLAY_KEYS.some((k) => ev.affectsConfiguration(`${GRAPH_CONFIG}.${k}`))) return;
  void panelViewRef.webview.postMessage({ type: "displayPrefs", display: readDisplayPrefs() });
}

/**
 * The column menu in the graph header writes `gitline.graph.columns` where it is set now (workspace
 * when the workspace has a value, otherwise user settings), so the change is not shadowed.
 */
export async function writeColumns(value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const columns = { author: v.author !== false, date: v.date !== false, sha: v.sha !== false };
  const allShown = columns.author && columns.date && columns.sha;
  const config = vscode.workspace.getConfiguration(GRAPH_CONFIG);
  const inspected = config.inspect("columns");
  const target = inspected?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  // Everything shown again is the default: remove the entry instead of writing it out.
  await config.update("columns", allShown && target === vscode.ConfigurationTarget.Global ? undefined : columns, target);
}

/** The default view in effect when the settings were last looked at; a change must differ from it. */
let lastDefaultKey = "";
/** True while our own save writes the settings, so its intermediate states are not applied. */
let savingDefault = false;

/**
 * The selection a newly created panel opens with, or null to keep what the webview restored from
 * its own state. Only a `defaultView` the user actually set (at any level) overrides it, so people
 * who never touch the setting keep the old behaviour: the last view comes back after a restart.
 */
function readConfiguredOpeningRevs(): string[] | null {
  const config = vscode.workspace.getConfiguration(GRAPH_CONFIG);
  const inspected = config.inspect<string>("defaultView");
  const set =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined;
  if (!set) return null;
  return configuredDefaultRevs();
}

/** Writes the panel's current view as the default: workspace settings when a folder is open. */
export async function saveCurrentViewAsDefault(): Promise<void> {
  if (shownRevs === null) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Open the Gitline panel and pick a view first, then save it as the default."),
    );
    return;
  }
  const saved = shownRevs;
  const { view, branches } = defaultViewForRevs(saved);
  const config = vscode.workspace.getConfiguration(GRAPH_CONFIG);
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  // Two writes: the change listener must not apply the half-written state in between. The branch
  // list goes first and is left in place for "current" / "all", so switching back to "selected"
  // later still has the user's list.
  savingDefault = true;
  try {
    if (branches) await config.update("defaultBranches", branches, target);
    await config.update("defaultView", view, target);
  } finally {
    savingDefault = false;
    lastDefaultKey = JSON.stringify(configuredDefaultRevs());
  }
  // A higher-precedence value (e.g. workspace settings when saving to user settings) wins over
  // what was written; say so instead of claiming success.
  if (JSON.stringify(configuredDefaultRevs()) !== JSON.stringify(saved)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Saved, but another gitline.graph setting overrides it. Check your workspace settings."),
    );
    return;
  }
  const where =
    target === vscode.ConfigurationTarget.Workspace
      ? vscode.l10n.t("workspace settings")
      : vscode.l10n.t("user settings");
  const what =
    view === "current"
      ? vscode.l10n.t("the current branch")
      : view === "all"
        ? vscode.l10n.t("all branches")
        : branches!.join(", ");
  void vscode.window.showInformationMessage(
    vscode.l10n.t("Gitline will open with {0} ({1}).", what, where),
  );
}

/**
 * Settings changed while the panel is open: switch to the new default view — but only when the
 * default in effect really changed (an edit hidden by a higher-precedence value changes nothing),
 * not while our own save is half-written, and not when it is already on screen.
 */
function applyGraphConfigChange(ev: vscode.ConfigurationChangeEvent): void {
  if (!ev.affectsConfiguration(GRAPH_CONFIG) || savingDefault) return;
  const revs = configuredDefaultRevs();
  const key = JSON.stringify(revs);
  if (key === lastDefaultKey) return;
  lastDefaultKey = key;
  if (!panelViewRef || key === JSON.stringify(shownRevs)) return;
  void panelViewRef.webview.postMessage({ type: "applyView", revs });
}

/**
 * The repo the panel should act on: the user's picked repo when it is still
 * present in the current window, otherwise the auto-detected default. All
 * backend handlers resolve through here so the multi-repo picker is honored.
 */
export async function getActiveRepoRoot(): Promise<string | null> {
  const stored = extContext?.workspaceState.get<string>(SELECTED_REPO_KEY);
  if (stored) {
    const { all } = await listAllRepos();
    const hit = all.find((r) => sameRepo(r, stored));
    if (hit) {
      return hit;
    }
    // The picked repository is gone (deleted, moved, its recent entry cleared): forget it, so the
    // panel does not keep pointing at a folder that is not there.
    await extContext?.workspaceState.update(SELECTED_REPO_KEY, undefined);
  }
  return pickCommitGraphRepoRoot();
}

/** The picker's choice (also used by the integration tests). Ignored unless the repository is listed. */
export async function setSelectedRepo(root: string): Promise<void> {
  const { all, workspace } = await listAllRepos();
  const target = all.find((r) => sameRepo(r, root));
  if (!target) {
    return;
  }
  await extContext?.workspaceState.update(SELECTED_REPO_KEY, target);
  // Picking a repository from outside the workspace keeps it near the top of the recent list.
  if (!workspace.some((w) => sameRepo(w, target))) await rememberRecent(target);
}

// ---- Recent repositories (opened from outside the workspace) ------------------------------------

/**
 * Global, not per workspace: "recent" means across windows, as in Fork / GitKraken. One list per
 * remote kind (local, ssh-remote, wsl, …), so a path opened on one machine is not offered on another
 * where the same path may be a different repository — or none.
 */
function recentReposKey(): string {
  return vscode.env.remoteName ? `gitline.recentRepos:${vscode.env.remoteName}` : "gitline.recentRepos";
}

async function readRecent(): Promise<string[]> {
  const existing = await existingRecent(normalizeRecent(extContext?.globalState.get(recentReposKey())));
  // The same folder stored twice in different spellings (case, /private/var) shows once.
  return existing.filter((p, i) => existing.findIndex((q) => sameRepo(p, q)) === i);
}

export async function rememberRecent(root: string): Promise<void> {
  const list = normalizeRecent(extContext?.globalState.get(recentReposKey()));
  await extContext?.globalState.update(recentReposKey(), pushRecent(list, root));
}

/** Workspace repositories, recent ones not already among them, and both together. */
async function listAllRepos(force = false): Promise<{ workspace: string[]; recent: string[]; all: string[] }> {
  const workspace = await listRepoRoots({ force });
  const recent = (await readRecent()).filter((r) => !workspace.some((w) => sameRepo(w, r)));
  return { workspace, recent, all: [...workspace, ...recent] };
}

type RepoItem = { path: string; name: string; detail: string; group: "workspace" | "recent" };

/** What the picker shows for each repository: name, where it is, and which section it belongs to. */
async function repoItems(force = false): Promise<RepoItem[]> {
  const { workspace, recent } = await listAllRepos(force);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const item = (p: string, group: RepoItem["group"]): RepoItem => ({ path: p, group, ...repoLabel(p, folders) });
  return [...workspace.map((p) => item(p, "workspace")), ...recent.map((p) => item(p, "recent"))];
}

async function sendRepoList(webview: vscode.Webview, force: boolean): Promise<void> {
  const items = await repoItems(force);
  const selected = await getActiveRepoRoot();
  void webview.postMessage({ type: "repoList", items, selectedRepo: selected ?? "" });
}

/**
 * "Gitline: Open Repository…": pick any folder (on the remote side in a remote window), make sure
 * it is a Git repository, remember it as recent and show it.
 */
export async function openRepositoryCommand(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: vscode.l10n.t("Open Repository"),
    title: vscode.l10n.t("Gitline: Open Repository"),
  });
  const folder = picked?.[0];
  if (!folder) return;
  const top = await getRepoRoot(folder.fsPath);
  if (!top) {
    void vscode.window.showWarningMessage(vscode.l10n.t("“{0}” is not inside a Git repository.", folder.fsPath));
    return;
  }
  const root = path.resolve(top);
  await rememberRecent(root);
  await extContext?.workspaceState.update(SELECTED_REPO_KEY, root);
  await revealCommitPanelAndReload();
}

async function openCommitPreview(sha: string): Promise<void> {
  const root = await getActiveRepoRoot();
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
    const msg = errorMessage(e);
    void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: {0}", msg));
  }
}

async function dispatchCommitAction(
  webview: vscode.Webview,
  action: CommitActionId,
  hash: string,
): Promise<void> {
  const root = await getActiveRepoRoot();
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
  const root = await getActiveRepoRoot();
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
    "branch-push": { msg: vscode.l10n.t("Push {0} to its remote?", branch), destructive: false },
    "branch-push-force": {
      msg: vscode.l10n.t("Force-push {0} (with lease)? Overwrites the remote branch.", branch),
      destructive: true,
    },
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
  const root = await getActiveRepoRoot();
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

export type SyncOp = "pull" | "push" | "fetch";

/** Runs pull / push / fetch with a cancellable-looking progress notice — they can take a while on slow remotes. */
export async function runSyncWithProgress(root: string, op: SyncOp): Promise<void> {
  const titles: Record<SyncOp, string> = {
    pull: vscode.l10n.t("Gitline: Pulling…"),
    push: vscode.l10n.t("Gitline: Pushing…"),
    fetch: vscode.l10n.t("Gitline: Fetching…"),
  };
  const run = op === "pull" ? pullCurrent : op === "push" ? pushCurrent : fetchAll;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: titles[op] },
    () => run(root),
  );
}

async function dispatchSyncOp(webview: vscode.Webview, op: SyncOp): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  await reportAndReload(webview, () => runSyncWithProgress(root, op));
}

async function selectRepoAndReload(webview: vscode.Webview, root: string): Promise<void> {
  await setSelectedRepo(root);
  webview.postMessage({ type: "reloadNow" });
}

async function promptCreateBranch(webview: vscode.Webview, refspec: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name (at {0})", refspec.slice(0, 7)),
    validateInput: (v) => (isValidRefName(v) ? undefined : vscode.l10n.t("Invalid branch name")),
  });
  if (!name) return;
  await reportAndReload(webview, () => createBranchFrom(root, name, refspec));
}

async function promptCreateTag(webview: vscode.Webview, refspec: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Tag name (at {0})", refspec.slice(0, 7)),
    validateInput: (v) => (isValidRefName(v) ? undefined : vscode.l10n.t("Invalid tag name")),
  });
  if (!name) return;
  await reportAndReload(webview, () => createTagAt(root, name, refspec));
}

async function promptRenameBranch(webview: vscode.Webview, branch: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  const next = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Rename {0} to…", branch),
    value: branch,
    validateInput: (v) => (isValidRefName(v) ? undefined : vscode.l10n.t("Invalid branch name")),
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
  revs: string[],
  pathFilter?: string,
  query?: string,
  mergesMode?: MergesMode,
): Promise<void> {
  const seq = ++graphRequestSeq;
  const root = await getActiveRepoRoot();
  if (!root) {
    webview.postMessage({
      type: "graphError",
      code: "no-repo",
      message: vscode.l10n.t("Gitline: Could not find a Git repository."),
    });
    return;
  }
  try {
    const capped = Math.min(MAX_GRAPH_COMMITS, Math.max(1, limit));
    // If the selection no longer resolves, fall back to the default log and tell the webview so it
    // can surface a notice — rather than failing the whole view with git's "unknown revision".
    // - one clicked branch that was deleted/renamed: the stale selection is dropped (dropSelection);
    // - a list / pattern that matches nothing in *this* repo (e.g. after switching repos): the
    //   selection is kept, so switching back shows it again. In a list, entries that match nothing
    //   are skipped quietly.
    const sel = classifyRevs(revs);
    let logRev: ViewRev | undefined;
    let viewRefs: string[] = [];
    let revMissing: string | undefined;
    let dropSelection = false;
    if (sel.kind === "all") {
      logRev = ALL_REFS;
    } else if (sel.kind === "single") {
      if (await revExists(root, sel.rev)) logRev = sel.rev;
      else {
        revMissing = sel.rev;
        dropSelection = true;
      }
    } else if (sel.kind === "list") {
      const { refs, missing } = await resolveRefSelection(root, sel.revs);
      if (refs.length > 0) {
        logRev = refs;
        viewRefs = refs; // full names: the sidebar must tell branch "x" from tag "x"
      } else {
        revMissing = missing.join(", ");
      }
    }
    const pf = typeof pathFilter === "string" && pathFilter.trim().length > 0 ? pathFilter.trim() : undefined;
    const q = typeof query === "string" && query.trim().length > 0 ? query.trim() : undefined;
    const branch = await readCurrentBranchName(root);
    const [commits, offHead, branchTree, working, stashes, rebaseInProgress, sync, items] = await Promise.all([
      readRecentCommits(root, capped, logRev, pf, q, mergesMode),
      readOffHeadHashes(root, logRev, OFF_HEAD_CAP),
      readBranchTreePayload(root),
      readWorkingState(root).catch(() => ({ staged: 0, modified: 0, untracked: 0, conflicted: 0 })),
      readStashes(root).catch(() => []),
      isRebaseInProgress(root).catch(() => false),
      readSyncState(root).catch(() => ({ upstream: null, ahead: 0, behind: 0 })),
      repoItems().catch((): RepoItem[] => [{ path: root, group: "workspace", ...repoLabel(root, []) }]),
    ]);
    if (offHead) for (const c of commits) if (offHead.has(c.hash)) c.offHead = true;
    if (seq === graphRequestSeq) {
      shownRevs = dropSelection ? [] : revs;
      shownRoot = root;
    }
    webview.postMessage({
      type: "graphPayload",
      payload: {
        repoRoot: root,
        repos: items.map((i) => i.path),
        repoItems: items,
        selectedRepo: root,
        branch,
        // viewRev: "", ALL_REFS or the one clicked branch; a list is described by viewRefs instead.
        viewRev: typeof logRev === "string" ? logRev : "",
        viewRefs,
        // The selection this reply answers: the webview ignores a stale reply's dropSelection.
        requestedRevs: revs,
        revMissing: revMissing ?? "",
        dropSelection,
        revMissingIsList: revMissing !== undefined && sel.kind === "list",
        rebaseInProgress,
        // The view shows more than HEAD's history, so "on the current branch" means something.
        // At the cap the list is cut short, so older rows missing from it may not be on HEAD: no tint.
        onHeadKnown: offHead !== undefined && offHead.size < OFF_HEAD_CAP,
        sync,
        pathFilter: pf ?? "",
        query: q ?? "",
        branchTree,
        commits,
        working,
        stashes,
      },
    });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "graphError", code: "git", message: msg });
  }
}

async function sendStashFiles(webview: vscode.Webview, ref: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  try {
    const files = await readStashFiles(root, ref);
    webview.postMessage({ type: "stashFiles", ref, files });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "stashFilesError", ref, message: msg });
  }
}

async function openStashFileDiff(ref: string, filePath: string, oldPath: string | undefined): Promise<void> {
  const root = await getActiveRepoRoot();
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

function isRebaseAction(s: unknown): s is RebaseAction {
  return s === "pick" || s === "drop" || s === "squash" || s === "fixup";
}

async function sendRebaseCommits(webview: vscode.Webview, base: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  try {
    if (await isRebaseInProgress(root)) {
      webview.postMessage({
        type: "rebaseError",
        message: vscode.l10n.t("A rebase is already in progress. Resolve or abort it first."),
      });
      return;
    }
    const commits = await readRebaseCommits(root, await resolveRebaseBase(root, base));
    webview.postMessage({ type: "rebaseCommits", base, commits });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "rebaseError", message: msg });
  }
}

async function applyRebase(
  webview: vscode.Webview,
  base: string,
  items: RebaseTodoItem[],
): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  if (items.length === 0) {
    webview.postMessage({ type: "rebaseError", message: vscode.l10n.t("Nothing to rebase.") });
    return;
  }
  const keptOrSquashed = items.filter((i) => i.action !== "drop");
  if (keptOrSquashed.length === 0 || keptOrSquashed[0].action !== "pick") {
    webview.postMessage({
      type: "rebaseError",
      message: vscode.l10n.t("First non-dropped commit must be a 'pick' (cannot squash/fixup onto nothing)."),
    });
    return;
  }
  const yes = await confirm(
    vscode.l10n.t("Rewrite {0} commit(s) with interactive rebase?", String(items.length)),
    true,
  );
  if (!yes) return;
  try {
    await runInteractiveRebase(root, await resolveRebaseBase(root, base), items);
    webview.postMessage({ type: "rebaseDone" });
    webview.postMessage({ type: "reloadNow" });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    if (await isRebaseInProgress(root)) {
      webview.postMessage({
        type: "rebaseError",
        message: vscode.l10n.t("Rebase paused (likely a conflict). Resolve in the SCM view, then continue or abort.\n{0}", msg),
      });
    } else {
      webview.postMessage({ type: "rebaseError", message: msg });
    }
  }
}

async function continueRebaseAndReload(webview: vscode.Webview): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  await runRebaseStep(root, continueRebase, (m) => void webview.postMessage(m), {
    stillPausedMessage: vscode.l10n.t("Still paused — there are unresolved conflicts. Resolve them in the SCM view, then continue again."),
  });
}

async function skipRebaseAndReload(webview: vscode.Webview): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  await runRebaseStep(root, skipRebase, (m) => void webview.postMessage(m), {
    confirm: () => confirm(vscode.l10n.t("Skip the current commit and continue the rebase?"), true),
    // Skipping onto the next conflicting commit is the same situation as continuing into one.
    stillPausedMessage: vscode.l10n.t("Still paused — there are unresolved conflicts. Resolve them in the SCM view, then continue again."),
  });
}

async function abortRebaseAndReload(webview: vscode.Webview): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  if (!(await isRebaseInProgress(root))) {
    webview.postMessage({ type: "rebaseDone" });
    return;
  }
  const yes = await confirm(vscode.l10n.t("Abort the in-progress rebase?"), true);
  if (!yes) return;
  try {
    await abortRebase(root);
    webview.postMessage({ type: "rebaseDone" });
    webview.postMessage({ type: "reloadNow" });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "rebaseError", message: msg });
  }
}

async function sendCompareFiles(webview: vscode.Webview, a: string, b: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  try {
    const files = await readCompareFiles(root, a, b);
    webview.postMessage({ type: "compareFiles", a, b, files });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "compareFilesError", a, b, message: msg });
  }
}

async function openComparePatch(a: string, b: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  const doc = await vscode.workspace.openTextDocument(compareShowUri(root, a, b));
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
}

async function openCompareFileDiff(
  a: string,
  b: string,
  filePath: string,
  status: string,
  oldPath: string | undefined,
): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) return;
  const sa = a.slice(0, 7);
  const sb = b.slice(0, 7);
  const title =
    status === "R" && oldPath
      ? vscode.l10n.t("{0} → {1} ({2}..{3})", oldPath, filePath, sa, sb)
      : vscode.l10n.t("{0} ({1}..{2})", filePath, sa, sb);
  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  if (status === "A") {
    leftUri = commitFileUri(root, "", filePath);
    rightUri = commitFileUri(root, b, filePath);
  } else if (status === "D") {
    leftUri = commitFileUri(root, a, filePath);
    rightUri = commitFileUri(root, "", filePath);
  } else if (status === "R" && oldPath) {
    leftUri = commitFileUri(root, a, oldPath);
    rightUri = commitFileUri(root, b, filePath);
  } else {
    leftUri = commitFileUri(root, a, filePath);
    rightUri = commitFileUri(root, b, filePath);
  }
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
    preview: true,
    preserveFocus: true,
  });
}

async function sendCommitFiles(webview: vscode.Webview, hash: string): Promise<void> {
  const root = await getActiveRepoRoot();
  if (!root) {
    return;
  }
  try {
    const files = await readCommitFiles(root, hash);
    webview.postMessage({ type: "commitFiles", hash, files });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    webview.postMessage({ type: "commitFilesError", hash, message: msg });
  }
}

async function openCommitFileDiff(
  hash: string,
  filePath: string,
  status: string,
  oldPath: string | undefined,
): Promise<void> {
  const root = await getActiveRepoRoot();
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

/**
 * Opens the panel on `root` (switching the repo picker if needed) with `sha` selected.
 * The webview finds it through the SHA search, so it works however old the commit is.
 */
export async function revealCommitInPanel(root: string, sha: string): Promise<void> {
  if ((await getActiveRepoRoot()) !== root) {
    await setSelectedRepo(root);
  }
  await revealCommitPanelAndReload();
  panelViewRef?.webview.postMessage({ type: "revealCommit", hash: sha });
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
  extContext = context;
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
      webview.html = buildCommitGraphShellHtml(webview, context.extensionUri, ui, htmlLang, {
        fileView: readFileViewPref(),
        openingRevs: readConfiguredOpeningRevs(),
        display: readDisplayPrefs(),
      });

      webview.onDidReceiveMessage(
        async (msg: {
          type?: string;
          limit?: number;
          hash?: string;
          rev?: string;
          revs?: unknown;
          action?: string;
          pathFilter?: string;
          query?: string;
          path?: string;
          oldPath?: string;
          status?: string;
          branch?: string;
          text?: string;
          mergesMode?: string;
          a?: string;
          b?: string;
          base?: string;
          op?: string;
          root?: string;
          mode?: string;
          columns?: unknown;
          items?: Array<{ sha?: string; subject?: string; action?: string }>;
        }) => {
          // Anything that changes a repository must act on the one the graph shows.
          if (typeof msg?.type === "string" && WRITE_MESSAGES.has(msg.type) && !(await shownRepoIsActive(webview))) {
            return;
          }
          if (msg?.type === "setFileView" && (msg.mode === "list" || msg.mode === "tree")) {
            void extContext?.workspaceState.update(FILE_VIEW_KEY, msg.mode);
            return;
          }
          if (msg?.type === "selectRepo" && typeof msg.root === "string") {
            void selectRepoAndReload(webview, msg.root);
            return;
          }
          // The picker opened: scan the disk again so a clone made a minute ago shows up.
          if (msg?.type === "refreshRepos") {
            void sendRepoList(webview, true);
            return;
          }
          if (msg?.type === "openRepository") {
            void vscode.commands.executeCommand("gitline.openRepository");
            return;
          }
          if (msg?.type === "clearRecentRepos") {
            // The graph may have been showing a recent repository: reload so screen and target agree.
            void extContext?.globalState.update(recentReposKey(), []).then(async () => {
              await sendRepoList(webview, false);
              void webview.postMessage({ type: "reloadNow" });
            });
            return;
          }
          if (
            msg?.type === "runSync" &&
            (msg.op === "pull" || msg.op === "push" || msg.op === "fetch")
          ) {
            void dispatchSyncOp(webview, msg.op);
            return;
          }
          if (msg?.type === "setColumns") {
            void writeColumns(msg.columns).catch((e) => {
              void vscode.window.showErrorMessage(errorMessage(e));
              // The webview already shows the change: put it back to what the settings say.
              void webview.postMessage({ type: "displayPrefs", display: readDisplayPrefs() });
            });
            return;
          }
          if (msg?.type === "saveViewAsDefault") {
            void saveCurrentViewAsDefault();
            return;
          }
          if (msg?.type === "requestGraph") {
            const lim = typeof msg.limit === "number" ? msg.limit : 200;
            const r = normalizeRevs(msg.revs, msg.rev);
            const pf = typeof msg.pathFilter === "string" ? msg.pathFilter : undefined;
            const q = typeof msg.query === "string" ? msg.query : undefined;
            const mm: MergesMode | undefined =
              msg.mergesMode === "hide" || msg.mergesMode === "only" || msg.mergesMode === "all"
                ? msg.mergesMode
                : undefined;
            void sendGraphPayload(webview, lim, r, pf, q, mm);
            return;
          }
          if (msg?.type === "requestCompareFiles" && typeof msg.a === "string" && typeof msg.b === "string") {
            void sendCompareFiles(webview, msg.a, msg.b);
            return;
          }
          if (msg?.type === "openComparePatch" && typeof msg.a === "string" && typeof msg.b === "string") {
            void openComparePatch(msg.a, msg.b);
            return;
          }
          if (
            msg?.type === "openCompareFileDiff" &&
            typeof msg.a === "string" &&
            typeof msg.b === "string" &&
            typeof msg.path === "string" &&
            typeof msg.status === "string"
          ) {
            void openCompareFileDiff(msg.a, msg.b, msg.path, msg.status, msg.oldPath);
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
          if (msg?.type === "requestRebaseCommits" && typeof msg.base === "string") {
            void sendRebaseCommits(webview, msg.base);
            return;
          }
          if (
            msg?.type === "applyRebase" &&
            typeof msg.base === "string" &&
            Array.isArray(msg.items)
          ) {
            const items: RebaseTodoItem[] = [];
            for (const raw of msg.items) {
              if (
                raw &&
                typeof raw.sha === "string" &&
                typeof raw.subject === "string" &&
                isRebaseAction(raw.action)
              ) {
                items.push({ sha: raw.sha, subject: raw.subject, action: raw.action });
              }
            }
            void applyRebase(webview, msg.base, items);
            return;
          }
          if (msg?.type === "abortRebase") {
            void abortRebaseAndReload(webview);
            return;
          }
          if (msg?.type === "continueRebase") {
            void continueRebaseAndReload(webview);
            return;
          }
          if (msg?.type === "skipRebase") {
            void skipRebaseAndReload(webview);
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
  lastDefaultKey = JSON.stringify(configuredDefaultRevs());
  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider("gitline.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration(applyGraphConfigChange),
    vscode.workspace.onDidChangeConfiguration(applyDisplayConfigChange),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration("gitline.repositories")) invalidateRepoScan();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateRepoScan()),
  );
}
