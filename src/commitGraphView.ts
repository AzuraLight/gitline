import * as vscode from "vscode";
import type { CommitGraphWebviewUi } from "./nls";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

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
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "graph.css"));
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const uiJson = safeJsonForScript(ui);
  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLang)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
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
      <span class="gv-repo-badge" id="repo-path"></span>
    </div>
    <div class="gv-repo-fullpath gv-topbar__path" id="repo-full" hidden></div>
    <div class="gv-toolbar gv-topbar__tools" role="toolbar" aria-label="${escapeHtml(ui.toolbarAria)}">
      <div class="gv-search">
        <span class="gv-search__icon" aria-hidden="true">🔍</span>
        <input id="search-input" type="text" class="gv-search__input" placeholder="${escapeHtml(ui.searchPlaceholder)}" autocomplete="off" spellcheck="false" />
        <button type="button" id="btn-clear-search" class="gv-search__clear" hidden title="${escapeHtml(ui.searchClearTitle)}" aria-label="${escapeHtml(ui.searchClearTitle)}">✕</button>
      </div>
      <div id="path-filter" class="gv-path-filter" hidden>
        <span class="gv-path-filter__icon" aria-hidden="true">📄</span>
        <span id="path-filter-label" class="gv-path-filter__label"></span>
        <button type="button" id="btn-clear-path" class="gv-path-filter__clear" title="${escapeHtml(ui.clearFilterTitle)}" aria-label="${escapeHtml(ui.clearFilterTitle)}">✕</button>
      </div>
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
  <script nonce="${nonce}">
    ${getPanelClientScript()}
  </script>
</body>
</html>`;
}

function getPanelClientScript(): string {
  return `
