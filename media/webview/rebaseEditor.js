// Interactive-rebase todo editor shown in the detail pane.
(function (GV) {
  "use strict";
  var u = GV.util;
  var ACTIONS = ["pick", "squash", "fixup", "drop"];

  GV.createRebaseEditor = function (app, detailPane) {
    var UI = app.UI;
    var base = "";
    var items = []; // [{ sha, subject, action }]

    function reset() {
      base = "";
      items = [];
    }

    function close() {
      reset();
      detailPane.showHint();
    }

    function start(sha) {
      base = sha;
      items = [];
      detailPane.setContent(
        "<header class=\"gv-detail-head2\">" +
          "<div class=\"gv-detail-subject2\">" + u.esc(UI.rebaseTitle || "Interactive rebase") + "</div>" +
          "<div class=\"gv-detail-sub\"><code class=\"gv-hash\">onto " + u.esc(sha.slice(0, 7)) + "^</code></div>" +
        "</header>" +
        "<ul class=\"gv-rebase-list\" id=\"rebase-list\">" +
          "<li class=\"gv-detail-files-loading\">" + u.esc(UI.loading || "Loading…") + "</li>" +
        "</ul>" +
        "<div class=\"gv-rebase-actions\">" +
          "<button type=\"button\" id=\"btn-rebase-apply\" class=\"gv-rebase-btn gv-rebase-btn--primary\">" + u.esc(UI.rebaseApply || "Apply") + "</button>" +
          "<button type=\"button\" id=\"btn-rebase-cancel\" class=\"gv-rebase-btn\">" + u.esc(UI.rebaseCancel || "Cancel") + "</button>" +
          "<button type=\"button\" id=\"btn-rebase-abort\" class=\"gv-rebase-btn gv-rebase-btn--danger\">" + u.esc(UI.rebaseAbort || "Abort rebase") + "</button>" +
        "</div>",
        false);
      bind("btn-rebase-apply", function () { app.post("applyRebase", { base: base + "^", items: items }); });
      bind("btn-rebase-cancel", close);
      bind("btn-rebase-abort", function () { app.post("abortRebase", {}); });
      app.post("requestRebaseCommits", { base: sha + "^" });
    }

    function bind(id, fn) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", fn);
    }

    function swap(i, j) {
      if (j < 0 || j >= items.length) return;
      var tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
      render();
    }

    function actionSelect(it) {
      var sel = u.el("select", "gv-rebase-select");
      ACTIONS.forEach(function (a) {
        var opt = u.el("option", null, a);
        opt.value = a;
        if (a === it.action) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () {
        it.action = sel.value;
        render();
      });
      return sel;
    }

    function moveButton(label, title, disabled, onClick) {
      var b = u.el("button", "gv-rebase-move", label);
      b.type = "button";
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    }

    function buildRow(it, idx) {
      var li = u.el("li", "gv-rebase-row gv-rebase-row--" + it.action);
      li.appendChild(actionSelect(it));
      li.appendChild(u.el("code", "gv-hash", it.sha.slice(0, 7)));
      var sub = u.el("span", "gv-rebase-subject", it.subject);
      sub.title = it.subject;
      li.appendChild(sub);
      li.appendChild(moveButton("▲", UI.rebaseMoveUp || "Move up", idx === 0, function () { swap(idx, idx - 1); }));
      li.appendChild(moveButton("▼", UI.rebaseMoveDown || "Move down", idx === items.length - 1, function () { swap(idx, idx + 1); }));
      return li;
    }

    function render() {
      var list = document.getElementById("rebase-list");
      if (!list) return;
      if (!items.length) {
        u.showListMessage("rebase-list", UI.rebaseEmpty || "No commits to rebase.");
        return;
      }
      list.textContent = "";
      items.forEach(function (it, idx) { list.appendChild(buildRow(it, idx)); });
    }

    function setCommits(commits) {
      items = (commits || []).map(function (c) {
        return { sha: c.sha, subject: c.subject || "", action: "pick" };
      });
      render();
    }

    function showError(message) {
      u.showListMessage("rebase-list", message || "Error");
    }

    return { start: start, setCommits: setCommits, showError: showError, close: close };
  };
})(window.GV = window.GV || {});
