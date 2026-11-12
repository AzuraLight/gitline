import * as vscode from "vscode";

/** Strings serialized into the commit graph webview (panel). */
export type CommitGraphWebviewUi = {
  pageTitle: string;
  heading: string;
  toolbarAria: string;
  columnGraph: string;
  columnCommit: string;
  columnAuthor: string;
  columnDate: string;
  columnSha: string;
  columnMenuHint: string;
  detailHint: string;
  loading: string;
  errorGeneric: string;
  openGitShow: string;
  branchBarAria: string;
  branchBarTitle: string;
  branchHeadRow: string;
  branchAllRow: string;
  commitNotOnHead: string;
  headerBranchCount: string;
  branchMultiSelectHint: string;
  mergesGroupAria: string;
  syncGroupAria: string;
  branchFilterPlaceholder: string;
  branchFilterNoMatch: string;
  resizeSidebarAria: string;
  resizePreviewAria: string;
  resizeHint: string;
  togglePaneTitle: string;
  moreRefsLabel: string;
  commitListAria: string;
  repoMenuWorkspace: string;
  repoMenuRecent: string;
  repoMenuOpenOther: string;
  repoMenuClearRecent: string;
  repoMenuFilter: string;
  repoMenuNoMatch: string;
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
  fileViewAsTree: string;
  fileViewAsList: string;
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
  revNoMatchNotice: string;
  dismissNoticeTitle: string;
  opBannerAria: string;
  workStash: string;
  workOpenScm: string;
  workMessagePlaceholder: string;
  workAmend: string;
  workCommit: string;
  workAmendButton: string;
  workConflicted: string;
  workStaged: string;
  workUnstaged: string;
  workUntracked: string;
  workDeleteFile: string;
  workDiscardFile: string;
  workStageFile: string;
  workUnstageFile: string;
  workUnstageAll: string;
  workStageGroup: string;
  workConflictNote: string;
  workClean: string;
  workAmendPushed: string;
  workDiscardAll: string;
  workCleanUntracked: string;
  rebaseMessageAria: string;
  rebaseActionAria: string;
  opAbort: string;
  opSkipTitle: string;
  opConflictedFilesAria: string;
  opRebasing: string;
  opRebasePaused: string;
  opMerging: string;
  opCherryPicking: string;
  opReverting: string;
  opProgress: string;
  opConflicts: string;
  opResolved: string;
  opOpenFileTitle: string;
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
    columnAuthor: vscode.l10n.t("Author"),
    columnDate: vscode.l10n.t("Date"),
    columnSha: vscode.l10n.t("SHA"),
    columnMenuHint: vscode.l10n.t("Right-click to show or hide columns"),
    detailHint: vscode.l10n.t("Click a commit to see the files it changed. Right-click for actions."),
    loading: vscode.l10n.t("Loading…"),
    errorGeneric: vscode.l10n.t("Error"),
    openGitShow: vscode.l10n.t("Open patch view"),
    branchBarAria: vscode.l10n.t("Branches and remotes"),
    branchBarTitle: vscode.l10n.t("Branches"),
    branchHeadRow: vscode.l10n.t("HEAD (default log)"),
    branchAllRow: vscode.l10n.t("All branches"),
    commitNotOnHead: vscode.l10n.t("Not on the current branch"),
    headerBranchCount: vscode.l10n.t("{0} branches"),
    branchMultiSelectHint: vscode.l10n.t("Ctrl/Cmd+click to add to the view"),
    mergesGroupAria: vscode.l10n.t("Merge commit filters"),
    syncGroupAria: vscode.l10n.t("Pull, push and fetch"),
    branchFilterPlaceholder: vscode.l10n.t("Filter branches"),
    branchFilterNoMatch: vscode.l10n.t("No branch matches “{0}”"),
    resizeSidebarAria: vscode.l10n.t("Resize the branch list"),
    resizePreviewAria: vscode.l10n.t("Resize the preview"),
    resizeHint: vscode.l10n.t("Drag or use ←/→ to resize · double-click to reset · Enter to collapse"),
    togglePaneTitle: vscode.l10n.t("Collapse or expand: {0}"),
    moreRefsLabel: vscode.l10n.t("+{0}"),
    repoMenuWorkspace: vscode.l10n.t("Workspace"),
    repoMenuRecent: vscode.l10n.t("Recent"),
    repoMenuOpenOther: vscode.l10n.t("Open another repository…"),
    repoMenuClearRecent: vscode.l10n.t("Clear recent repositories"),
    repoMenuFilter: vscode.l10n.t("Filter repositories"),
    repoMenuNoMatch: vscode.l10n.t("No repository matches “{0}”"),
    commitListAria: vscode.l10n.t("Commits — ↑/↓ to move, Ctrl/Cmd+↓/↑ to follow parent/child, Enter to open"),
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
    fileViewAsTree: vscode.l10n.t("View as tree"),
    fileViewAsList: vscode.l10n.t("View as list"),
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
    revNoMatchNotice: vscode.l10n.t("No branch matches {0} in this repository — showing the default history instead."),
    dismissNoticeTitle: vscode.l10n.t("Dismiss"),
    opBannerAria: vscode.l10n.t("Paused Git operation"),
    workStash: vscode.l10n.t("Stash…"),
    workOpenScm: vscode.l10n.t("Source Control"),
    workMessagePlaceholder: vscode.l10n.t("Commit message (Ctrl/Cmd+Enter to commit)"),
    workAmend: vscode.l10n.t("Amend last commit"),
    workCommit: vscode.l10n.t("Commit"),
    workAmendButton: vscode.l10n.t("Amend"),
    workConflicted: vscode.l10n.t("Merge conflicts"),
    workStaged: vscode.l10n.t("Staged"),
    workUnstaged: vscode.l10n.t("Changes"),
    workUntracked: vscode.l10n.t("Untracked"),
    workDeleteFile: vscode.l10n.t("Delete file"),
    workDiscardFile: vscode.l10n.t("Discard changes"),
    workStageFile: vscode.l10n.t("Stage"),
    workUnstageFile: vscode.l10n.t("Unstage"),
    workUnstageAll: vscode.l10n.t("Unstage all"),
    workStageGroup: vscode.l10n.t("Stage all"),
    workConflictNote: vscode.l10n.t("Resolve these in the editor, then stage them."),
    workClean: vscode.l10n.t("No changes — the working tree is clean."),
    workAmendPushed: vscode.l10n.t("The last commit is already pushed: amending it means a force push."),
    workDiscardAll: vscode.l10n.t("Discard all changes to tracked files…"),
    workCleanUntracked: vscode.l10n.t("Delete untracked files…"),
    rebaseMessageAria: vscode.l10n.t("Commit message"),
    rebaseActionAria: vscode.l10n.t("Action"),
    opAbort: vscode.l10n.t("Abort"),
    opSkipTitle: vscode.l10n.t("Leave out the current commit and go on"),
    opConflictedFilesAria: vscode.l10n.t("Conflicted files"),
    opRebasing: vscode.l10n.t("Rebasing {0}"),
    opRebasePaused: vscode.l10n.t("Rebase paused"),
    opMerging: vscode.l10n.t("Merging: {0}"),
    opCherryPicking: vscode.l10n.t("Cherry-picking: {0}"),
    opReverting: vscode.l10n.t("Reverting: {0}"),
    opProgress: vscode.l10n.t("step {0} of {1}"),
    opConflicts: vscode.l10n.t("{0} conflicted file(s) — resolve and stage them in Source Control, then Continue"),
    opResolved: vscode.l10n.t("No conflicts left — Continue to finish"),
    opOpenFileTitle: vscode.l10n.t("Open the file to resolve its conflicts"),
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
