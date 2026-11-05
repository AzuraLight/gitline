import * as vscode from "vscode";
import type { CommitGraphWebviewUi } from "./nls";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

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
];

/** Webview scripts in load order — each module reads only what earlier ones put on window.GV. */
const WEBVIEW_MODULES = [
  "util.js",
  "laneLayout.js",
  "graphSvg.js",
  "contextMenu.js",
  "detailPane.js",
  "rebaseEditor.js",
  "menus.js",
  "branchTree.js",
  "commitList.js",
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
      <div class="gv-repo-picker" id="repo-picker">
        <button type="button" class="gv-repo-badge" id="repo-path" aria-haspopup="true" aria-expanded="false" title="${escapeHtml(ui.repoPickerTitle)}"></button>
        <div class="gv-repo-menu" id="repo-menu" role="menu" hidden></div>
      </div>
    </div>
    <div class="gv-repo-fullpath gv-topbar__path" id="repo-full" hidden></div>
    <div class="gv-toolbar gv-topbar__tools" role="toolbar" aria-label="${escapeHtml(ui.toolbarAria)}">
      <div class="gv-search">
        <span class="gv-search__icon" aria-hidden="true">🔍</span>
        <input id="search-input" type="text" class="gv-search__input" placeholder="${escapeHtml(ui.searchPlaceholder)}" autocomplete="off" spellcheck="false" />
        <button type="button" id="btn-clear-search" class="gv-search__clear" hidden title="${escapeHtml(ui.searchClearTitle)}" aria-label="${escapeHtml(ui.searchClearTitle)}">✕</button>
      </div>
      <div class="gv-merge-toggle" role="group" aria-label="merges">
        <button type="button" id="btn-hide-merges" class="gv-merge-toggle__btn" title="${escapeHtml(ui.hideMergesTitle)}" aria-pressed="false">⊘M</button>
        <button type="button" id="btn-only-merges" class="gv-merge-toggle__btn" title="${escapeHtml(ui.onlyMergesTitle)}" aria-pressed="false">⊕M</button>
      </div>
      <div class="gv-sync" role="group" aria-label="sync">
        <button type="button" id="btn-pull" class="gv-sync__btn" title="${escapeHtml(ui.pullTitle)}">↓</button>
        <button type="button" id="btn-push" class="gv-sync__btn" title="${escapeHtml(ui.pushTitle)}">↑<span id="sync-counts" class="gv-sync__counts" hidden></span></button>
        <button type="button" id="btn-fetch" class="gv-sync__btn" title="${escapeHtml(ui.fetchTitle)}">⟳</button>
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
    <aside id="branch-bar" class="gv-ref-sidebar" hidden aria-label="${escapeHtml(ui.branchBarAria)}">
      <div class="gv-ref-sidebar__head">
        <span class="gv-ref-sidebar__title">${escapeHtml(ui.branchBarTitle)}</span>
      </div>
      <div id="branch-tree-root" class="gv-ref-tree-scroll" role="tree"></div>
    </aside>
    <div class="gv-panel-center">
      <div id="empty-state" class="gv-empty-state" hidden>
        <div class="gv-empty-card">
          <div class="gv-empty-icon" aria-hidden="true"></div>
          <div class="gv-empty-title" id="empty-title"></div>
          <div class="gv-empty-body" id="empty-body"></div>
        </div>
      </div>
      <div id="graph-workspace" class="gv-graph-workspace gv-workspace-three">
        <div class="gv-pane gv-pane-log" role="region" aria-label="${escapeHtml(ui.paneLogAria)}">
          <div class="gv-pane-head gv-pane-head--log">
            <span class="gv-pane-head__label">${escapeHtml(ui.paneLogAria)}</span>
          </div>
          <div class="gv-unified-wrap">
            <div class="gv-unified-head" aria-hidden="true">
              <span class="gv-unified-head-graph">${escapeHtml(ui.columnGraph)}</span>
              <span class="gv-unified-head-commit">${escapeHtml(ui.columnCommit)}</span>
            </div>
            <div class="gv-graph-canvas">
              <svg id="graph-svg" class="gv-graph-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
              <div id="graph-root" class="gv-unified-list"></div>
            </div>
          </div>
        </div>
        <div class="gv-pane gv-pane-preview">
          <div class="gv-pane-head gv-pane-head--preview">
            <span class="gv-pane-head__label">${escapeHtml(ui.panePreviewTitle)}</span>
          </div>
          <section id="commit-detail" class="gv-detail gv-detail--empty" aria-live="polite">
            <p class="gv-detail-hint">${escapeHtml(ui.detailHint)}</p>
          </section>
        </div>
      </div>
    </div>
  </main>
  </div>
  <div id="ctx-menu" class="gv-ctx" role="menu" hidden></div>
  <script nonce="${nonce}">window.__GV_UI__=${uiJson};</script>
  ${scriptTags}
</body>
</html>`;
}
