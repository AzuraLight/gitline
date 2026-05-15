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
  };
}

/** BCP 47 language tag for generated HTML (best effort from VS Code). */
export function getWebviewHtmlLang(): string {
  const lang = vscode.env.language;
  return lang && lang.length > 0 ? lang : "en";
}
