// The right-hand pane: commit / stash / compare header plus its changed-files list.
(function (GV) {
  "use strict";
  var u = GV.util;

  GV.createDetailPane = function (app) {
    var UI = app.UI;
    var S = app.state;
    var detail = document.getElementById("commit-detail");

    function setContent(html, empty) {
      detail.classList.toggle("gv-detail--empty", !!empty);
      detail.innerHTML = html;
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

    function filesSection(buttonHtml) {
      return "<div class=\"gv-detail-files-head\">" +
          "<span class=\"gv-detail-files-label\">" + u.esc(UI.filesLabel || "Files") + "</span>" +
          (buttonHtml || "") +
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

    function buildFileRow(f, mode) {
      var item = u.el("li", "gv-file-row gv-file-row--" + (f.status || "M"));
      item.appendChild(u.el("span", "gv-file-badge", f.status || "M"));
      var renamed = f.status === "R" && f.oldPath;
      var pathEl = u.el("span", "gv-file-path", renamed ? f.oldPath + "  →  " + f.path : f.path);
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

    /** mode: "commit" | "stash" | "compare" — decides which diff a click opens. */
    function renderFiles(files, mode) {
      var list = document.getElementById("files-list");
      if (!list) return;
      if (!files || !files.length) {
        u.showListMessage("files-list", UI.noFiles || "No files changed.");
        return;
      }
      list.textContent = "";
      files.forEach(function (f) { list.appendChild(buildFileRow(f, mode)); });
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
