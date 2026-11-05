// Entry point: owns view state, wires the toolbar and routes extension-host messages to components.
// Data flow is one-way: user input → state change → requestGraph → host → graphPayload → render.
(function (GV) {
  "use strict";
  var u = GV.util;
  var vscode = acquireVsCodeApi();
  var UI = window.__GV_UI__ || {};
  var $ = function (id) { return document.getElementById(id); };
  if (!$("graph-root") || !$("commit-detail") || !$("graph-workspace") || !$("empty-state")) return;

  // Paging: ask for PAGE commits, then PAGE more each time the list is scrolled near its end.
  var PAGE = 200;
  var saved = vscode.getState() || {};
  function savedString(key) { return typeof saved[key] === "string" ? saved[key] : ""; }

  var S = {
    selectedRev: savedString("selectedRev"),
    pathFilter: savedString("pathFilter"),
    query: savedString("query"),
    mergesMode: saved.mergesMode === "hide" || saved.mergesMode === "only" ? saved.mergesMode : "all",
    markedHash: savedString("markedHash"),
    compareTarget: "", // when set, the files list shows markedHash … compareTarget
    currentHash: "",   // commit / stash ref open in the detail pane
    limit: PAGE,
    hasMore: false,
    loadingMore: false,
    repoList: [],
    selectedRepo: "",
    fileView: (window.__GV_PREFS__ || {}).fileView === "tree" ? "tree" : "list", // changed-files pane: flat list or folder tree
  };

  function saveState() {
    vscode.setState({
      selectedRev: S.selectedRev,
      pathFilter: S.pathFilter,
      query: S.query,
      mergesMode: S.mergesMode,
      markedHash: S.markedHash,
    });
  }

  function post(type, extra) {
    var m = { type: type };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
    vscode.postMessage(m);
  }

  // keepLimit: true for auto-refresh and paging (keep what is loaded); a new search/filter starts from PAGE again.
  function requestGraph(keepLimit) {
    if (!keepLimit) S.limit = PAGE;
    var msg = { limit: S.limit };
    if (S.selectedRev) msg.rev = S.selectedRev;
    if (S.pathFilter) msg.pathFilter = S.pathFilter;
    if (S.query) msg.query = S.query;
    if (S.mergesMode !== "all") msg.mergesMode = S.mergesMode;
    post("requestGraph", msg);
  }

  function loadMore() {
    if (!S.hasMore || S.loadingMore) return;
    S.loadingMore = true;
    S.limit += PAGE;
    requestGraph(true);
  }

  /** Save, then re-query — the common tail of every filter change. */
  function commitFilterChange() {
    saveState();
    requestGraph();
  }

  var app = { UI: UI, state: S, post: post, saveState: saveState, requestGraph: requestGraph, loadMore: loadMore, actions: {} };
  var detailPane = GV.createDetailPane(app);
  var rebaseEditor = GV.createRebaseEditor(app, detailPane);
  var menus = GV.createMenus(app);
  var branchTree = GV.createBranchTree(app, menus);
  var commitList = GV.createCommitList(app, detailPane, menus);

  // ---- Toolbar chips & banners ------------------------------------------------------------

  function applyMergesUi() {
    $("btn-hide-merges").setAttribute("aria-pressed", S.mergesMode === "hide" ? "true" : "false");
    $("btn-only-merges").setAttribute("aria-pressed", S.mergesMode === "only" ? "true" : "false");
  }

  function applyPathFilter() {
    var label = $("path-filter-label");
    label.textContent = S.pathFilter;
    if (S.pathFilter) label.title = S.pathFilter;
    u.setHidden($("path-filter"), !S.pathFilter);
  }

  function applyCompareChip() {
    if (S.markedHash) {
      $("compare-chip-label").textContent = (UI.comparingLabel || "Comparing") + " " + S.markedHash.slice(0, 7);
    }
    u.setHidden($("compare-chip"), !S.markedHash);
    commitList.refreshMarks();
  }

  function showRevNotice(missingRev) {
    var tmpl = UI.revMissingNotice || "“{0}” no longer exists — showing the default history instead.";
    $("rev-notice-text").textContent = tmpl.replace("{0}", missingRev);
    u.setHidden($("rev-notice"), false);
  }

  function hideRevNotice() {
    u.setHidden($("rev-notice"), true);
  }

  function showEmptyCard(title, body) {
    $("empty-title").textContent = title || "";
    $("empty-body").textContent = body || "";
    u.setHidden($("empty-state"), false);
    u.setHidden($("graph-workspace"), true);
    u.setHidden(detailPane.el, true);
  }

  function hideEmptyCard() {
    u.setHidden($("empty-state"), true);
    u.setHidden($("graph-workspace"), false);
    u.setHidden(detailPane.el, false);
  }

  // ---- Repo header & picker ---------------------------------------------------------------

  function setRepoHeader(repoAbsPath, branch, viewRev) {
    var badge = $("repo-path");
    var full = $("repo-full");
    if (!repoAbsPath) {
      badge.textContent = "";
      badge.removeAttribute("title");
      full.textContent = "";
      full.hidden = true;
      return;
    }
    var suffix = viewRev || branch || "";
    var line = u.baseName(repoAbsPath) + (suffix ? " · " + suffix : "");
    var multi = S.repoList.length > 1;
    badge.textContent = multi ? line + " ▾" : line;
    badge.title = repoAbsPath;
    badge.classList.toggle("gv-repo-badge--picker", multi);
    full.textContent = repoAbsPath;
    full.hidden = false;
  }

  function closeRepoMenu() {
    $("repo-menu").hidden = true;
    $("repo-path").setAttribute("aria-expanded", "false");
  }

  function repoMenuItem(repoPath) {
    var active = repoPath === S.selectedRepo;
    var item = u.el("button", "gv-repo-menu__item" + (active ? " gv-repo-menu__item--active" : ""),
      (active ? "✓ " : "  ") + u.baseName(repoPath));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.title = repoPath;
    item.addEventListener("click", function (ev) {
      ev.stopPropagation();
      closeRepoMenu();
      if (!active) post("selectRepo", { root: repoPath });
    });
    return item;
  }

  function toggleRepoMenu() {
    var menu = $("repo-menu");
    if (S.repoList.length < 2) return;
    if (!menu.hidden) {
      closeRepoMenu();
      return;
    }
    menu.textContent = "";
    S.repoList.forEach(function (p) { menu.appendChild(repoMenuItem(p)); });
    menu.hidden = false;
    $("repo-path").setAttribute("aria-expanded", "true");
  }

  function renderSync(sync) {
    var counts = $("sync-counts");
    var btnPush = $("btn-push");
    var s = sync || { upstream: null, ahead: 0, behind: 0 };
    $("btn-pull").disabled = !s.upstream;
    if (!s.upstream) {
      counts.hidden = true;
      counts.textContent = "";
      btnPush.title = UI.publishTitle || "Publish";
      return;
    }
    btnPush.title = (UI.pushTitle || "Push") + " → " + s.upstream;
    var txt = (s.ahead > 0 ? " ↑" + s.ahead : "") + (s.behind > 0 ? " ↓" + s.behind : "");
    counts.textContent = txt;
    counts.hidden = !txt;
    if (txt) counts.title = UI.aheadBehindTitle || "";
  }

  // ---- Actions other components call ------------------------------------------------------

  app.actions.setMarked = function (hash) {
    S.markedHash = hash;
    if (!hash) S.compareTarget = "";
    saveState();
    applyCompareChip();
  };
  app.actions.compareWithMarked = function (hash) {
    S.compareTarget = hash;
    S.currentHash = hash;
    detailPane.showCompare(S.markedHash, hash);
    post("requestCompareFiles", { a: S.markedHash, b: hash });
  };
  app.actions.startRebase = rebaseEditor.start;

  // ---- Rendering the host's payload ---------------------------------------------------------

  /** The selected rev no longer resolves; the host fell back to the default log. Drop it and say so. */
  function applyRevMissing(missing) {
    if (!missing) {
      hideRevNotice();
      return;
    }
    if (S.selectedRev === missing) {
      S.selectedRev = "";
      saveState();
    }
    showRevNotice(missing);
  }

  function reopenCurrentCommit(commits) {
    if (!S.currentHash) return;
    for (var i = 0; i < commits.length; i++) {
      if (commits[i].hash === S.currentHash) {
        detailPane.showCommit(commits[i]);
        return;
      }
    }
  }

  function renderPayload(payload) {
    if (!payload) return;
    applyRevMissing(payload.revMissing);
    u.setHidden($("rebase-banner"), !payload.rebaseInProgress);
    u.setHidden($("branch-bar"), false);
    branchTree.render(payload.branchTree || { current: "", locals: [], remotes: [] });
    S.repoList = Array.isArray(payload.repos) ? payload.repos : [];
    S.selectedRepo = payload.selectedRepo || payload.repoRoot || "";
    setRepoHeader(payload.repoRoot || "", payload.branch || "", payload.viewRev || "");
    renderSync(payload.sync);

    var commits = payload.commits || [];
    S.hasMore = commits.length >= S.limit;
    S.loadingMore = false;
    detailPane.showHint();
    if (!commitList.render(payload)) {
      showEmptyCard(UI.emptyNoCommitsTitle || "", UI.emptyNoCommitsBody || "");
      return;
    }
    hideEmptyCard();
    // A re-render (auto-refresh, next page) keeps the commit the user was looking at open.
    reopenCurrentCommit(commits);
  }

  function renderGraphError(code, message) {
    commitList.clear();
    hideRevNotice();
    u.setHidden($("rebase-banner"), true);
    u.setHidden($("branch-bar"), true);
    if (code === "no-repo") showEmptyCard(UI.emptyNoRepoTitle || "", UI.emptyNoRepoBody || "");
    else showEmptyCard(UI.emptyErrorTitle || "", message || UI.errorGeneric || "");
    setRepoHeader("", "", "");
  }

  // ---- Host → webview messages ------------------------------------------------------------

  var handlers = {
    reloadNow: function () { requestGraph(true); },
    graphPayload: function (d) { renderPayload(d.payload); },
    graphError: function (d) { renderGraphError(d.code, d.message); },
    commitFiles: function (d) { if (d.hash === S.currentHash) detailPane.renderFiles(d.files || [], "commit"); },
    stashFiles: function (d) { if (d.ref === S.currentHash) detailPane.renderFiles(d.files || [], "stash"); },
    compareFiles: function (d) {
      if (d.a === S.markedHash && d.b === S.compareTarget) detailPane.renderFiles(d.files || [], "compare");
    },
    compareFilesError: function (d) { detailPane.showFilesError(d.message); },
    commitFilesError: filesError,
    stashFilesError: filesError,
    rebaseCommits: function (d) { rebaseEditor.setCommits(d.commits); },
    rebaseError: function (d) { rebaseEditor.showError(d.message); },
    rebaseDone: function () { rebaseEditor.close(); },
    setPathFilter: function (d) {
      S.pathFilter = typeof d.path === "string" ? d.path : "";
      applyPathFilter();
      commitFilterChange();
    },
  };

  function filesError(d) {
    if (d.hash === S.currentHash || d.ref === S.currentHash) detailPane.showFilesError(d.message);
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    var h = Object.prototype.hasOwnProperty.call(handlers, d.type) ? handlers[d.type] : null;
    if (h) h(d);
  });

  // ---- Toolbar wiring ---------------------------------------------------------------------

  function onClick(id, fn) {
    var b = $(id);
    if (b) b.addEventListener("click", fn);
  }

  var searchInput = $("search-input");
  var btnClearSearch = $("btn-clear-search");
  var searchTimer = null;

  function setQuery(q) {
    S.query = q;
    btnClearSearch.hidden = !q;
  }

  searchInput.value = S.query;
  btnClearSearch.hidden = !S.query;
  searchInput.addEventListener("input", function () {
    setQuery(searchInput.value || "");
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(commitFilterChange, 280);
  });
  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape" || !S.query) return;
    searchInput.value = "";
    setQuery("");
    commitFilterChange();
  });
  onClick("btn-clear-search", function () {
    searchInput.value = "";
    setQuery("");
    commitFilterChange();
    searchInput.focus();
  });

  onClick("btn-clear-path", function () {
    S.pathFilter = "";
    applyPathFilter();
    commitFilterChange();
  });

  function toggleMerges(mode) {
    S.mergesMode = S.mergesMode === mode ? "all" : mode;
    applyMergesUi();
    commitFilterChange();
  }
  onClick("btn-hide-merges", function () { toggleMerges("hide"); });
  onClick("btn-only-merges", function () { toggleMerges("only"); });
  onClick("btn-exit-compare", function () { app.actions.setMarked(""); });
  onClick("btn-dismiss-notice", hideRevNotice);

  onClick("btn-pull", function () { post("runSync", { op: "pull" }); });
  onClick("btn-push", function () { post("runSync", { op: "push" }); });
  onClick("btn-fetch", function () { post("runSync", { op: "fetch" }); });

  onClick("btn-rebase-continue", function () { post("continueRebase", {}); });
  onClick("btn-rebase-skip", function () { post("skipRebase", {}); });
  onClick("btn-rebase-abort2", function () { post("abortRebase", {}); });

  $("repo-path").addEventListener("click", function (ev) {
    ev.stopPropagation();
    toggleRepoMenu();
  });
  document.addEventListener("click", closeRepoMenu);

  applyPathFilter();
  applyMergesUi();
  applyCompareChip();
  requestGraph();
})(window.GV = window.GV || {});