(function () {
  var vscode = acquireVsCodeApi();
  var UI = window.__GV_UI__ || {};
  var root = document.getElementById("graph-root");
  var detail = document.getElementById("commit-detail");
  var repoPathEl = document.getElementById("repo-path");
  var repoFullEl = document.getElementById("repo-full");
  var branchBar = document.getElementById("branch-bar");
  var branchTreeRoot = document.getElementById("branch-tree-root");
  var emptyState = document.getElementById("empty-state");
  var emptyTitle = document.getElementById("empty-title");
  var emptyBody = document.getElementById("empty-body");
  var graphWorkspace = document.getElementById("graph-workspace");
  var pathFilterEl = document.getElementById("path-filter");
  var pathFilterLabel = document.getElementById("path-filter-label");
  var btnClearPath = document.getElementById("btn-clear-path");
  var searchInput = document.getElementById("search-input");
  var btnClearSearch = document.getElementById("btn-clear-search");
  if (!root || !detail || !graphWorkspace || !emptyState) return;

  var state = vscode.getState() || {};
  var limit = 200;
  var selectedRev = typeof state.selectedRev === "string" ? state.selectedRev : "";
  var pathFilter = typeof state.pathFilter === "string" ? state.pathFilter : "";
  var query = typeof state.query === "string" ? state.query : "";
  var currentHash = "";
  var scrollHandlerRef = { fn: null };
  var renderCommitFilesRef = null;

  function saveState() {
    vscode.setState({ selectedRev: selectedRev, pathFilter: pathFilter, query: query });
  }

  function setStatus(_t) {}

  function applyPathFilter() {
    if (!pathFilterEl || !pathFilterLabel) return;
    if (pathFilter) {
      pathFilterLabel.textContent = pathFilter;
      pathFilterLabel.title = pathFilter;
      pathFilterEl.removeAttribute("hidden");
    } else {
      pathFilterLabel.textContent = "";
      pathFilterEl.setAttribute("hidden", "");
    }
  }

  function showEmptyCard(title, body) {
    if (emptyTitle) emptyTitle.textContent = title || "";
    if (emptyBody) emptyBody.textContent = body || "";
    emptyState.removeAttribute("hidden");
    graphWorkspace.setAttribute("hidden", "");
    if (detail) detail.setAttribute("hidden", "");
  }

  function hideEmptyCard() {
    emptyState.setAttribute("hidden", "");
    graphWorkspace.removeAttribute("hidden");
    if (detail) detail.removeAttribute("hidden");
  }

  function setBranchBarVisible(on) {
    if (!branchBar) return;
    if (on) branchBar.removeAttribute("hidden");
    else branchBar.setAttribute("hidden", "");
  }

  // Context menu helpers.
  var ctxEl = document.getElementById("ctx-menu");
  function hideCtx() {
    if (!ctxEl) return;
    ctxEl.hidden = true;
    ctxEl.textContent = "";
  }
  document.addEventListener("click", function (e) {
    if (ctxEl && !ctxEl.hidden && !ctxEl.contains(e.target)) hideCtx();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hideCtx();
  });
  window.addEventListener("blur", hideCtx);

  function showCtx(x, y, items) {
    if (!ctxEl) return;
    ctxEl.textContent = "";
    items.forEach(function (it) {
      if (it === "-") {
        var sep = document.createElement("div");
        sep.className = "gv-ctx__sep";
        ctxEl.appendChild(sep);
        return;
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gv-ctx__item" + (it.danger ? " gv-ctx__item--danger" : "");
      btn.textContent = it.label;
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        hideCtx();
        it.run();
      });
      ctxEl.appendChild(btn);
    });
    ctxEl.hidden = false;
    // Position, then clamp to viewport.
    ctxEl.style.left = x + "px";
    ctxEl.style.top = y + "px";
    var rect = ctxEl.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (rect.right > vw) ctxEl.style.left = Math.max(4, vw - rect.width - 4) + "px";
    if (rect.bottom > vh) ctxEl.style.top = Math.max(4, vh - rect.height - 4) + "px";
  }

  function ctxForCommit(c, x, y) {
    showCtx(x, y, [
      { label: "Checkout (detached)", run: function () { post("commitAction", { action: "checkout-detached", hash: c.hash }); } },
      { label: "Create branch here…", run: function () { post("createBranchAt", { hash: c.hash }); } },
      { label: "Create tag here…", run: function () { post("createTagAt", { hash: c.hash }); } },
      "-",
      { label: "Cherry-pick", run: function () { post("commitAction", { action: "cherry-pick", hash: c.hash }); } },
      { label: "Revert", run: function () { post("commitAction", { action: "revert", hash: c.hash }); } },
      { label: "Merge into current", run: function () { post("commitAction", { action: "merge-commit", hash: c.hash }); } },
      { label: "Rebase current onto", run: function () { post("commitAction", { action: "rebase-onto", hash: c.hash }); } },
      "-",
      { label: "Reset — soft", run: function () { post("commitAction", { action: "reset-soft", hash: c.hash }); } },
      { label: "Reset — mixed", run: function () { post("commitAction", { action: "reset-mixed", hash: c.hash }); } },
      { label: "Reset — hard", danger: true, run: function () { post("commitAction", { action: "reset-hard", hash: c.hash }); } },
      "-",
      { label: "Copy SHA", run: function () { post("copyText", { text: c.hash }); } },
      { label: "Copy message", run: function () { post("copyText", { text: c.subject || "" }); } },
      { label: "Open patch view", run: function () { post("openCommitPatch", { hash: c.hash }); } },
    ]);
  }

  function ctxForLocalBranch(name, isCurrent, x, y) {
    var items = [];
    if (!isCurrent) items.push({ label: "Checkout", run: function () { post("branchAction", { action: "branch-checkout", branch: name }); } });
    items.push(
      { label: "Merge into current", run: function () { post("branchAction", { action: "branch-merge-into-current", branch: name }); } },
      { label: "Rebase current onto", run: function () { post("branchAction", { action: "branch-rebase-current-onto", branch: name }); } },
      "-",
      { label: "Push to origin", run: function () { post("branchAction", { action: "branch-push", branch: name }); } },
      { label: "Rename…", run: function () { post("renameBranch", { branch: name }); } },
      "-",
      { label: "Delete", danger: true, run: function () { post("branchAction", { action: "branch-delete", branch: name }); } },
      { label: "Force delete", danger: true, run: function () { post("branchAction", { action: "branch-delete-force", branch: name }); } },
      "-",
      { label: "Copy name", run: function () { post("copyText", { text: name }); } }
    );
    showCtx(x, y, items);
  }

  function ctxForRemoteBranch(name, x, y) {
    showCtx(x, y, [
      { label: "Create local branch tracking this", run: function () { post("branchAction", { action: "branch-checkout-remote", branch: name }); } },
      { label: "Fetch", run: function () { post("branchAction", { action: "branch-fetch", branch: name }); } },
      { label: "Merge into current", run: function () { post("branchAction", { action: "branch-merge-into-current", branch: name }); } },
      "-",
      { label: "Delete on remote", danger: true, run: function () { post("branchAction", { action: "branch-delete-remote", branch: name }); } },
      "-",
      { label: "Copy name", run: function () { post("copyText", { text: name }); } },
    ]);
  }

  function ctxForStash(st, x, y) {
    showCtx(x, y, [
      { label: "Apply", run: function () { post("stashAction", { action: "stash-apply", hash: st.ref }); } },
      { label: "Pop", run: function () { post("stashAction", { action: "stash-pop", hash: st.ref }); } },
      { label: "Drop", danger: true, run: function () { post("stashAction", { action: "stash-drop", hash: st.ref }); } },
      "-",
      { label: "Copy ref", run: function () { post("copyText", { text: st.ref }); } },
    ]);
  }

  function post(type, extra) {
    var m = { type: type };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
    vscode.postMessage(m);
  }

  function remoteGroupTitle(remote) {
    var pat = UI.branchGroupRemote || "Remote: {0}";
    return pat.replace("{0}", remote);
  }

  function renderBranchTree(tree) {
    if (!branchTreeRoot || !tree) return;
    branchTreeRoot.textContent = "";
    var cur = tree.current || "";

    function markSelected(btn, revKey) {
      var sel = selectedRev || "";
      var key = revKey || "";
      if (sel === key) btn.classList.add("gv-ref-item__btn--selected");
    }

    function appendHeadRow() {
      var row = document.createElement("div");
      row.className = "gv-ref-node";
      row.setAttribute("role", "none");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gv-ref-item__btn gv-ref-item__btn--head";
      btn.setAttribute("data-rev", "");
      btn.setAttribute("role", "treeitem");
      btn.textContent = UI.branchHeadRow || "HEAD";
      markSelected(btn, "");
      btn.addEventListener("click", function () {
        selectedRev = "";
        saveState();
        requestGraph();
      });
      row.appendChild(btn);
      branchTreeRoot.appendChild(row);
    }

    function appendRefButton(li, classExtra, rev, labelText, onPick) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gv-ref-item__btn " + (classExtra || "");
      btn.setAttribute("data-rev", rev);
      btn.setAttribute("role", "treeitem");
      btn.title = rev;
      var wrap = document.createElement("span");
      wrap.className = "gv-ref-item__label";
      wrap.textContent = labelText;
      btn.appendChild(wrap);
      var isCurrent = cur && cur === rev && cur !== "HEAD";
      if (isCurrent) {
        btn.classList.add("gv-ref-item__btn--current");
        var badge = document.createElement("span");
        badge.className = "gv-ref-badge";
        badge.textContent = "✓";
        btn.appendChild(badge);
      }
      markSelected(btn, rev);
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        onPick();
      });
      li.appendChild(btn);
    }

    function appendLocalFolder(names) {
      if (!names.length) return;
      var det = document.createElement("details");
      det.className = "gv-ref-folder";
      det.open = true;
      var sum = document.createElement("summary");
      sum.className = "gv-ref-folder__summary";
      sum.textContent = UI.branchGroupLocal || "Local";
      det.appendChild(sum);
      var ul = document.createElement("ul");
      ul.className = "gv-ref-folder__list";
      names.forEach(function (name) {
        var li = document.createElement("li");
        li.className = "gv-ref-item";
        appendRefButton(li, "gv-ref-item__btn--local", name, name, function () {
          selectedRev = name;
          saveState();
          requestGraph();
        });
        var btn = li.querySelector("button");
        if (btn) {
          btn.addEventListener("contextmenu", function (ev) {
            ev.preventDefault();
            ctxForLocalBranch(name, name === (tree.current || ""), ev.clientX, ev.clientY);
          });
        }
        ul.appendChild(li);
      });
      det.appendChild(ul);
      branchTreeRoot.appendChild(det);
    }

    function appendRemoteFolder(remote, branches) {
      if (!branches.length) return;
      var det = document.createElement("details");
      det.className = "gv-ref-folder gv-ref-folder--remote";
      var sum = document.createElement("summary");
      sum.className = "gv-ref-folder__summary";
      sum.textContent = remoteGroupTitle(remote);
      det.appendChild(sum);
      var ul = document.createElement("ul");
      ul.className = "gv-ref-folder__list";
      branches.forEach(function (fullName) {
        var li = document.createElement("li");
        li.className = "gv-ref-item";
        var shortLabel = fullName.indexOf("/") >= 0 ? fullName.split("/").slice(1).join("/") : fullName;
        appendRefButton(li, "gv-ref-item__btn--remote", fullName, shortLabel, function () {
          selectedRev = fullName;
          saveState();
          requestGraph();
        });
        var btn = li.querySelector("button");
        if (btn) {
          btn.addEventListener("contextmenu", function (ev) {
            ev.preventDefault();
            ctxForRemoteBranch(fullName, ev.clientX, ev.clientY);
          });
        }
        ul.appendChild(li);
      });
      det.appendChild(ul);
      branchTreeRoot.appendChild(det);
    }

    appendHeadRow();
    appendLocalFolder(tree.locals || []);
    (tree.remotes || []).forEach(function (g) {
      if (!g || !g.branches || !g.branches.length) return;
      appendRemoteFolder(g.remote || "", g.branches);
    });
  }

  applyPathFilter();

  if (searchInput) {
    searchInput.value = query;
    if (btnClearSearch) btnClearSearch.hidden = !query;
  }

  if (btnClearPath) {
    btnClearPath.addEventListener("click", function () {
      pathFilter = "";
      saveState();
      applyPathFilter();
      requestGraph();
    });
  }

  var searchTimer = null;
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      saveState();
      requestGraph();
    }, 280);
  }

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      query = searchInput.value || "";
      if (btnClearSearch) btnClearSearch.hidden = !query;
      scheduleSearch();
    });
    searchInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && query) {
        query = "";
        searchInput.value = "";
        if (btnClearSearch) btnClearSearch.hidden = true;
        saveState();
        requestGraph();
      }
    });
  }
  if (btnClearSearch) {
    btnClearSearch.addEventListener("click", function () {
      query = "";
      if (searchInput) searchInput.value = "";
      btnClearSearch.hidden = true;
      saveState();
      requestGraph();
      if (searchInput) searchInput.focus();
    });
  }

  function requestGraph() {
    var msg = { type: "requestGraph", limit: limit };
    if (selectedRev) msg.rev = selectedRev;
    if (pathFilter) msg.pathFilter = pathFilter;
    if (query) msg.query = query;
    vscode.postMessage(msg);
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "reloadNow") {
      requestGraph();
      return;
    }
    if (d.type === "commitFiles") {
      if (d.hash === currentHash && renderCommitFilesRef) renderCommitFilesRef(d.files || [], "commit");
      return;
    }
    if (d.type === "stashFiles") {
      if (d.ref === currentHash && renderCommitFilesRef) renderCommitFilesRef(d.files || [], "stash");
      return;
    }
    if (d.type === "commitFilesError" || d.type === "stashFilesError") {
      if (d.hash === currentHash || d.ref === currentHash) {
        var l = document.getElementById("files-list");
        if (l) { l.textContent = ""; var el = document.createElement("li"); el.className = "gv-detail-files-empty"; el.textContent = d.message || "Error"; l.appendChild(el); }
      }
      return;
    }
    if (d.type === "setPathFilter") {
      pathFilter = typeof d.path === "string" ? d.path : "";
      saveState();
      applyPathFilter();
      requestGraph();
      return;
    }
    if (d.type === "graphPayload") {
      renderPayload(d.payload);
    }
    if (d.type === "graphError") {
      renderGraphError(d.code, d.message);
    }
  });

  function renderGraphError(code, message) {
    root.innerHTML = "";
    setBranchBarVisible(false);
    if (code === "no-repo") {
      showEmptyCard(UI.emptyNoRepoTitle || "", UI.emptyNoRepoBody || "");
    } else {
      showEmptyCard(UI.emptyErrorTitle || "", message || UI.errorGeneric || "");
    }
    setRepoHeader("", "", "");
  }

  function setRepoHeader(repoAbsPath, branch, viewRev) {
    if (!repoPathEl) return;
    if (!repoAbsPath) {
      repoPathEl.textContent = "";
      repoPathEl.removeAttribute("title");
      if (repoFullEl) {
        repoFullEl.textContent = "";
        repoFullEl.hidden = true;
      }
      return;
    }
    var parts = repoAbsPath.replace(/\\\\/g, "/").split("/").filter(Boolean);
    var base = parts.length ? parts[parts.length - 1] : repoAbsPath;
    var vr = viewRev || "";
    var br = branch || "";
    var line = base;
    if (vr) line = line + " · " + vr;
    else if (br) line = line + " · " + br;
    repoPathEl.textContent = line;
    repoPathEl.title = repoAbsPath;
    if (repoFullEl) {
      repoFullEl.textContent = repoAbsPath;
      repoFullEl.hidden = false;
    }
  }

  function renderPayload(payload) {
    if (!payload) return;
    setBranchBarVisible(true);
    renderBranchTree(payload.branchTree || { current: "", locals: [], remotes: [] });
    setRepoHeader(payload.repoRoot || "", payload.branch || "", payload.viewRev || "");

    // Clean up any previous virtual-scroll handler before re-rendering.
    var prevCanvas = root.parentElement;
    if (scrollHandlerRef.fn && prevCanvas) {
      prevCanvas.removeEventListener("scroll", scrollHandlerRef.fn);
      scrollHandlerRef.fn = null;
    }

    var commits = payload.commits || [];
    if (!commits.length) {
      root.innerHTML = "";
      showEmptyCard(UI.emptyNoCommitsTitle || "", UI.emptyNoCommitsBody || "");
      detail.classList.add("gv-detail--empty");
      return;
    }

    hideEmptyCard();

    root.innerHTML = "";
    detail.classList.add("gv-detail--empty");
    var hint = UI.detailHint || "";
    detail.innerHTML = "<p class=\\"gv-detail-hint\\">" + esc(hint) + "</p>";

    var LANE_PALETTE = [
      "#6cb6ff", "#f0883e", "#a5d6a7", "#d2a8ff", "#ffb86c",
      "#7ee787", "#ff7b72", "#79c0ff", "#e6a4d4", "#f1c40f",
      "#56d4dd", "#bc8cff"
    ];
    function laneColor(idx) {
      return LANE_PALETTE[idx % LANE_PALETTE.length];
    }

    function formatTime(sec) {
      if (!sec) return "";
      var diff = Math.floor(Date.now() / 1000 - sec);
      if (diff < 60) return "just now";
      if (diff < 3600) return Math.floor(diff / 60) + "m ago";
      if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
      if (diff < 86400 * 30) return Math.floor(diff / 86400) + "d ago";
      if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + "mo ago";
      return Math.floor(diff / (86400 * 365)) + "y ago";
    }

    function formatTimeFull(sec) {
      if (!sec) return "";
      return new Date(sec * 1000).toLocaleString();
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    }

    function showDetail(c) {
      detail.classList.remove("gv-detail--empty");
      detail.innerHTML =
        "<header class=\\"gv-detail-head2\\">" +
          "<div class=\\"gv-detail-subject2\\">" + esc(c.subject) + "</div>" +
          "<div class=\\"gv-detail-sub\\">" +
            "<code class=\\"gv-hash\\">" + esc(c.hash.slice(0, 7)) + "</code>" +
            "<span class=\\"gv-author\\">" + esc(c.author) + "</span>" +
            "<span class=\\"gv-time\\">" + esc(formatTimeFull(c.dateSec)) + "</span>" +
          "</div>" +
        "</header>" +
        "<div class=\\"gv-detail-files-head\\">" +
          "<span class=\\"gv-detail-files-label\\">" + esc(UI.filesLabel || "Files") + "</span>" +
          "<button type=\\"button\\" class=\\"gv-detail-patch-btn\\" id=\\"btn-show-patch\\" title=\\"" + esc(UI.openGitShow || "") + "\\">" + esc(UI.openPatchShort || "Patch") + "</button>" +
        "</div>" +
        "<ul class=\\"gv-detail-files\\" id=\\"files-list\\">" +
          "<li class=\\"gv-detail-files-loading\\">" + esc(UI.loading || "Loading…") + "</li>" +
        "</ul>";
      var p = document.getElementById("btn-show-patch");
      if (p) {
        p.addEventListener("click", function () {
          vscode.postMessage({ type: "openCommitPatch", hash: c.hash });
        });
      }
      currentHash = c.hash;
      // Clear stash selection if any.
      document.querySelectorAll(".gv-virtual-row--selected").forEach(function (el) {
        el.classList.remove("gv-virtual-row--selected");
      });
      vscode.postMessage({ type: "requestCommitFiles", hash: c.hash });
    }

    renderCommitFilesRef = renderCommitFiles;
    function renderCommitFiles(files, mode) {
      var list = document.getElementById("files-list");
      if (!list) return;
      list.textContent = "";
      if (!files || !files.length) {
        var li = document.createElement("li");
        li.className = "gv-detail-files-empty";
        li.textContent = UI.noFiles || "No files changed.";
        list.appendChild(li);
        return;
      }
      files.forEach(function (f) {
        var item = document.createElement("li");
        item.className = "gv-file-row gv-file-row--" + (f.status || "M");
        var badge = document.createElement("span");
        badge.className = "gv-file-badge";
        badge.textContent = f.status || "M";
        var pathEl = document.createElement("span");
        pathEl.className = "gv-file-path";
        if (f.status === "R" && f.oldPath) {
          pathEl.textContent = f.oldPath + "  →  " + f.path;
          pathEl.title = f.oldPath + " → " + f.path;
        } else {
          pathEl.textContent = f.path;
          pathEl.title = f.path;
        }
        var stat = document.createElement("span");
        stat.className = "gv-file-stat";
        if (f.insertions || f.deletions) {
          var ins = document.createElement("span");
          ins.className = "gv-file-stat__ins";
          ins.textContent = "+" + f.insertions;
          var del = document.createElement("span");
          del.className = "gv-file-stat__del";
          del.textContent = "−" + f.deletions;
          stat.appendChild(ins);
          stat.appendChild(del);
        }
        item.appendChild(badge);
        item.appendChild(pathEl);
        item.appendChild(stat);
        item.addEventListener("click", function () {
          if (mode === "stash") {
            vscode.postMessage({
              type: "openStashFileDiff",
              hash: currentHash,
              path: f.path,
              oldPath: f.oldPath || "",
            });
          } else {
            vscode.postMessage({
              type: "openFileDiff",
              hash: currentHash,
              path: f.path,
              oldPath: f.oldPath || "",
              status: f.status || "M",
            });
          }
        });
        list.appendChild(item);
      });
    }

    // Lane layout
    var ROW_H = 30;
    var LANE_W = 14;
    var NODE_R = 5;
    var SIDE_PAD = 10;
    var MAX_GRAPH_W = 220; // cap so commit text never gets pushed off-screen

    var layout = computeLaneLayout(commits);
    var totalLanes = layout.totalLanes;
    var naturalGraphW = SIDE_PAD * 2 + Math.max(1, totalLanes) * LANE_W;
    var graphWidth = Math.min(naturalGraphW, MAX_GRAPH_W);
    var commitIndex = {};
    commits.forEach(function (c, i) { commitIndex[c.hash] = i; });

    // Virtual rows: working changes (if any) + stashes
    var working = payload.working || { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
    var stashes = payload.stashes || [];
    var hasWorking = (working.staged + working.modified + working.untracked + working.conflicted) > 0;
    var virtualRowCount = (hasWorking ? 1 : 0) + stashes.length;
    var graphOffset = virtualRowCount * ROW_H;

    var svg = document.getElementById("graph-svg");
    if (svg) {
      svg.setAttribute("width", String(graphWidth));
      svg.setAttribute("height", String(commits.length * ROW_H));
      svg.style.width = graphWidth + "px";
      svg.style.height = (commits.length * ROW_H) + "px";
      svg.style.top = graphOffset + "px";
      svg.textContent = "";
      drawGraph(svg, commits, layout, commitIndex, {
        rowH: ROW_H, laneW: LANE_W, nodeR: NODE_R, sidePad: SIDE_PAD
      });
    }

    var canvas = root.parentElement;
    if (canvas) canvas.style.setProperty("--gv-graph-w", graphWidth + "px");

    // Render virtual rows BEFORE commit rows.
    if (hasWorking) {
      var wrow = renderVirtualRow({
        kind: "working",
        title: UI.workingChanges || "Working changes",
        sub: formatWorkingSummary(working),
        height: ROW_H,
        graphWidth: graphWidth,
        onClick: function () { vscode.postMessage({ type: "focusScm" }); }
      });
      root.appendChild(wrow);
    }
    for (var si = 0; si < stashes.length; si++) {
      (function (st) {
        var srow = renderVirtualRow({
          kind: "stash",
          title: st.ref,
          sub: st.subject,
          height: ROW_H,
          graphWidth: graphWidth,
          onClick: function () {
            document.querySelectorAll(".gv-unified-row, .gv-virtual-row").forEach(function (el) {
              el.classList.remove("gv-unified-row--selected", "gv-virtual-row--selected");
            });
            srow.classList.add("gv-virtual-row--selected");
            currentHash = st.ref;
            showStashDetail(st);
            vscode.postMessage({ type: "requestStashFiles", hash: st.ref });
          }
        });
        srow.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          ctxForStash(st, ev.clientX, ev.clientY);
        });
        root.appendChild(srow);
      })(stashes[si]);
    }

    // Virtualized commit list container: top spacer + visible rows + bottom spacer.
    var commitList = document.createElement("div");
    commitList.className = "gv-commit-list-inner";
    root.appendChild(commitList);
    var topSpacer = document.createElement("div");
    topSpacer.className = "gv-spacer";
    commitList.appendChild(topSpacer);
    var bottomSpacer = document.createElement("div");
    bottomSpacer.className = "gv-spacer";
    commitList.appendChild(bottomSpacer);

    var renderedRows = {}; // index → element
    var canvas = root.parentElement;

    function buildCommitRow(i) {
      var c = commits[i];
      var lp = layout.perRow[i];
      var color = laneColor(lp.lane);

      var row = document.createElement("div");
      row.className = "gv-unified-row gv-commit-log-row gv-row-click";
      row.setAttribute("role", "button");
      row.dataset.hash = c.hash;
      row.style.height = ROW_H + "px";
      row.style.minHeight = ROW_H + "px";
      row.style.paddingLeft = graphWidth + "px";
      if (c.hash === currentHash) row.classList.add("gv-unified-row--selected");

      var commitCell = document.createElement("div");
      commitCell.className = "gv-unified-commit";

      var leftCol = document.createElement("div");
      leftCol.className = "gv-row-left";
      var refs = c.refs || [];
      for (var ri = 0; ri < refs.length; ri++) {
        var r = refs[ri];
        var chip = document.createElement("span");
        chip.className = "gv-ref-chip gv-ref-chip--" + r.kind;
        chip.textContent = r.label;
        chip.title = r.kind + ": " + r.label;
        leftCol.appendChild(chip);
      }
      var subj = document.createElement("span");
      subj.className = "gv-unified-subject gv-subject";
      subj.textContent = c.subject;
      subj.title = c.subject;
      leftCol.appendChild(subj);

      var rightCol = document.createElement("div");
      rightCol.className = "gv-row-right";
      var author = document.createElement("span");
      author.className = "gv-author";
      author.textContent = c.author;
      author.title = c.author;
      var when = document.createElement("span");
      when.className = "gv-time";
      when.textContent = formatTime(c.dateSec);
      when.title = formatTimeFull(c.dateSec);
      var shortHash = document.createElement("code");
      shortHash.className = "gv-hash";
      shortHash.style.setProperty("--gv-hash-color", color);
      shortHash.textContent = c.hash.slice(0, 7);
      rightCol.appendChild(author);
      rightCol.appendChild(when);
      rightCol.appendChild(shortHash);

      commitCell.appendChild(leftCol);
      commitCell.appendChild(rightCol);
      row.appendChild(commitCell);

      row.addEventListener("click", function () {
        Object.keys(renderedRows).forEach(function (k) {
          renderedRows[k].classList.remove("gv-unified-row--selected");
        });
        row.classList.add("gv-unified-row--selected");
        highlightNode(svg, lp.lane, i, ROW_H, LANE_W, NODE_R, SIDE_PAD);
        showDetail(c);
      });
      row.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        ctxForCommit(c, ev.clientX, ev.clientY);
      });
      return row;
    }

    var BUFFER = 8;
    function updateVisible() {
      if (!canvas) return;
      var scrollTop = canvas.scrollTop;
      var viewH = canvas.clientHeight || (commits.length * ROW_H);
      var visStart = Math.max(0, Math.floor((scrollTop - graphOffset) / ROW_H) - BUFFER);
      var visEnd = Math.min(commits.length - 1,
        Math.ceil((scrollTop + viewH - graphOffset) / ROW_H) + BUFFER);
      if (visEnd < visStart) { visStart = 0; visEnd = Math.min(commits.length - 1, BUFFER * 2); }

      // Drop out-of-range rows.
      var keep = {};
      for (var i = visStart; i <= visEnd; i++) keep[i] = true;
      Object.keys(renderedRows).forEach(function (k) {
        if (!keep[k]) {
          commitList.removeChild(renderedRows[k]);
          delete renderedRows[k];
        }
      });
      // Resize spacers.
      topSpacer.style.height = (visStart * ROW_H) + "px";
      bottomSpacer.style.height = ((commits.length - 1 - visEnd) * ROW_H) + "px";
      // Add missing rows in order, inserting before bottomSpacer.
      for (var j = visStart; j <= visEnd; j++) {
        if (!renderedRows[j]) {
          var el = buildCommitRow(j);
          renderedRows[j] = el;
          commitList.insertBefore(el, bottomSpacer);
        }
      }
      // Ensure DOM order matches index order (insertBefore handles new ones,
      // but rendering on the way back from far scroll might leave gaps — reorder if needed).
      var orderedIdx = Object.keys(renderedRows).map(Number).sort(function (a, b) { return a - b; });
      var anchor = bottomSpacer;
      for (var k = orderedIdx.length - 1; k >= 0; k--) {
        var node = renderedRows[orderedIdx[k]];
        if (node.nextSibling !== anchor) commitList.insertBefore(node, anchor);
        anchor = node;
      }
    }

    var rafScheduled = false;
    var onScroll = function () {
      if (rafScheduled) return;
      rafScheduled = true;
      window.requestAnimationFrame(function () {
        rafScheduled = false;
        updateVisible();
      });
    };
    scrollHandlerRef.fn = onScroll;
    if (canvas) canvas.addEventListener("scroll", onScroll, { passive: true });
    updateVisible();
  }

  function renderVirtualRow(opts) {
    var row = document.createElement("div");
    row.className = "gv-virtual-row gv-virtual-row--" + opts.kind;
    row.style.height = opts.height + "px";
    row.style.minHeight = opts.height + "px";
    row.style.paddingLeft = opts.graphWidth + "px";
    var dot = document.createElement("span");
    dot.className = "gv-virtual-dot";
    row.appendChild(dot);
    var body = document.createElement("div");
    body.className = "gv-virtual-body";
    var title = document.createElement("span");
    title.className = "gv-virtual-title";
    title.textContent = opts.title;
    body.appendChild(title);
    if (opts.sub) {
      var sub = document.createElement("span");
      sub.className = "gv-virtual-sub";
      sub.textContent = opts.sub;
      body.appendChild(sub);
    }
    row.appendChild(body);
    if (opts.onClick) row.addEventListener("click", opts.onClick);
    return row;
  }

  function formatWorkingSummary(w) {
    var parts = [];
    if (w.staged) parts.push(w.staged + " staged");
    if (w.modified) parts.push(w.modified + " modified");
    if (w.untracked) parts.push(w.untracked + " untracked");
    if (w.conflicted) parts.push(w.conflicted + " conflicted");
    return parts.join("  ·  ");
  }

  function showStashDetail(st) {
    if (!detail) return;
    detail.classList.remove("gv-detail--empty");
    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    }
    detail.innerHTML =
      "<header class=\\"gv-detail-head2\\">" +
        "<div class=\\"gv-detail-subject2\\">" + esc(st.subject || "(stash)") + "</div>" +
        "<div class=\\"gv-detail-sub\\">" +
          "<code class=\\"gv-hash\\">" + esc(st.ref) + "</code>" +
          "<span class=\\"gv-author\\">on " + esc(st.parentShort || "") + "</span>" +
        "</div>" +
      "</header>" +
      "<div class=\\"gv-detail-files-head\\">" +
        "<span class=\\"gv-detail-files-label\\">Files</span>" +
      "</div>" +
      "<ul class=\\"gv-detail-files\\" id=\\"files-list\\">" +
        "<li class=\\"gv-detail-files-loading\\">Loading…</li>" +
      "</ul>";
  }

  function highlightNode(svg, lane, rowIdx, ROW_H, LANE_W, NODE_R, PAD) {
    if (!svg) return;
    var prev = svg.querySelector(".gv-node-selected");
    if (prev) prev.parentNode.removeChild(prev);
    var SVG_NS = "http://www.w3.org/2000/svg";
    var ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("class", "gv-node-selected");
    ring.setAttribute("cx", String(PAD + lane * LANE_W + LANE_W / 2));
    ring.setAttribute("cy", String(rowIdx * ROW_H + ROW_H / 2));
    ring.setAttribute("r", String(NODE_R + 5));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "var(--vscode-focusBorder)");
    ring.setAttribute("stroke-width", "2");
    svg.appendChild(ring);
  }

  function computeLaneLayout(commits) {
    var lanes = [];
    var perRow = [];
    var maxLanes = 0;
    function emptySlot() {
      for (var i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
      lanes.push(null);
      return lanes.length - 1;
    }
    for (var i = 0; i < commits.length; i++) {
      var c = commits[i];
      var before = lanes.slice();
      var myLane = lanes.indexOf(c.hash);
      if (myLane === -1) myLane = emptySlot();
      lanes[myLane] = null;
      var parentLanes = [];
      var parents = c.parents || [];
      for (var p = 0; p < parents.length; p++) {
        var par = parents[p];
        if (p === 0) {
          lanes[myLane] = par;
          parentLanes.push(myLane);
        } else {
          var existing = lanes.indexOf(par);
          if (existing === -1) {
            var ns = emptySlot();
            lanes[ns] = par;
            parentLanes.push(ns);
          } else {
            parentLanes.push(existing);
          }
        }
      }
      // Compact trailing nulls so lane count stays minimal.
      while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
      var after = lanes.slice();
      perRow.push({ lane: myLane, before: before, after: after, parentLanes: parentLanes });
      if (before.length > maxLanes) maxLanes = before.length;
      if (after.length > maxLanes) maxLanes = after.length;
      if (myLane + 1 > maxLanes) maxLanes = myLane + 1;
    }
    return { perRow: perRow, totalLanes: maxLanes };
  }

  function drawGraph(svg, commits, layout, commitIndex, opts) {
    var SVG_NS = "http://www.w3.org/2000/svg";
    var ROW_H = opts.rowH, LANE_W = opts.laneW, NODE_R = opts.nodeR, PAD = opts.sidePad;
    function laneX(idx) { return PAD + idx * LANE_W + LANE_W / 2; }
    function rowY(idx) { return idx * ROW_H + ROW_H / 2; }

    function pathCurve(x1, y1, x2, y2) {
      if (x1 === x2) return "M " + x1 + " " + y1 + " L " + x2 + " " + y2;
      var midY = (y1 + y2) / 2;
      return "M " + x1 + " " + y1 +
        " C " + x1 + " " + midY + ", " + x2 + " " + midY + ", " + x2 + " " + y2;
    }

    function addPath(d, color, opacity, dashed) {
      var p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("stroke", color);
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("fill", "none");
      if (opacity != null) p.setAttribute("opacity", String(opacity));
      if (dashed) p.setAttribute("stroke-dasharray", "3 4");
      svg.appendChild(p);
    }

    var LANE_PALETTE = [
      "#6cb6ff", "#f0883e", "#a5d6a7", "#d2a8ff", "#ffb86c",
      "#7ee787", "#ff7b72", "#79c0ff", "#e6a4d4", "#f1c40f",
      "#56d4dd", "#bc8cff"
    ];
    function lc(i) { return LANE_PALETTE[i % LANE_PALETTE.length]; }

    // 1) Passthrough lanes (lanes alive both above and below this row, not the commit itself).
    for (var i = 0; i < commits.length; i++) {
      var lp = layout.perRow[i];
      var before = lp.before;
      var after = lp.after;
      var cy = rowY(i);
      for (var L = 0; L < before.length; L++) {
        var hash = before[L];
        if (!hash) continue;
        if (hash === commits[i].hash) continue;
        // Find this same hash in after — usually same lane.
        var newL = after.indexOf(hash);
        if (newL === -1) continue;
        var x1 = laneX(L), x2 = laneX(newL);
        addPath(pathCurve(x1, cy - ROW_H / 2, x2, cy + ROW_H / 2), lc(newL), 0.85);
      }
    }

    // 2) Outgoing edges from each commit node to its parents.
    for (var i2 = 0; i2 < commits.length; i2++) {
      var c = commits[i2];
      var lp2 = layout.perRow[i2];
      var cx = laneX(lp2.lane);
      var cy2 = rowY(i2);
      var parents = c.parents || [];
      for (var pi = 0; pi < parents.length; pi++) {
        var par = parents[pi];
        var pLane = lp2.parentLanes[pi];
        if (pLane == null) continue;
        var px = laneX(pLane);
        var parentRow = commitIndex[par];
        if (parentRow == null) {
          // Parent outside the window — draw fading line off the bottom.
          var endY = (commits.length) * ROW_H + ROW_H / 2;
          addPath(pathCurve(cx, cy2, px, cy2 + ROW_H / 2) +
            " M " + px + " " + (cy2 + ROW_H / 2) + " L " + px + " " + endY, lc(pLane), 0.6, true);
        } else {
          // Draw down to next row at parent's lane (passthrough handles rest).
          addPath(pathCurve(cx, cy2, px, cy2 + ROW_H / 2), lc(pLane), 0.95);
        }
      }
    }

    // 3) Node circles on top.
    for (var i3 = 0; i3 < commits.length; i3++) {
      var lp3 = layout.perRow[i3];
      var color = lc(lp3.lane);
      var ncx = laneX(lp3.lane), ncy = rowY(i3);
      var halo = document.createElementNS(SVG_NS, "circle");
      halo.setAttribute("cx", String(ncx));
      halo.setAttribute("cy", String(ncy));
      halo.setAttribute("r", String(NODE_R + 3));
      halo.setAttribute("fill", color);
      halo.setAttribute("opacity", "0.18");
      svg.appendChild(halo);
      var dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(ncx));
      dot.setAttribute("cy", String(ncy));
      dot.setAttribute("r", String(NODE_R));
      dot.setAttribute("fill", color);
      dot.setAttribute("stroke", "var(--vscode-editor-background)");
      dot.setAttribute("stroke-width", "2");
      svg.appendChild(dot);
    }
  }

  requestGraph();
})();
`.trim();
}
