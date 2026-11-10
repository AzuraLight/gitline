// Left sidebar: HEAD row, local branches, one folder per remote. Clicking a ref shows its history.
(function (GV) {
  "use strict";
  var u = GV.util;
  /** Must match ALL_REFS in src/viewSelection.ts. */
  GV.ALL_REFS = ":all";
  /** `refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`, `refs/tags/v1` → `v1`; others as is. */
  GV.shortRefName = function (full) {
    return String(full).replace(/^refs\/(heads|remotes|tags)\//, "");
  };

  GV.createBranchTree = function (app, menus) {
    var UI = app.UI;
    var S = app.state;
    var rootEl = document.getElementById("branch-tree-root");

    function remoteGroupTitle(remote) {
      return (UI.branchGroupRemote || "Remote: {0}").replace("{0}", remote);
    }

    function setRevs(revs) {
      S.selectedRevs = revs;
      app.saveState();
      app.requestGraph();
    }

    /**
     * The branches on screen as plain names, to edit with Ctrl/Cmd+click:
     * - a pattern selection is spelled out into the branches it matched, so a click can take one out;
     * - HEAD's log starts from the checked-out branch, so a click *adds* to what was shown;
     * - "All branches" starts empty (adding one branch to everything means just that branch).
     */
    function editableSelection() {
      if (S.selectedRevs.indexOf(GV.ALL_REFS) >= 0) return [];
      if (S.viewRefs && S.viewRefs.length) return S.viewRefs.map(GV.shortRefName);
      if (S.selectedRevs.length === 0) return S.currentBranch ? [S.currentBranch] : [];
      return S.selectedRevs.slice();
    }

    /** Ctrl/Cmd+click: add the branch to the selection, or take it out. */
    function toggleRev(rev) {
      var list = editableSelection();
      var at = list.indexOf(rev);
      if (at >= 0) list.splice(at, 1);
      else list.push(rev);
      setRevs(list);
    }

    /**
     * Selected by name, or matched by a pattern in the selection. viewRefs holds full ref names, so
     * a local branch "x" is not lit up by a tag or remote that happens to share the name.
     */
    function isSelected(rev, refRoot) {
      if (S.selectedRevs.indexOf(rev) >= 0) return true;
      return (S.viewRefs || []).indexOf(refRoot + rev) >= 0;
    }

    function markSelected(btn, on) {
      btn.classList.toggle("gv-ref-item__btn--selected", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }

    function refButton(classExtra, rev, labelText, current) {
      var btn = u.el("button", "gv-ref-item__btn " + (classExtra || ""));
      btn.type = "button";
      btn.setAttribute("data-rev", rev);
      btn.setAttribute("role", "treeitem");
      btn.title = rev + "\n" + (UI.branchMultiSelectHint || "Ctrl/Cmd+click to add to the view");
      btn.appendChild(u.el("span", "gv-ref-item__label", labelText));
      if (current && current === rev && current !== "HEAD") {
        btn.classList.add("gv-ref-item__btn--current");
        btn.appendChild(u.el("span", "gv-ref-badge", "✓"));
      }
      var refRoot = (classExtra || "").indexOf("--remote") >= 0 ? "refs/remotes/" : "refs/heads/";
      markSelected(btn, isSelected(rev, refRoot));
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) toggleRev(rev);
        else setRevs([rev]);
      });
      // Keyboard twin of Ctrl/Cmd+click (a keyboard-activated click does not reliably carry modifiers).
      btn.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" || !(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        ev.stopPropagation();
        toggleRev(rev);
      });
      return btn;
    }

    function headRow() {
      var row = u.el("div", "gv-ref-node");
      row.setAttribute("role", "none");
      var btn = u.el("button", "gv-ref-item__btn gv-ref-item__btn--head", UI.branchHeadRow || "HEAD");
      btn.type = "button";
      btn.setAttribute("data-rev", "");
      btn.setAttribute("role", "treeitem");
      markSelected(btn, S.selectedRevs.length === 0);
      btn.addEventListener("click", function () { setRevs([]); });
      row.appendChild(btn);
      return row;
    }

    /** Every branch, remote and tag in one graph; commits not on HEAD are dimmed. */
    function allRow() {
      var row = u.el("div", "gv-ref-node");
      row.setAttribute("role", "none");
      var btn = u.el("button", "gv-ref-item__btn gv-ref-item__btn--all", UI.branchAllRow || "All branches");
      btn.type = "button";
      btn.setAttribute("data-rev", GV.ALL_REFS);
      btn.setAttribute("role", "treeitem");
      markSelected(btn, S.selectedRevs.indexOf(GV.ALL_REFS) >= 0);
      btn.addEventListener("click", function () { setRevs([GV.ALL_REFS]); });
      row.appendChild(btn);
      return row;
    }

    /** entries: [{ rev, label, onContext(x, y) }] */
    function folder(title, extraClass, open, entries, buttonClass, current) {
      var det = u.el("details", "gv-ref-folder" + (extraClass ? " " + extraClass : ""));
      det.open = open;
      det.appendChild(u.el("summary", "gv-ref-folder__summary", title));
      var ul = u.el("ul", "gv-ref-folder__list");
      entries.forEach(function (e) {
        var li = u.el("li", "gv-ref-item");
        var btn = refButton(buttonClass, e.rev, e.label, current);
        btn.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          e.onContext(ev.clientX, ev.clientY);
        });
        li.appendChild(btn);
        ul.appendChild(li);
      });
      det.appendChild(ul);
      return det;
    }

    function stripRemote(fullName) {
      return fullName.indexOf("/") >= 0 ? fullName.split("/").slice(1).join("/") : fullName;
    }

    /**
     * Every graph reply rebuilds the tree. Keep what the user had: which folders were open, and
     * which ref had keyboard focus (otherwise selecting a branch from the keyboard drops focus to
     * the page and Ctrl/Cmd+Enter has nothing to act on).
     */
    function snapshot() {
      var open = {};
      Array.prototype.forEach.call(rootEl.querySelectorAll("details.gv-ref-folder"), function (d) {
        var s = d.querySelector("summary");
        if (s) open[s.textContent] = d.open;
      });
      var a = document.activeElement;
      var focus = a && rootEl.contains(a) && a.hasAttribute("data-rev")
        ? { rev: a.getAttribute("data-rev"), cls: a.className.indexOf("--remote") >= 0 ? "--remote" : "" }
        : null;
      return { open: open, focus: focus };
    }

    function restore(snap) {
      Array.prototype.forEach.call(rootEl.querySelectorAll("details.gv-ref-folder"), function (d) {
        var s = d.querySelector("summary");
        var title = s ? s.textContent : "";
        if (Object.prototype.hasOwnProperty.call(snap.open, title)) d.open = snap.open[title];
        // A selected branch inside a collapsed remote folder would be invisible.
        if (d.querySelector(".gv-ref-item__btn--selected")) d.open = true;
      });
      if (!snap.focus) return;
      var buttons = rootEl.querySelectorAll(".gv-ref-item__btn[data-rev]");
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var sameKind = (b.className.indexOf("--remote") >= 0 ? "--remote" : "") === snap.focus.cls;
        if (b.getAttribute("data-rev") === snap.focus.rev && sameKind) {
          b.focus();
          return;
        }
      }
    }

    function render(tree) {
      if (!rootEl || !tree) return;
      var snap = snapshot();
      rootEl.textContent = "";
      var cur = tree.current || "";
      rootEl.appendChild(headRow());
      rootEl.appendChild(allRow());
      var locals = tree.locals || [];
      if (locals.length) {
        rootEl.appendChild(folder(UI.branchGroupLocal || "Local", "", true, locals.map(function (name) {
          return { rev: name, label: name, onContext: function (x, y) { menus.forLocalBranch(name, name === cur, x, y); } };
        }), "gv-ref-item__btn--local", cur));
      }
      (tree.remotes || []).forEach(function (g) {
        if (!g || !g.branches || !g.branches.length) return;
        rootEl.appendChild(folder(remoteGroupTitle(g.remote || ""), "gv-ref-folder--remote", false, g.branches.map(function (full) {
          return { rev: full, label: stripRemote(full), onContext: function (x, y) { menus.forRemoteBranch(full, x, y); } };
        }), "gv-ref-item__btn--remote", cur));
      });
      restore(snap);
      applyFilter();
    }

    // ---- Filter box --------------------------------------------------------------------------
    // Case-insensitive substring match on the full name, so "origin/" narrows to one remote and
    // "chore" to every chore/… branch. HEAD and All branches stay; folders without a match hide
    // and folders with one open — and go back to how the user had them once the filter is cleared.

    var filterInput = document.getElementById("branch-filter");
    var filterQuery = "";
    var openBeforeFilter = null; // folder title → open, taken when a filter starts

    function folderTitle(d) {
      var s = d.querySelector("summary");
      return s ? s.textContent : "";
    }

    function applyFilter() {
      if (!rootEl) return;
      var q = filterQuery.trim().toLowerCase();
      var folders = rootEl.querySelectorAll("details.gv-ref-folder");
      var anyMatch = false;
      Array.prototype.forEach.call(folders, function (d) {
        var hits = 0;
        Array.prototype.forEach.call(d.querySelectorAll(".gv-ref-item"), function (li) {
          var btn = li.querySelector("[data-rev]");
          var name = btn ? btn.getAttribute("data-rev").toLowerCase() : "";
          var show = !q || name.indexOf(q) >= 0;
          li.hidden = !show;
          if (show) hits++;
        });
        d.hidden = !!q && hits === 0;
        if (q && hits) d.open = true;
        if (hits) anyMatch = true;
      });
      var empty = rootEl.querySelector(".gv-ref-filter-empty");
      if (q && !anyMatch) {
        if (!empty) {
          empty = u.el("div", "gv-ref-filter-empty");
          empty.setAttribute("role", "status");
          rootEl.appendChild(empty);
        }
        empty.textContent = (UI.branchFilterNoMatch || "No branch matches “{0}”").replace("{0}", filterQuery.trim());
      } else if (empty) {
        empty.parentNode.removeChild(empty);
      }
    }

    function setFilter(value) {
      var was = filterQuery.trim();
      filterQuery = value;
      if (!was && value.trim()) {
        openBeforeFilter = {};
        Array.prototype.forEach.call(rootEl.querySelectorAll("details.gv-ref-folder"), function (d) {
          openBeforeFilter[folderTitle(d)] = d.open;
        });
      }
      applyFilter();
      if (was && !value.trim() && openBeforeFilter) {
        Array.prototype.forEach.call(rootEl.querySelectorAll("details.gv-ref-folder"), function (d) {
          var t = folderTitle(d);
          if (Object.prototype.hasOwnProperty.call(openBeforeFilter, t)) d.open = openBeforeFilter[t];
        });
        openBeforeFilter = null;
      }
    }

    if (filterInput) {
      filterInput.addEventListener("input", function () { setFilter(filterInput.value); });
      filterInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape" && filterInput.value) {
          ev.preventDefault();
          filterInput.value = "";
          setFilter("");
        } else if (ev.key === "ArrowDown") {
          var first = rootEl.querySelector(".gv-ref-item:not([hidden]) [data-rev]");
          if (first) {
            ev.preventDefault();
            first.focus();
          }
        }
      });
    }

    return { render: render };
  };
})(window.GV = window.GV || {});
