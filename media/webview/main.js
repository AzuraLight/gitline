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
  function stringList(v) { return Array.isArray(v) ? v.filter(function (s) { return typeof s === "string" && s; }) : null; }

  /**
   * The view to open with: the host's setting when the user set one, otherwise what this webview
   * saved last time — including the pre-1.5 single `selectedRev`.
   */
  function openingRevs() {
    var fromSettings = stringList((window.__GV_PREFS__ || {}).openingRevs);
    if (fromSettings) return fromSettings;
    var savedList = stringList(saved.selectedRevs);
    if (savedList) return savedList;
    var legacy = savedString("selectedRev");
    return legacy ? [legacy] : [];
  }

  var S = {
    // [] = HEAD's log, [GV.ALL_REFS] = all branches, otherwise branch names / patterns.
    selectedRevs: openingRevs(),
    viewRefs: [],      // full refs the host resolved for a multi-branch / pattern selection
    currentBranch: "", // checked-out branch, for Ctrl/Cmd+click starting from HEAD's log
    layout: saved.layout, // pane widths and collapsed panes; layout.js validates it
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
    repoItems: [],     // { path, name, detail, group: "workspace" | "recent" } for the picker
    selectedRepo: "",
    fileView: (window.__GV_PREFS__ || {}).fileView === "tree" ? "tree" : "list", // changed-files pane: flat list or folder tree
  };

  function saveState() {
    vscode.setState({
      selectedRevs: S.selectedRevs,
      layout: S.layout,
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
    if (S.selectedRevs.length) msg.revs = S.selectedRevs.slice();
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
  GV.createLayout(app);

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

  /** isList: several names / patterns matched nothing (vs. one clicked branch that was deleted). */
  function showRevNotice(missingRev, isList) {
    var tmpl = isList
      ? UI.revNoMatchNotice || "No branch matches {0} in this repository — showing the default history instead."
      : UI.revMissingNotice || "“{0}” no longer exists — showing the default history instead.";
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

  /** Header text after the repo name, and the tooltip that lists a multi-branch selection. */
  function viewSuffix(branch, viewRev, viewRefs) {
    var names = viewRefs.map(GV.shortRefName);
    if (names.length > 1) {
      return { text: (UI.headerBranchCount || "{0} branches").replace("{0}", String(names.length)), list: names.join("\n") };
    }
    if (names.length === 1) return { text: names[0], list: "" };
    if (viewRev === GV.ALL_REFS) return { text: UI.branchAllRow || "All branches", list: "" };
    return { text: viewRev || branch || "", list: "" };
  }

  function setRepoHeader(repoAbsPath, branch, viewRev, viewRefs) {
    var badge = $("repo-path");
    var full = $("repo-full");
    if (!repoAbsPath) {
      badge.textContent = "";
      badge.removeAttribute("title");
      full.textContent = "";
      full.hidden = true;
      return;
    }
    var suffix = viewSuffix(branch, viewRev, viewRefs || []);
    var line = u.baseName(repoAbsPath) + (suffix.text ? " · " + suffix.text : "");
    badge.textContent = line + " ▾";
    badge.title = repoAbsPath + (suffix.list ? "\n\n" + suffix.list : "");
    badge.classList.add("gv-repo-badge--picker");
    // The full path lives in the badge tooltip; a separate path row cost a whole header line.
    full.textContent = repoAbsPath;
    full.hidden = true;
  }

  // ---- Repository picker ------------------------------------------------------------------
  // Always available (even with one repository: it is also where "Open another repository…"
  // lives). Sections: the workspace's repositories, then recent ones opened from elsewhere.
  // Opening it asks the host to scan the disk again; the list re-renders when that answer comes.

  var repoFilter = "";

  function repoItemsFromState() {
    if (S.repoItems && S.repoItems.length) return S.repoItems;
    return S.repoList.map(function (p) { return { path: p, name: u.baseName(p), detail: "", group: "workspace" }; });
  }

  function closeRepoMenu() {
    $("repo-menu").hidden = true;
    $("repo-path").setAttribute("aria-expanded", "false");
  }

  function menuButtons() {
    return Array.prototype.slice.call($("repo-menu").querySelectorAll("button.gv-repo-menu__item:not([hidden])"))
      .filter(function (b) { return !b.closest(".gv-repo-menu__section[hidden]"); });
  }

  function repoMenuItem(it) {
    var active = it.path === S.selectedRepo;
    var item = u.el("button", "gv-repo-menu__item" + (active ? " gv-repo-menu__item--active" : ""));
    item.type = "button";
    // A listbox of repositories: each entry is an option, the current one selected.
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.title = it.path;
    item.appendChild(u.el("span", "gv-repo-menu__check", active ? "✓" : ""));
    item.appendChild(u.el("span", "gv-repo-menu__name", it.name));
    if (it.detail) item.appendChild(u.el("span", "gv-repo-menu__detail", it.detail));
    item.addEventListener("click", function (ev) {
      ev.stopPropagation();
      closeRepoMenu();
      if (!active) post("selectRepo", { root: it.path });
    });
    return item;
  }

  function actionItem(label, cls, onClick) {
    var b = u.el("button", "gv-repo-menu__item gv-repo-menu__action " + cls, label);
    b.type = "button";
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      closeRepoMenu();
      onClick();
    });
    return b;
  }

  function section(title, items) {
    if (!items.length) return null;
    var box = u.el("div", "gv-repo-menu__section");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", title);
    box.appendChild(u.el("div", "gv-repo-menu__heading", title));
    items.forEach(function (it) { box.appendChild(repoMenuItem(it)); });
    return box;
  }

  /** Hides entries that do not match the filter (name or location), and sections left empty. */
  function applyRepoFilter() {
    var menu = $("repo-menu");
    var q = repoFilter.trim().toLowerCase();
    var any = false;
    Array.prototype.forEach.call(menu.querySelectorAll(".gv-repo-menu__section"), function (sec) {
      var shown = 0;
      Array.prototype.forEach.call(sec.querySelectorAll("button.gv-repo-menu__item"), function (b) {
        var ok = !q || (b.textContent + " " + b.title).toLowerCase().indexOf(q) >= 0;
        b.hidden = !ok;
        if (ok) shown++;
      });
      sec.hidden = shown === 0;
      if (shown) any = true;
    });
    var empty = menu.querySelector(".gv-repo-menu__empty");
    if (empty) {
      empty.hidden = any || !q;
      empty.textContent = (UI.repoMenuNoMatch || "No repository matches “{0}”").replace("{0}", repoFilter.trim());
    }
  }

  /** What had focus in the menu, to give it back after a re-render (the host's fresh list). */
  function menuFocusKey(menu) {
    var a = document.activeElement;
    if (!a || !menu.contains(a)) return a === document.body || !a ? { lost: true } : null;
    if (a.classList.contains("gv-repo-menu__filter")) return { filter: true };
    if (a.classList.contains("gv-repo-menu__open")) return { cls: "gv-repo-menu__open" };
    if (a.classList.contains("gv-repo-menu__clear")) return { cls: "gv-repo-menu__clear" };
    return a.title ? { path: a.title } : { lost: true };
  }

  function restoreMenuFocus(menu, key) {
    if (!key) return;
    var target = null;
    if (key.filter) target = menu.querySelector(".gv-repo-menu__filter");
    else if (key.cls) target = menu.querySelector("." + key.cls);
    else if (key.path) {
      target = menuButtons().filter(function (b) { return b.title === key.path; })[0] || null;
    }
    // The focused entry is gone (or focus had dropped to the page): land on the current repository.
    if (!target) target = menu.querySelector(".gv-repo-menu__filter") || menu.querySelector(".gv-repo-menu__item--active") || menuButtons()[0];
    if (target) target.focus();
  }

  function renderRepoMenu(focusFirst) {
    var menu = $("repo-menu");
    var items = repoItemsFromState();
    var focusKey = focusFirst ? null : menuFocusKey(menu);
    menu.textContent = "";
    if (items.length > 6) {
      var filter = u.el("input", "gv-repo-menu__filter");
      filter.type = "search";
      filter.placeholder = UI.repoMenuFilter || "Filter repositories";
      filter.setAttribute("aria-label", filter.placeholder);
      filter.value = repoFilter;
      filter.addEventListener("click", function (ev) { ev.stopPropagation(); });
      filter.addEventListener("input", function () { repoFilter = filter.value; applyRepoFilter(); });
      menu.appendChild(filter);
    }
    var ws = section(UI.repoMenuWorkspace || "Workspace", items.filter(function (i) { return i.group !== "recent"; }));
    var recent = items.filter(function (i) { return i.group === "recent"; });
    var rc = section(UI.repoMenuRecent || "Recent", recent);
    var list = u.el("div", "gv-repo-menu__list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", UI.repoPickerTitle || "Repositories");
    if (ws) list.appendChild(ws);
    if (rc) list.appendChild(rc);
    menu.appendChild(list);
    var empty = u.el("div", "gv-repo-menu__empty");
    empty.setAttribute("role", "status");
    empty.hidden = true;
    menu.appendChild(empty);
    var sep = u.el("div", "gv-repo-menu__sep");
    sep.setAttribute("role", "separator");
    menu.appendChild(sep);
    menu.appendChild(actionItem(UI.repoMenuOpenOther || "Open another repository…", "gv-repo-menu__open",
      function () { post("openRepository", {}); }));
    if (recent.length) {
      menu.appendChild(actionItem(UI.repoMenuClearRecent || "Clear recent repositories", "gv-repo-menu__clear",
        function () { post("clearRecentRepos", {}); }));
    }
    applyRepoFilter();
    if (focusFirst) {
      var first = menu.querySelector(".gv-repo-menu__filter") || menu.querySelector(".gv-repo-menu__item--active") || menuButtons()[0];
      if (first) first.focus();
    } else {
      restoreMenuFocus(menu, focusKey);
    }
  }

  function toggleRepoMenu() {
    var menu = $("repo-menu");
    if (!menu.hidden) {
      closeRepoMenu();
      return;
    }
    repoFilter = "";
    menu.hidden = false;
    $("repo-path").setAttribute("aria-expanded", "true");
    renderRepoMenu(true);
    post("refreshRepos", {});
  }

  // Keyboard inside the menu: ↑/↓ move, Home/End jump, Esc closes and returns to the badge.
  $("repo-menu").addEventListener("keydown", function (ev) {
    var buttons = menuButtons();
    var at = buttons.indexOf(document.activeElement);
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeRepoMenu();
      $("repo-path").focus();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!buttons.length) return;
      var next = ev.key === "ArrowDown" ? (at < 0 ? 0 : Math.min(buttons.length - 1, at + 1)) : (at <= 0 ? 0 : at - 1);
      buttons[next].focus();
    } else if ((ev.key === "Home" || ev.key === "End") && document.activeElement.tagName !== "INPUT") {
      ev.preventDefault();
      if (buttons.length) buttons[ev.key === "Home" ? 0 : buttons.length - 1].focus();
    }
  });

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
  app.actions.saveViewAsDefault = function () { post("saveViewAsDefault", {}); };

  // ---- Rendering the host's payload ---------------------------------------------------------

  /** The selection no longer resolves; the host fell back to the default log. Drop it and say so. */
  /**
   * drop: the host says the selection is gone for good (a clicked branch was deleted). Only honoured
   * when this reply answers the selection still on screen — a slow reply must not wipe a newer click.
   */
  function applyRevMissing(missing, drop, isList, requested) {
    if (!missing) {
      hideRevNotice();
      return;
    }
    if (drop && S.selectedRevs.length && JSON.stringify(requested) === JSON.stringify(S.selectedRevs)) {
      S.selectedRevs = [];
      saveState();
    }
    showRevNotice(missing, isList);
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
    applyRevMissing(payload.revMissing, !!payload.dropSelection, !!payload.revMissingIsList,
      Array.isArray(payload.requestedRevs) ? payload.requestedRevs : []);
    // Full ref names a multi-branch / pattern selection resolved to — the sidebar marks them selected.
    S.viewRefs = Array.isArray(payload.viewRefs) ? payload.viewRefs : [];
    S.currentBranch = (payload.branchTree && payload.branchTree.current) || "";
    renderPaused(payload.paused || null);
    u.setHidden($("branch-bar"), false);
    branchTree.render(payload.branchTree || { current: "", locals: [], remotes: [] });
    S.repoList = Array.isArray(payload.repos) ? payload.repos : [];
    S.repoItems = Array.isArray(payload.repoItems) ? payload.repoItems : [];
    S.selectedRepo = payload.selectedRepo || payload.repoRoot || "";
    setRepoHeader(payload.repoRoot || "", payload.branch || "", payload.viewRev || "",
      Array.isArray(payload.viewRefs) ? payload.viewRefs : []);
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

  // ---- Paused merge / rebase / cherry-pick / revert: banner, buttons, conflicted files --------

  var paused = null; // the operation the banner shows; its buttons act on that kind only

  function fill(template, a, b) {
    return String(template || "").replace("{0}", a == null ? "" : String(a)).replace("{1}", b == null ? "" : String(b));
  }

  /** "Merging: Merge branch 'x' · 2 conflicted files …" — pure, so the demo and tests read the same. */
  function pausedText(p) {
    var subject = p.subject || "";
    var head;
    if (p.kind === "rebase") head = subject ? fill(UI.opRebasing || "Rebasing {0}", subject) : (UI.opRebasePaused || "Rebase paused");
    else if (p.kind === "merge") head = fill(UI.opMerging || "Merging: {0}", subject);
    else if (p.kind === "cherry-pick") head = fill(UI.opCherryPicking || "Cherry-picking: {0}", subject);
    else head = fill(UI.opReverting || "Reverting: {0}", subject);
    if (p.total > 0 && p.step > 0) head += " (" + fill(UI.opProgress || "step {0} of {1}", p.step, p.total) + ")";
    var n = (p.conflicted || []).length;
    var tail = n ? fill(UI.opConflicts || "{0} conflicted file(s)", n) : (UI.opResolved || "No conflicts left — Continue to finish");
    return head + " · " + tail;
  }

  function showOpDetail(message) {
    var el = $("op-banner-detail");
    if (!el) return;
    el.textContent = message || "";
    u.setHidden(el, !message);
  }

  function renderPaused(p) {
    var banner = $("op-banner");
    if (!banner) return;
    var changed = !p || !paused || p.kind !== paused.kind;
    paused = p && p.kind ? p : null;
    setOpBusy(false);
    u.setHidden(banner, !paused);
    if (changed) showOpDetail(""); // a message belongs to the operation it was about
    if (!paused) return;
    $("op-banner-text").textContent = pausedText(paused);
    u.setHidden($("btn-op-skip"), paused.kind === "merge"); // git merge has no --skip
    var list = $("op-banner-files");
    list.textContent = "";
    (paused.conflicted || []).slice(0, 20).forEach(function (f) {
      var li = u.el("li", "gv-op-banner__file");
      var btn = u.el("button", "gv-op-banner__file-btn", f);
      btn.type = "button";
      btn.title = UI.opOpenFileTitle || "Open the file to resolve its conflicts";
      btn.addEventListener("click", function () { post("openConflict", { path: f }); });
      li.appendChild(btn);
      list.appendChild(li);
    });
    var more = (paused.conflicted || []).length - 20;
    if (more > 0) list.appendChild(u.el("li", "gv-op-banner__more", "+" + more));
    u.setHidden(list, !(paused.conflicted || []).length);
  }

  /** While a step runs the buttons wait (a second click would start git again); any answer frees them. */
  function setOpBusy(busy) {
    ["btn-op-continue", "btn-op-skip", "btn-op-abort"].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = busy;
    });
    var banner = $("op-banner");
    if (banner) banner.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function pausedStep(step) {
    if (!paused) return;
    setOpBusy(true);
    post("pausedStep", { kind: paused.kind, step: step });
  }

  function renderGraphError(code, message) {
    commitList.clear();
    hideRevNotice();
    renderPaused(null);
    u.setHidden($("branch-bar"), true);
    if (code === "no-repo") showEmptyCard(UI.emptyNoRepoTitle || "", UI.emptyNoRepoBody || "");
    else showEmptyCard(UI.emptyErrorTitle || "", message || UI.errorGeneric || "");
    setRepoHeader("", "", "", []);
  }

  // ---- Host → webview messages ------------------------------------------------------------

  var handlers = {
    reloadNow: function () { requestGraph(true); },
    // Fresh repository list (the picker was opened, or the recent list was cleared).
    repoList: function (d) {
      S.repoItems = Array.isArray(d.items) ? d.items : [];
      S.repoList = S.repoItems.map(function (i) { return i.path; });
      if (typeof d.selectedRepo === "string" && d.selectedRepo) S.selectedRepo = d.selectedRepo;
      if (!$("repo-menu").hidden) renderRepoMenu(false);
    },
    graphPayload: function (d) { renderPayload(d.payload); },
    displayPrefs: function (d) { GV.display.set(d.display); },
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
    // A step's answer. When the rebase editor's own Abort asked, the answer goes back to the editor.
    opError: function (d) {
      setOpBusy(false);
      if (S.editorAbort) { S.editorAbort = false; rebaseEditor.showError(d.message); return; }
      showOpDetail(d.message);
    },
    opDone: function () {
      setOpBusy(false);
      showOpDetail("");
      if (S.editorAbort) { S.editorAbort = false; rebaseEditor.close(); }
    },
    // "Open in Gitline graph" from inline blame: search for the SHA and open that commit.
    revealCommit: function (d) {
      if (typeof d.hash !== "string" || !d.hash) return;
      S.selectedRevs = [];
      S.pathFilter = "";
      applyPathFilter();
      searchInput.value = d.hash.slice(0, 12);
      setQuery(searchInput.value);
      S.currentHash = d.hash; // the row renders selected and reopenCurrentCommit opens it
      commitFilterChange();
    },
    // The default-view settings changed while the panel is open.
    applyView: function (d) {
      S.selectedRevs = stringList(d.revs) || [];
      hideRevNotice();
      commitFilterChange();
    },
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

  onClick("btn-op-continue", function () { pausedStep("continue"); });
  onClick("btn-op-skip", function () { pausedStep("skip"); });
  onClick("btn-op-abort", function () { pausedStep("abort"); });

  $("repo-path").addEventListener("click", function (ev) {
    ev.stopPropagation();
    toggleRepoMenu();
  });
  document.addEventListener("click", closeRepoMenu);
  // Ctrl/Cmd+F: search commits, as in other graph views.
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "f" || ev.key === "F")) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Right-click the graph's column header: show or hide author, date and hash (saved in settings).
  var columnHead = document.querySelector(".gv-unified-head");
  function openColumnMenu(x, y) {
    var cols = GV.display.get().columns;
    var labels = { author: UI.columnAuthor || "Author", date: UI.columnDate || "Date", sha: UI.columnSha || "SHA" };
    GV.contextMenu.show(x, y, GV.displayMath.COLUMNS.map(function (key) {
      return {
        label: labels[key],
        checked: cols[key],
        run: function () {
          var next = GV.displayMath.toggleColumn(cols, key);
          GV.display.set(Object.assign({}, GV.display.get(), { columns: next })); // at once; settings echo it back
          post("setColumns", { columns: next });
        },
      };
    }));
    var first = document.querySelector("#ctx-menu button");
    if (first) first.focus();
  }
  if (columnHead) {
    columnHead.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      openColumnMenu(ev.clientX, ev.clientY);
    });
    // Keyboard: Enter, Space, Shift+F10 or the context-menu key open the same menu.
    columnHead.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
        ev.preventDefault();
        var r = columnHead.getBoundingClientRect();
        openColumnMenu(r.left + 8, r.bottom);
      }
    });
  }

  applyPathFilter();
  applyMergesUi();
  applyCompareChip();
  requestGraph();
})(window.GV = window.GV || {});
