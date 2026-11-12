// "Working changes" in the detail pane (1.9.0): staged / changed / untracked / conflicted files with
// stage, unstage and discard; a commit message with Commit and "Amend last commit"; Stash. The host
// does the git work (workTreePanel.ts); every write answers with workFiles + a graph reload, and the
// pane stays open through that reload with the message being typed kept.
(function (GV) {
  "use strict";
  var u = GV.util;
  var WORK = ":working"; // S.currentHash while this pane is shown

  GV.WORK_SELECTION = WORK;

  GV.createWorkPane = function (app, detailPane) {
    var UI = app.UI;
    var S = app.state;
    var draft = { message: "", amend: false, savedMessage: "" }; // savedMessage: typed text before Amend filled it
    var files = null;
    var busy = false;

    function isOpen() { return S.currentHash === WORK; }

    function show() {
      S.currentHash = WORK;
      S.compareTarget = "";
      detailPane.setContent(
        "<header class=\"gv-detail-head2\">" +
          "<div class=\"gv-detail-subject2\">" + u.esc(UI.workingChanges || "Working changes") + "</div>" +
          "<div class=\"gv-detail-sub gv-work-tools\">" +
            "<button type=\"button\" class=\"gv-detail-patch-btn\" id=\"btn-work-stash\">" + u.esc(UI.workStash || "Stash…") + "</button>" +
            "<button type=\"button\" class=\"gv-detail-patch-btn\" id=\"btn-work-scm\">" + u.esc(UI.workOpenScm || "Source Control") + "</button>" +
          "</div>" +
        "</header>" +
        "<div class=\"gv-work-commit\">" +
          "<textarea id=\"work-message\" class=\"gv-work-message\" rows=\"3\" spellcheck=\"true\" aria-label=\"" + u.esc(UI.rebaseMessageAria || "Commit message") + "\" placeholder=\"" + u.esc(UI.workMessagePlaceholder || "Commit message") + "\"></textarea>" +
          "<div class=\"gv-work-commit__row\">" +
            "<label class=\"gv-work-amend\"><input type=\"checkbox\" id=\"work-amend\" /> " + u.esc(UI.workAmend || "Amend last commit") + "</label>" +
            "<button type=\"button\" class=\"gv-rebase-btn gv-rebase-btn--primary\" id=\"btn-work-commit\">" + u.esc(UI.workCommit || "Commit") + "</button>" +
          "</div>" +
          "<div id=\"work-error\" class=\"gv-work-error\" role=\"alert\" hidden></div>" +
        "</div>" +
        "<div id=\"work-groups\" class=\"gv-work-groups\"><p class=\"gv-detail-files-loading\">" + u.esc(UI.loading || "Loading…") + "</p></div>",
        false);
      var ta = document.getElementById("work-message");
      var amend = document.getElementById("work-amend");
      ta.value = draft.message;
      amend.checked = draft.amend;
      ta.addEventListener("input", function () { draft.message = ta.value; updateCommitButton(); });
      ta.addEventListener("keydown", function (ev) {
        // Ctrl/Cmd+Enter commits, as in VS Code's Source Control box.
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          doCommit();
        }
      });
      amend.addEventListener("change", function () {
        draft.amend = amend.checked;
        if (draft.amend) {
          draft.savedMessage = draft.message;
          app.post("requestAmendMessage", {});
        } else {
          draft.message = draft.savedMessage;
          ta.value = draft.message;
          showError(""); // the "already pushed" warning was about amending
        }
        updateCommitButton();
      });
      bind("btn-work-commit", doCommit);
      bind("btn-work-stash", function () { app.post("workStash", {}); });
      bind("btn-work-scm", function () { app.post("focusScm", {}); });
      updateCommitButton();
      if (files) renderGroups();
      app.post("requestWorkFiles", {});
    }

    function bind(id, fn) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", fn);
    }

    function updateCommitButton() {
      var b = document.getElementById("btn-work-commit");
      if (!b) return;
      b.disabled = busy || !draft.message.trim();
      b.textContent = draft.amend ? (UI.workAmendButton || "Amend") : (UI.workCommit || "Commit");
    }

    function doCommit() {
      if (busy || !draft.message.trim()) return;
      setBusy(true);
      showError("");
      app.post("workCommit", { message: draft.message, amend: draft.amend });
    }

    function setBusy(b) {
      busy = b;
      updateCommitButton();
    }

    function showError(message) {
      var el = document.getElementById("work-error");
      if (!el) return;
      el.textContent = message || "";
      u.setHidden(el, !message);
    }

    // ---- File groups ---------------------------------------------------------------------------

    var GROUPS = [
      { key: "conflicted", label: function () { return UI.workConflicted || "Merge conflicts"; }, action: null },
      { key: "staged", label: function () { return UI.workStaged || "Staged"; }, action: "unstage" },
      { key: "unstaged", label: function () { return UI.workUnstaged || "Changes"; }, action: "stage" },
      { key: "untracked", label: function () { return UI.workUntracked || "Untracked"; }, action: "stage" },
    ];

    function actionButton(cls, text, title, fn) {
      var b = u.el("button", "gv-work-act " + cls, text);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
      return b;
    }

    function fileRow(f, group) {
      var li = u.el("li", "gv-file-row gv-work-file gv-file-row--" + (f.status === "?" ? "A" : f.status));
      li.tabIndex = 0;
      li.setAttribute("data-path", f.path);
      li.appendChild(u.el("span", "gv-file-badge", f.status === "?" ? "U" : f.status));
      // File name first, its folder after it in muted text (as in Source Control): a long path
      // never hides the name.
      var label = f.orig ? f.orig + "  →  " + f.path : f.path;
      var slash = f.path.lastIndexOf("/");
      var p = u.el("span", "gv-file-path gv-work-path");
      p.appendChild(u.el("span", "gv-work-path__name", slash >= 0 ? f.path.slice(slash + 1) : f.path));
      var dir = f.orig ? f.orig + " →" : slash >= 0 ? f.path.slice(0, slash) : "";
      if (dir) p.appendChild(u.el("span", "gv-work-path__dir", dir));
      p.title = label;
      li.appendChild(p);
      var acts = u.el("span", "gv-work-acts");
      if (group.key !== "conflicted") {
        acts.appendChild(actionButton("gv-work-act--discard", "↺",
          (group.key === "untracked" ? UI.workDeleteFile : UI.workDiscardFile) || "Discard changes",
          function () { app.post("workDiscardFile", { path: f.path, group: group.key }); }));
      }
      if (group.action === "stage") {
        acts.appendChild(actionButton("gv-work-act--stage", "+", UI.workStageFile || "Stage", function () { app.post("workStage", { paths: [f.path] }); }));
      } else if (group.action === "unstage") {
        acts.appendChild(actionButton("gv-work-act--unstage", "−", UI.workUnstageFile || "Unstage", function () { app.post("workUnstage", { paths: [f.path] }); }));
      }
      li.appendChild(acts);
      function open() { app.post("openWorkDiff", { path: f.path, group: group.key }); }
      li.addEventListener("click", open);
      li.addEventListener("keydown", function (ev) {
        if (ev.target !== li) return; // a key on a row button is that button's
        if (ev.key === "Enter") { ev.preventDefault(); open(); }
        else if (ev.key === " " && group.action) {
          ev.preventDefault();
          app.post(group.action === "stage" ? "workStage" : "workUnstage", { paths: [f.path] });
        }
      });
      return li;
    }

    function groupSection(group) {
      var list = files[group.key] || [];
      if (!list.length) return null;
      var sec = u.el("section", "gv-work-group gv-work-group--" + group.key);
      var head = u.el("div", "gv-detail-files-head");
      head.appendChild(u.el("span", "gv-detail-files-label", group.label() + " · " + list.length));
      var acts = u.el("span", "gv-detail-files-actions");
      if (group.key === "staged") {
        acts.appendChild(actionButton("gv-work-act--unstage", "−", UI.workUnstageAll || "Unstage all", function () { app.post("workUnstageAll", {}); }));
      } else if (group.action === "stage") {
        acts.appendChild(actionButton("gv-work-act--stage", "+", UI.workStageGroup || "Stage all", function () {
          app.post("workStage", { paths: list.map(function (f) { return f.path; }) });
        }));
      }
      head.appendChild(acts);
      sec.appendChild(head);
      if (group.key === "conflicted") sec.appendChild(u.el("p", "gv-work-note", UI.workConflictNote || "Resolve these in the editor, then stage them."));
      var ul = u.el("ul", "gv-detail-files");
      ul.setAttribute("aria-label", group.label());
      list.forEach(function (f) { ul.appendChild(fileRow(f, group)); });
      sec.appendChild(ul);
      return sec;
    }

    function renderGroups() {
      var box = document.getElementById("work-groups");
      if (!box || !files) return;
      var focusedPath = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute("data-path") : null;
      box.textContent = "";
      var any = false;
      GROUPS.forEach(function (g) {
        var sec = groupSection(g);
        if (sec) { box.appendChild(sec); any = true; }
      });
      if (!any) box.appendChild(u.el("p", "gv-detail-hint", UI.workClean || "No changes — the working tree is clean."));
      // After a stage / unstage the row moves to another group: keep the keyboard on it.
      if (focusedPath) {
        var again = Array.prototype.find.call(box.querySelectorAll(".gv-work-file"), function (el) { return el.getAttribute("data-path") === focusedPath; });
        if (again) again.focus();
      }
    }

    return {
      isOpen: isOpen,
      show: show,
      setFiles: function (d) {
        if (d.root && S.workRoot && d.root !== S.workRoot) return; // from the repository before a switch
        files = d.files || { staged: [], unstaged: [], untracked: [], conflicted: [] };
        if (isOpen()) renderGroups();
      },
      setAmendMessage: function (d) {
        if (!isOpen() || !draft.amend) return;
        draft.message = d.message || "";
        var ta = document.getElementById("work-message");
        if (ta) ta.value = draft.message;
        if (d.pushed) showError(UI.workAmendPushed || "The last commit is already pushed: amending it means a force push.");
        updateCommitButton();
      },
      committed: function () {
        draft = { message: "", amend: false, savedMessage: "" };
        var ta = document.getElementById("work-message");
        if (ta) ta.value = "";
        var amend = document.getElementById("work-amend");
        if (amend) amend.checked = false;
        setBusy(false);
        updateCommitButton();
      },
      error: function (message) {
        setBusy(false);
        if (isOpen()) showError(message);
      },
      /** The answer to any write: the commit button may be used again. */
      settled: function () { setBusy(false); },
      /** Another repository is shown: its files and the message typed for the old one do not carry over. */
      reset: function () {
        files = null;
        draft = { message: "", amend: false, savedMessage: "" };
        setBusy(false);
      },
    };
  };
})(window.GV = window.GV || {});
