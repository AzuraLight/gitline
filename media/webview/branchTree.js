// Left sidebar: HEAD row, local branches, one folder per remote. Clicking a ref shows its history.
(function (GV) {
  "use strict";
  var u = GV.util;

  GV.createBranchTree = function (app, menus) {
    var UI = app.UI;
    var S = app.state;
    var rootEl = document.getElementById("branch-tree-root");

    function remoteGroupTitle(remote) {
      return (UI.branchGroupRemote || "Remote: {0}").replace("{0}", remote);
    }

    function selectRev(rev) {
      S.selectedRev = rev;
      app.saveState();
      app.requestGraph();
    }

    function refButton(classExtra, rev, labelText, current) {
      var btn = u.el("button", "gv-ref-item__btn " + (classExtra || ""));
      btn.type = "button";
      btn.setAttribute("data-rev", rev);
      btn.setAttribute("role", "treeitem");
      btn.title = rev;
      btn.appendChild(u.el("span", "gv-ref-item__label", labelText));
      if (current && current === rev && current !== "HEAD") {
        btn.classList.add("gv-ref-item__btn--current");
        btn.appendChild(u.el("span", "gv-ref-badge", "✓"));
      }
      if ((S.selectedRev || "") === rev) btn.classList.add("gv-ref-item__btn--selected");
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectRev(rev);
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
      if (!S.selectedRev) btn.classList.add("gv-ref-item__btn--selected");
      btn.addEventListener("click", function () { selectRev(""); });
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

    function render(tree) {
      if (!rootEl || !tree) return;
      rootEl.textContent = "";
      var cur = tree.current || "";
      rootEl.appendChild(headRow());
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
    }

    return { render: render };
  };
})(window.GV = window.GV || {});
