import * as vscode from "vscode";
import type { CommitGraphWebviewUi } from "./nls";

/** Per-workspace view preferences the webview needs before its first render. */
/** openingRevs: the view to open with (from settings), or null to restore the webview's own state. */
/** Raw `gitline.graph` display settings; the webview validates them (display.js). */
export type DisplayPrefs = {
  columns?: unknown;
  dateFormat?: unknown;
  detailsLocation?: unknown;
  highlightCurrentBranch?: unknown;
};
export type CommitGraphPrefs = { fileView: "list" | "tree"; openingRevs?: string[] | null; display?: DisplayPrefs };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * Toolbar and pane icons: inline SVG drawn with currentColor, so they follow the theme without an
 * icon font. 16×16 viewBox, stroke-based, in the spirit of VS Code's codicons.
 */
const svg = (body: string): string =>
  `<svg class="gv-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  // A merge node (two parents joining) — struck through / highlighted.
  hideMerges: svg('<circle cx="5" cy="4" r="1.6"/><circle cx="11" cy="4" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M5 5.6v1.2c0 1.6 3 2 3 3.6M11 5.6v1.2c0 1.6-3 2-3 3.6"/><path d="M2.5 14 13.5 2"/>'),
  onlyMerges: svg('<circle cx="5" cy="4" r="1.6"/><circle cx="11" cy="4" r="1.6"/><circle cx="8" cy="12" r="2.2" fill="currentColor"/><path d="M5 5.6v1.2c0 1.6 3 2 3 3.6M11 5.6v1.2c0 1.6-3 2-3 3.6"/>'),
  pull: svg('<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>'),
  push: svg('<path d="M8 13.5v-8M4.5 9 8 5.5 11.5 9M3 2.5h10"/>'),
  fetch: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
  chevron: svg('<path d="M6 4l4 4-4 4"/>'),
};

/** Stylesheets in cascade order — same order as the sections of the former single graph.css. */
const STYLESHEETS = [
  "base.css",
  "shell.css",
  "toolbar.css",
  "branch-tree.css",
  "workspace.css",
  "commit-list.css",
  "context-menu.css",
  "detail.css",
  "rows.css",
  "layout.css",
];

/** Webview scripts in load order — each module reads only what earlier ones put on window.GV. */
const WEBVIEW_MODULES = [
  "util.js",
  "laneLayout.js",
  "graphSvg.js",
  "contextMenu.js",
  "fileTree.js",
  "detailPane.js",
  "rebaseEditor.js",
  "menus.js",
  "branchTree.js",
  "refChips.js",
  "commitNav.js",
  "display.js",
  "commitList.js",
  "layout.js",
  "main.js",
];

function getNonce(): string {
  let text = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildCommitGraphShellHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  ui: CommitGraphWebviewUi,
  htmlLang: string,
  prefs: CommitGraphPrefs,
): string {
  const styleTags = STYLESHEETS.map((name) => {
    const href = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles", name));
    return `<link rel="stylesheet" href="${href}" />`;
  }).join("\n  ");
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const uiJson = safeJsonForScript(ui);
  /** The collapse / expand button at the start of a pane head (layout.js wires it up). */
  const paneToggle = (pane: string, label: string): string => {
    const title = escapeHtml(ui.togglePaneTitle.replace("{0}", label));
    return `<button type="button" class="gv-pane-toggle" data-pane-toggle="${pane}" aria-expanded="true" title="${title}" aria-label="${title}">${ICONS.chevron}</button>`;
  };
  const scriptTags = WEBVIEW_MODULES.map((name) => {
    const src = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", name));
    return `<script nonce="${nonce}" src="${src}"></script>`;
  }).join("\n  ");
  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLang)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  ${styleTags}
  <title>${escapeHtml(ui.pageTitle)}</title>
</head>
<body class="gv-commit-body gv-in-panel">
  <div class="gv-shell">
  <header class="gv-header gv-header--compact gv-header--panel-shrink gv-topbar">
    <div class="gv-title-row gv-topbar__headline">
      <div class="gv-topbar__title-block">
        <span class="gv-topbar__mark" aria-hidden="true"></span>
        <span class="gv-title">${escapeHtml(ui.heading)}</span>
      </div>
      <div class="gv-repo-picker">
        <button type="button" class="gv-repo-badge" id="repo-path" aria-haspopup="true" aria-expanded="false" title="${escapeHtml(ui.repoPickerTitle)}"></button>
        <div class="gv-repo-menu" id="repo-menu" role="dialog" aria-label="${escapeHtml(ui.repoPickerTitle)}" hidden></div>
      </div>
    </div>
    <div class="gv-repo-fullpath gv-topbar__path" id="repo-full" hidden></div>
    <div class="gv-toolbar gv-topbar__tools" role="toolbar" aria-label="${escapeHtml(ui.toolbarAria)}">
      <div class="gv-search">
        <span class="gv-search__icon" aria-hidden="true">🔍</span>
        <input id="search-input" type="text" class="gv-search__input" placeholder="${escapeHtml(ui.searchPlaceholder)}" autocomplete="off" spellcheck="false" />
        <button type="button" id="btn-clear-search" class="gv-search__clear" hidden title="${escapeHtml(ui.searchClearTitle)}" aria-label="${escapeHtml(ui.searchClearTitle)}">✕</button>
      </div>
      <div class="gv-merge-toggle" role="group" aria-label="${escapeHtml(ui.mergesGroupAria)}">
        <button type="button" id="btn-hide-merges" class="gv-merge-toggle__btn" title="${escapeHtml(ui.hideMergesTitle)}" aria-label="${escapeHtml(ui.hideMergesTitle)}" aria-pressed="false">${ICONS.hideMerges}</button>
        <button type="button" id="btn-only-merges" class="gv-merge-toggle__btn" title="${escapeHtml(ui.onlyMergesTitle)}" aria-label="${escapeHtml(ui.onlyMergesTitle)}" aria-pressed="false">${ICONS.onlyMerges}</button>
      </div>
      <div class="gv-sync" role="group" aria-label="${escapeHtml(ui.syncGroupAria)}">
        <button type="button" id="btn-pull" class="gv-sync__btn" title="${escapeHtml(ui.pullTitle)}" aria-label="${escapeHtml(ui.pullTitle)}">${ICONS.pull}</button>
        <button type="button" id="btn-push" class="gv-sync__btn" title="${escapeHtml(ui.pushTitle)}" aria-label="${escapeHtml(ui.pushTitle)}">${ICONS.push}<span id="sync-counts" class="gv-sync__counts" hidden></span></button>
        <button type="button" id="btn-fetch" class="gv-sync__btn" title="${escapeHtml(ui.fetchTitle)}" aria-label="${escapeHtml(ui.fetchTitle)}">${ICONS.fetch}</button>
      </div>
      <div id="compare-chip" class="gv-compare-chip" hidden>
        <span class="gv-compare-chip__label" id="compare-chip-label"></span>
        <button type="button" id="btn-exit-compare" class="gv-compare-chip__exit" title="${escapeHtml(ui.exitCompareTitle)}" aria-label="${escapeHtml(ui.exitCompareTitle)}">✕</button>
      </div>
      <div id="path-filter" class="gv-path-filter" hidden>
        <span class="gv-path-filter__icon" aria-hidden="true">📄</span>
        <span id="path-filter-label" class="gv-path-filter__label"></span>
        <button type="button" id="btn-clear-path" class="gv-path-filter__clear" title="${escapeHtml(ui.clearFilterTitle)}" aria-label="${escapeHtml(ui.clearFilterTitle)}">✕</button>
      </div>
    </div>
    <div id="rev-notice" class="gv-rev-notice" hidden role="status" aria-live="polite">
      <span class="gv-rev-notice__icon" aria-hidden="true">⚠</span>
      <span id="rev-notice-text" class="gv-rev-notice__text"></span>
      <button type="button" id="btn-dismiss-notice" class="gv-rev-notice__close" title="${escapeHtml(ui.dismissNoticeTitle)}" aria-label="${escapeHtml(ui.dismissNoticeTitle)}">✕</button>
    </div>
    <div id="rebase-banner" class="gv-rebase-banner" hidden role="status" aria-live="polite">
      <span class="gv-rebase-banner__icon" aria-hidden="true">⎇</span>
      <span class="gv-rebase-banner__text">${escapeHtml(ui.rebaseInProgressNotice)}</span>
      <span class="gv-rebase-banner__actions">
        <button type="button" id="btn-rebase-continue" class="gv-rebase-banner__btn gv-rebase-banner__btn--primary">${escapeHtml(ui.rebaseContinue)}</button>
        <button type="button" id="btn-rebase-skip" class="gv-rebase-banner__btn">${escapeHtml(ui.rebaseSkip)}</button>
        <button type="button" id="btn-rebase-abort2" class="gv-rebase-banner__btn gv-rebase-banner__btn--danger">${escapeHtml(ui.rebaseAbort)}</button>
      </span>
    </div>
  </header>
  <main class="gv-panel-main gv-workspace-root">
    <aside id="branch-bar" class="gv-ref-sidebar gv-collapsible" data-pane="sidebar" hidden aria-label="${escapeHtml(ui.branchBarAria)}">
      <div class="gv-ref-sidebar__head gv-collapsible__head">
        ${paneToggle("sidebar", ui.branchBarTitle)}
        <span class="gv-ref-sidebar__title gv-collapsible__title">${escapeHtml(ui.branchBarTitle)}</span>
      </div>
      <div class="gv-ref-filter gv-collapsible__body">
        <input id="branch-filter" type="search" class="gv-ref-filter__input" placeholder="${escapeHtml(ui.branchFilterPlaceholder)}" aria-label="${escapeHtml(ui.branchFilterPlaceholder)}" autocomplete="off" spellcheck="false" />
      </div>
      <div id="branch-tree-root" class="gv-ref-tree-scroll gv-collapsible__body" role="tree"></div>
    </aside>
    <div id="split-sidebar" class="gv-splitter" role="separator" aria-orientation="vertical" tabindex="0" aria-label="${escapeHtml(ui.resizeSidebarAria)}" title="${escapeHtml(ui.resizeHint)}"></div>
    <div class="gv-panel-center">
      <div id="empty-state" class="gv-empty-state" hidden>
        <div class="gv-empty-card">
          <div class="gv-empty-icon" aria-hidden="true"></div>
          <div class="gv-empty-title" id="empty-title"></div>
          <div class="gv-empty-body" id="empty-body"></div>
        </div>
      </div>
      <div id="graph-workspace" class="gv-graph-workspace gv-workspace-three">
        <div class="gv-pane gv-pane-log gv-collapsible" data-pane="log" role="region" aria-label="${escapeHtml(ui.paneLogAria)}">
          <div class="gv-pane-head gv-pane-head--log gv-collapsible__head">
            ${paneToggle("log", ui.paneLogAria)}
            <span class="gv-pane-head__label gv-collapsible__title">${escapeHtml(ui.paneLogAria)}</span>
          </div>
          <div class="gv-unified-wrap gv-collapsible__body">
            <div class="gv-unified-head" tabindex="0" role="button" aria-haspopup="menu" aria-label="${escapeHtml(ui.columnMenuHint)}" title="${escapeHtml(ui.columnMenuHint)}">
              <span class="gv-unified-head-graph">${escapeHtml(ui.columnGraph)}</span>
              <span class="gv-unified-head-commit">${escapeHtml(ui.columnCommit)}</span>
            </div>
            <div class="gv-graph-canvas">
              <svg id="graph-svg" class="gv-graph-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
              <div id="graph-root" class="gv-unified-list"></div>
            </div>
          </div>
        </div>
        <div id="split-preview" class="gv-splitter" role="separator" aria-orientation="vertical" tabindex="0" aria-label="${escapeHtml(ui.resizePreviewAria)}" title="${escapeHtml(ui.resizeHint)}"></div>
        <div class="gv-pane gv-pane-preview gv-collapsible" data-pane="preview" role="region" aria-label="${escapeHtml(ui.panePreviewTitle)}">
          <div class="gv-pane-head gv-pane-head--preview gv-collapsible__head">
            ${paneToggle("preview", ui.panePreviewTitle)}
            <span class="gv-pane-head__label gv-collapsible__title">${escapeHtml(ui.panePreviewTitle)}</span>
          </div>
          <section id="commit-detail" class="gv-detail gv-detail--empty gv-collapsible__body" aria-live="polite">
            <p class="gv-detail-hint">${escapeHtml(ui.detailHint)}</p>
          </section>
        </div>
      </div>
    </div>
  </main>
  </div>
  <div id="ctx-menu" class="gv-ctx" role="menu" hidden></div>
  <script nonce="${nonce}">window.__GV_UI__=${uiJson};window.__GV_PREFS__=${safeJsonForScript(prefs)};</script>
  ${scriptTags}
</body>
</html>`;
}
