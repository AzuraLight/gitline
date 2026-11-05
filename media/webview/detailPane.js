// The right-hand pane: commit / stash / compare header plus its changed-files list.
(function (GV) {
  "use strict";
  var u = GV.util;

  GV.createDetailPane = function (app) {
    var UI = app.UI;
    var S = app.state;
    var detail = document.getElementById("commit-detail");

    var lastFiles = null;   // last list rendered, so the List/Tree toggle can redraw without a round-trip
    var lastMode = "commit";
    var collapsed = {};     // folder path → true while collapsed; survives redraws and selection changes

    function setContent(html, empty) {
      detail.classList.toggle("gv-detail--empty", !!empty);
      detail.innerHTML = html;
      lastFiles = null;
      onClick("btn-file-view", toggleFileView);
    }

    function toggleFileView() {
      S.fileView = S.fileView === "tree" ? "list" : "tree";
      app.post("setFileView", { mode: S.fileView });
      var btn = document.getElementById("btn-file-view");
      if (btn) btn.outerHTML = viewToggleHtml();
      onClick("btn-file-view", toggleFileView);
      if (lastFiles) renderFiles(lastFiles, lastMode);
    }

    function showHint() {
      setContent("<p class=\"gv-detail-hint\">" + u.esc(UI.detailHint || "") + "</p>", true);
    }

    function header(subject, subHtml) {
      return "<header class=\"gv-detail-head2\">" +
          "<div class=\"gv-detail-subject2\">" + subject + "</div>" +
          "<div class=\"gv-detail-sub\">" + subHtml + "</div>" +
        "</header>";
    }

    function viewToggleHtml() {
      var tree = S.fileView === "tree";
      var title = tree ? UI.fileViewAsList || "View as list" : UI.fileViewAsTree || "View as tree";
      return "<button type=\"button\" class=\"gv-detail-patch-btn gv-file-view-btn\" id=\"btn-file-view\" aria-pressed=\"" + tree +
        "\" title=\"" + u.esc(title) + "\" aria-label=\"" + u.esc(title) + "\">" + (tree ? ICON_LIST : ICON_TREE) + "</button>";
    }

    // The button shows the view you switch TO. SVG, not glyphs — icon fonts differ per OS.
    var ICON_LIST = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" fill=\"currentColor\">" +
      "<rect x=\"2\" y=\"3\" width=\"12\" height=\"1.6\" rx=\".8\"/><rect x=\"2\" y=\"7.2\" width=\"12\" height=\"1.6\" rx=\".8\"/>" +
      "<rect x=\"2\" y=\"11.4\" width=\"12\" height=\"1.6\" rx=\".8\"/></svg>";
    var ICON_TREE = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" fill=\"currentColor\">" +
      "<rect x=\"1.5\" y=\"2.5\" width=\"8\" height=\"1.6\" rx=\".8\"/><rect x=\"5\" y=\"7.2\" width=\"9.5\" height=\"1.6\" rx=\".8\"/>" +
      "<rect x=\"5\" y=\"11.9\" width=\"9.5\" height=\"1.6\" rx=\".8\"/><rect x=\"2.6\" y=\"4\" width=\"1.4\" height=\"8.6\"/></svg>";

    function filesSection(buttonHtml) {
      return "<div class=\"gv-detail-files-head\">" +
          "<span class=\"gv-detail-files-label\">" + u.esc(UI.filesLabel || "Files") + "</span>" +
          "<span class=\"gv-detail-files-actions\">" + viewToggleHtml() + (buttonHtml || "") + "</span>" +
        "</div>" +
        "<ul class=\"gv-detail-files\" id=\"files-list\">" +
          "<li class=\"gv-detail-files-loading\">" + u.esc(UI.loading || "Loading…") + "</li>" +
        "</ul>";
    }

    function patchButton(id, title) {
      return "<button type=\"button\" class=\"gv-detail-patch-btn\" id=\"" + id + "\"" +
        (title != null ? " title=\"" + u.esc(title) + "\"" : "") + ">" +
        u.esc(UI.openPatchShort || "Patch") + "</button>";
    }

    function onClick(id, fn) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", fn);
    }

    function clearVirtualSelection() {
      document.querySelectorAll(".gv-virtual-row--selected").forEach(function (el) {
        el.classList.remove("gv-virtual-row--selected");
      });
    }

    function showCommit(c) {
      setContent(
        header(u.esc(c.subject),
          "<code class=\"gv-hash\">" + u.esc(c.hash.slice(0, 7)) + "</code>" +
          "<span class=\"gv-author\">" + u.esc(c.author) + "</span>" +
          "<span class=\"gv-time\">" + u.esc(u.formatTimeFull(c.dateSec)) + "</span>") +
        filesSection(patchButton("btn-show-patch", UI.openGitShow || "")),
        false);
      onClick("btn-show-patch", function () { app.post("openCommitPatch", { hash: c.hash }); });
      S.currentHash = c.hash;
      S.compareTarget = "";
      clearVirtualSelection();
      app.post("requestCommitFiles", { hash: c.hash });
    }

    function showCompare(a, b) {
      var sa = u.esc(a.slice(0, 7)), sb = u.esc(b.slice(0, 7));
      setContent(
        header(u.esc(UI.comparingLabel || "Comparing") + " " + sa + " … " + sb,
          "<code class=\"gv-hash\">" + sa + "</code>" +
          "<span class=\"gv-author\">→</span>" +
          "<code class=\"gv-hash\">" + sb + "</code>") +
        filesSection(patchButton("btn-show-compare-patch")),
        false);
      onClick("btn-show-compare-patch", function () { app.post("openComparePatch", { a: a, b: b }); });
    }

    function showStash(st) {
      setContent(
        header(u.esc(st.subject || "(stash)"),
          "<code class=\"gv-hash\">" + u.esc(st.ref) + "</code>" +
          "<span class=\"gv-author\">on " + u.esc(st.parentShort || "") + "</span>") +
        filesSection(),
        false);
    }

    function fileDiffMessage(f, mode) {
      var base = { path: f.path, oldPath: f.oldPath || "" };
      if (mode === "stash") return Object.assign({ hash: S.currentHash }, base);
      if (mode === "compare") return Object.assign({ a: S.markedHash, b: S.compareTarget, status: f.status || "M" }, base);
      return Object.assign({ hash: S.currentHash, status: f.status || "M" }, base);
    }

    var DIFF_TYPE = { stash: "openStashFileDiff", compare: "openCompareFileDiff", commit: "openFileDiff" };

    /** label: what the row shows (full path in list mode, file name in tree mode). */
    function buildFileRow(f, mode, label) {
      var item = u.el("li", "gv-file-row gv-file-row--" + (f.status || "M"));
      item.appendChild(u.el("span", "gv-file-badge", f.status || "M"));
      var renamed = f.status === "R" && f.oldPath;
      var pathEl = u.el("span", "gv-file-path", label != null ? label : renamed ? f.oldPath + "  →  " + f.path : f.path);
      pathEl.title = renamed ? f.oldPath + " → " + f.path : f.path;
      item.appendChild(pathEl);
      var stat = u.el("span", "gv-file-stat");
      if (f.insertions || f.deletions) {
        stat.appendChild(u.el("span", "gv-file-stat__ins", "+" + f.insertions));
        stat.appendChild(u.el("span", "gv-file-stat__del", "−" + f.deletions));
      }
      item.appendChild(stat);
      item.addEventListener("click", function () {
        app.post(DIFF_TYPE[mode] || DIFF_TYPE.commit, fileDiffMessage(f, mode));
      });
      return item;
    }

    var INDENT_PX = 14;
    var BASE_PAD_PX = 8;

    function indent(row, depth) {
      row.style.paddingLeft = (BASE_PAD_PX + depth * INDENT_PX) + "px";
    }

    function setFolderOpen(row, open) {
      if (open) delete collapsed[row.dataset.path];
      else collapsed[row.dataset.path] = true;
      row.setAttribute("aria-expanded", String(open));
      var next = row.nextElementSibling;
      var depth = Number(row.dataset.depth);
      // Show / hide every following row that is deeper than this folder; nested collapsed folders stay shut.
      var hiddenUnder = Infinity;
      while (next && Number(next.dataset.depth) > depth) {
        var d = Number(next.dataset.depth);
        if (d <= hiddenUnder) hiddenUnder = Infinity;
        next.hidden = !open || d > hiddenUnder;
        if (open && next.classList.contains("gv-tree-folder") && collapsed[next.dataset.path] && hiddenUnder === Infinity) hiddenUnder = d;
        next = next.nextElementSibling;
      }
    }

    function folderRow(node, depth) {
      var row = u.el("li", "gv-tree-folder");
      row.dataset.path = node.path;
      row.dataset.depth = String(depth);
      row.tabIndex = 0;
      row.setAttribute("role", "treeitem");
      row.title = node.path;
      indent(row, depth);
      row.appendChild(u.el("span", "gv-tree-twisty"));
      row.appendChild(u.el("span", "gv-tree-name", node.name));
      row.appendChild(u.el("span", "gv-tree-count", String(node.count)));
      function toggle() { setFolderOpen(row, row.getAttribute("aria-expanded") !== "true"); }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (ev) {
        var open = row.getAttribute("aria-expanded") === "true";
        if (ev.key === "Enter" || ev.key === " ") toggle();
        else if (ev.key === "ArrowRight" && !open) setFolderOpen(row, true);
        else if (ev.key === "ArrowLeft" && open) setFolderOpen(row, false);
        else return;
        ev.preventDefault();
      });
      return row;
    }

    /** Depth-first rows; collapse is applied afterwards so nested state is honoured. */
    function appendTree(list, nodes, depth, mode) {
      nodes.forEach(function (node) {
        if (node.type === "folder") {
          list.appendChild(folderRow(node, depth));
          appendTree(list, node.children, depth + 1, mode);
          return;
        }
        var f = node.file;
        var label = f.status === "R" && f.oldPath ? node.name + "  ←  " + f.oldPath : node.name;
        var row = buildFileRow(f, mode, label);
        row.dataset.depth = String(depth);
        indent(row, depth);
        list.appendChild(row);
      });
    }

    function renderTree(list, files, mode) {
      list.classList.add("gv-detail-files--tree");
      list.setAttribute("role", "tree");
      appendTree(list, GV.fileTree.buildFileTree(files), 0, mode);
      list.querySelectorAll(".gv-tree-folder").forEach(function (row) {
        row.setAttribute("aria-expanded", String(!collapsed[row.dataset.path]));
      });
      // Outermost collapsed folders first; setFolderOpen keeps nested ones shut as well.
      list.querySelectorAll(".gv-tree-folder").forEach(function (row) {
        if (collapsed[row.dataset.path] && !row.hidden) setFolderOpen(row, false);
      });
    }

    /** mode: "commit" | "stash" | "compare" — decides which diff a click opens. */
    function renderFiles(files, mode) {
      var list = document.getElementById("files-list");
      if (!list) return;
      lastFiles = files;
      lastMode = mode;
      if (!files || !files.length) {
        u.showListMessage("files-list", UI.noFiles || "No files changed.");
        return;
      }
      list.textContent = "";
      list.classList.remove("gv-detail-files--tree");
      list.removeAttribute("role");
      if (S.fileView === "tree") renderTree(list, files, mode);
      else files.forEach(function (f) { list.appendChild(buildFileRow(f, mode)); });
    }

    function showFilesError(message) {
      u.showListMessage("files-list", message || "Error");
    }

    return {
      el: detail,
      showHint: showHint,
      setContent: setContent,
      showCommit: showCommit,
      showCompare: showCompare,
      showStash: showStash,
      renderFiles: renderFiles,
      showFilesError: showFilesError,
    };
  };
})(window.GV = window.GV || {});
