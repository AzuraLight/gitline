import * as vscode from "vscode";

/** Strings serialized into the commit graph webview (panel). */
export type CommitGraphWebviewUi = {
  pageTitle: string;
  heading: string;
  toolbarAria: string;
  columnGraph: string;
  columnCommit: string;
  detailHint: string;
  loading: string;
  errorGeneric: string;
  openGitShow: string;
  branchBarAria: string;
  branchBarTitle: string;
  branchHeadRow: string;
  branchGroupLocal: string;
  branchGroupRemote: string;
  paneLogAria: string;
  panePreviewTitle: string;
  emptyNoRepoTitle: string;
  emptyNoRepoBody: string;
  emptyNoCommitsTitle: string;
  emptyNoCommitsBody: string;
  emptyErrorTitle: string;
  clearFilterTitle: string;
  searchPlaceholder: string;
  searchClearTitle: string;
  filesLabel: string;
  noFiles: string;
  openPatchShort: string;
  workingChanges: string;
  hideMergesTitle: string;
  onlyMergesTitle: string;
  ctxMarkForCompare: string;
  ctxUnmarkCompare: string;
  ctxCompareWithMarkedDiff: string;
  ctxCompareWithMarkedFiles: string;
  comparingLabel: string;
  exitCompareTitle: string;
  ctxRebaseFromHere: string;
  rebaseTitle: string;
  rebaseApply: string;
  rebaseCancel: string;
  rebaseAbort: string;
  rebaseEmpty: string;
  rebaseMoveUp: string;
  rebaseMoveDown: string;
  revMissingNotice: string;
  dismissNoticeTitle: string;
  rebaseInProgressNotice: string;
  rebaseContinue: string;
  rebaseSkip: string;
  repoPickerTitle: string;
  pullTitle: string;
  pushTitle: string;
  publishTitle: string;
  fetchTitle: string;
  aheadBehindTitle: string;
};

/** Localized strings for the commit graph webview. */
export function getCommitGraphWebviewUi(): CommitGraphWebviewUi {
  return {
    pageTitle: vscode.l10n.t("Gitline"),
    heading: vscode.l10n.t("Commit graph"),
    toolbarAria: vscode.l10n.t("Graph toolbar"),
    columnGraph: vscode.l10n.t("Graph"),
    columnCommit: vscode.l10n.t("Commit"),
    detailHint: vscode.l10n.t("Click a commit to see the files it changed. Right-click for actions."),
    loading: vscode.l10n.t("Loading…"),
    errorGeneric: vscode.l10n.t("Error"),
    openGitShow: vscode.l10n.t("Open patch view"),
    branchBarAria: vscode.l10n.t("Branches and remotes"),
    branchBarTitle: vscode.l10n.t("Branches"),
    branchHeadRow: vscode.l10n.t("HEAD (default log)"),
    branchGroupLocal: vscode.l10n.t("Local"),
    branchGroupRemote: vscode.l10n.t("Remote: {0}"),
    paneLogAria: vscode.l10n.t("Graph and commit list"),
    panePreviewTitle: vscode.l10n.t("Preview"),
    emptyNoRepoTitle: vscode.l10n.t("No Git repository"),
    emptyNoRepoBody: vscode.l10n.t(
      "Open a folder containing a Git repository, or focus an editor tab whose file is inside one.",
    ),
    emptyNoCommitsTitle: vscode.l10n.t("No commits in this view"),
    emptyNoCommitsBody: vscode.l10n.t("Pick another branch in the sidebar, or clear the search filter."),
    emptyErrorTitle: vscode.l10n.t("Could not load history"),
    clearFilterTitle: vscode.l10n.t("Clear file filter"),
    searchPlaceholder: vscode.l10n.t("Search commits  ·  text · @author · sha"),
    searchClearTitle: vscode.l10n.t("Clear search"),
    filesLabel: vscode.l10n.t("Files changed"),
    noFiles: vscode.l10n.t("No files changed."),
    openPatchShort: vscode.l10n.t("Patch"),
    workingChanges: vscode.l10n.t("Working changes"),
    hideMergesTitle: vscode.l10n.t("Hide merge commits"),
    onlyMergesTitle: vscode.l10n.t("Only merge commits"),
    ctxMarkForCompare: vscode.l10n.t("Mark for compare"),
    ctxUnmarkCompare: vscode.l10n.t("Unmark compare base"),
    ctxCompareWithMarkedDiff: vscode.l10n.t("Compare with marked → patch"),
    ctxCompareWithMarkedFiles: vscode.l10n.t("Compare with marked → files"),
    comparingLabel: vscode.l10n.t("Comparing"),
    exitCompareTitle: vscode.l10n.t("Exit compare view"),
    ctxRebaseFromHere: vscode.l10n.t("Interactive rebase from here…"),
    rebaseTitle: vscode.l10n.t("Interactive rebase"),
    rebaseApply: vscode.l10n.t("Apply"),
    rebaseCancel: vscode.l10n.t("Cancel"),
    rebaseAbort: vscode.l10n.t("Abort rebase"),
    rebaseEmpty: vscode.l10n.t("No commits to rebase."),
    rebaseMoveUp: vscode.l10n.t("Move up"),
    rebaseMoveDown: vscode.l10n.t("Move down"),
    revMissingNotice: vscode.l10n.t("“{0}” no longer exists — showing the default history instead."),
    dismissNoticeTitle: vscode.l10n.t("Dismiss"),
    rebaseInProgressNotice: vscode.l10n.t("A rebase is paused. Resolve conflicts in the SCM view, then continue."),
    rebaseContinue: vscode.l10n.t("Continue"),
    rebaseSkip: vscode.l10n.t("Skip"),
    repoPickerTitle: vscode.l10n.t("Switch repository"),
    pullTitle: vscode.l10n.t("Pull (fast-forward)"),
    pushTitle: vscode.l10n.t("Push"),
    publishTitle: vscode.l10n.t("Publish branch (set upstream to origin)"),
    fetchTitle: vscode.l10n.t("Fetch all remotes"),
    aheadBehindTitle: vscode.l10n.t("Commits ahead / behind upstream"),
  };
}

/** BCP 47 language tag for generated HTML (best effort from VS Code). */
export function getWebviewHtmlLang(): string {
  const lang = vscode.env.language;
  return lang && lang.length > 0 ? lang : "en";
}
